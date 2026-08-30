/**
 * Renders the same shader through BOTH engines and diffs the result.
 *
 * This is the tool the parallel migration is for. Every TSL pass has a GLSL twin, and the only way
 * to know a port is faithful is to run them side by side on identical input — reading the node
 * graph and believing it is how a wrong port ships. Twice in this codebase a plausible change was
 * measured after the fact and turned out to do nothing at all, so parity is checked before a pass
 * is called done, not after.
 *
 * Both engines draw a full-screen ramp so every input value is covered by some pixel, and the
 * comparison is over the whole frame rather than a sampled subset.
 *
 *   node scripts/tsl-parity.mjs
 *
 * EVERY GLSL REFERENCE HERE MUST BE TRANSCRIBED FROM `shaders.ts`, NEVER WRITTEN FROM THE PORT.
 *
 * That sounds obvious and is the one mistake this file actually made. `studioGradient` was copied
 * from the TSL version rather than the shipping shader, so the case compared the port against
 * itself and reported a clean match while the two engines were computing different functions — a
 * neutral 0.55-to-1.02 ramp in the renderer against a blue 0.05-to-0.9 one in the port. It cost
 * every metal in the library its correct reflection, and the harness said nothing, because a test
 * whose expectation is derived from the implementation can only ever pass.
 *
 * Renaming a parameter or turning a uniform into an argument is fine and unavoidable — the harness
 * cannot pull in the whole shader. Retyping the BODY from memory is not.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const THREE_BUILD = resolve("node_modules/.pnpm/three@0.185.1/node_modules/three/build");
const DIST = resolve("packages/core/dist");
if (!existsSync(resolve(DIST, "renderer/shaders.js"))) {
  throw new Error("build the package first: pnpm --filter @materials3d/core build");
}

const server = createServer(async (q, r) => {
  const name = (q.url ?? "/").split("?")[0];
  const from = name.startsWith("/dist/")
    ? resolve(DIST, name.slice(6))
    : resolve(THREE_BUILD, name.slice(1));
  if (name.endsWith(".js")) {
    try {
      let code = await readFile(from, "utf8");
      // The dist chunks import three by bare specifier; point them at the served builds.
      code = code
        .replace(/from\s*["']three\/webgpu["']/g, 'from "/three.webgpu.js"')
        .replace(/from\s*["']three["']/g, 'from "/three.module.js"');
      return r.writeHead(200, { "content-type": "text/javascript" }).end(code);
    } catch (e) {
      return r.writeHead(404).end(String(e));
    }
  }
  r.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><meta charset=utf-8><style>html,body{margin:0}</style>`,
  );
});
await new Promise((d) => server.listen(0, "127.0.0.1", d));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
page.on("pageerror", (e) => console.error("PAGE:", e.message.slice(0, 240)));
// Shader compile failures arrive as console errors, not exceptions — and a failed GLSL reference
// renders black, which looks exactly like a broken TSL port.
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE:", m.text().slice(0, 600));
});
await page.goto(url);

const DUMP = process.env.DUMP ?? "";
const results = await page.evaluate(
  async ([base, dumpCase]) => {
    // Bracket notation, not a dangling identifier: the name is deliberately unlikely to collide, and
    // the linter reads `globalThis.__x` as a style violation rather than as the sentinel it is.
    globalThis["__dumpCase"] = dumpCase;
    const GL = await import(base + "three.module.js");
    const GPU = await import(base + "three.webgpu.js");
    const TSL = GPU.TSL;
    const nodes = await import(base + "dist/renderer/nodes/index.js");

    const SIZE = 256;
    const TEX = 128;
    /** Structure at several scales — a bright spot, a thin diagonal and fine speckle — so a box
     *  filter, a soft-knee threshold and a wide blur each have something to get wrong. */
    const pixels = new Uint8Array(TEX * TEX * 4);
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        const i = (y * TEX + x) * 4;
        const spot = Math.exp(-((x - 40) ** 2 + (y - 46) ** 2) / 220) * 255;
        const diagonal = Math.abs(x - y) < 1.5 ? 210 : 0;
        const speckle = ((x * 7 + y * 13) % 17) * 6;
        pixels[i] = Math.min(255, spot + diagonal);
        pixels[i + 1] = Math.min(255, spot * 0.6 + speckle);
        pixels[i + 2] = Math.min(255, diagonal * 0.8 + speckle * 0.7);
        pixels[i + 3] = 255;
      }
    }
    const makeTexture = (T) => {
      const t = new T.DataTexture(pixels.slice(), TEX, TEX);
      t.needsUpdate = true;
      t.minFilter = T.LinearFilter;
      t.magFilter = T.LinearFilter;
      t.wrapS = T.ClampToEdgeWrapping;
      t.wrapT = T.ClampToEdgeWrapping;
      t.colorSpace = T.NoColorSpace;
      return t;
    };
    const glTex = makeTexture(GL);
    const gpuTex = makeTexture(GPU);
    // Two more, shifted, so a three-input composite cannot pass by reading the same data thrice.
    const shift = (n) => {
      const out = pixels.slice();
      for (let i = 0; i < out.length; i += 4) {
        out[i] = (out[i] + n * 37) % 256;
        out[i + 1] = (out[i + 1] + n * 91) % 256;
        out[i + 2] = (out[i + 2] + n * 53) % 256;
      }
      return out;
    };
    const makeShifted = (T, n) => {
      const t = new T.DataTexture(shift(n), TEX, TEX);
      t.needsUpdate = true;
      t.minFilter = T.LinearFilter;
      t.magFilter = T.LinearFilter;
      t.colorSpace = T.NoColorSpace;
      return t;
    };
    const glTex1 = makeShifted(GL, 1),
      glTex2 = makeShifted(GL, 2);
    const gpuTex1 = makeShifted(GPU, 1),
      gpuTex2 = makeShifted(GPU, 2);
    /** Depth as the two-channel encoding the depth passes write, so the DOF gather sees real data. */
    const depthPixels = new Uint8Array(TEX * TEX * 4);
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        const i = (y * TEX + x) * 4;
        const d = 0.15 + 0.55 * (x / TEX) + 0.2 * Math.sin(y * 0.11);
        depthPixels[i] = Math.floor(d * 255);
        depthPixels[i + 1] = Math.floor(((d * 255) % 1) * 255);
        depthPixels[i + 3] = 255;
      }
    }
    const makeDepth = (T) => {
      const t = new T.DataTexture(depthPixels.slice(), TEX, TEX);
      t.needsUpdate = true;
      t.minFilter = T.NearestFilter;
      t.magFilter = T.NearestFilter;
      t.colorSpace = T.NoColorSpace;
      return t;
    };
    const glDepth = makeDepth(GL),
      gpuDepth = makeDepth(GPU);
    const TEXEL = [1 / TEX, 1 / TEX];
    /** A ramp that sweeps 0..2 across x and varies the channels down y, so the whole domain of a
     *  tone curve — including the over-range part that matters most — lands on some pixel. */
    const RAMP = `
    vec3 rampColor(vec2 p){
      return vec3(p.x * 2.0, p.x * 2.0 * (0.35 + 0.65 * p.y), p.x * 2.0 * (1.0 - 0.7 * p.y));
    }`;

    // ---- GLSL side -----------------------------------------------------------
    const glCanvas = document.createElement("canvas");
    const glRenderer = new GL.WebGLRenderer({ canvas: glCanvas, antialias: false });
    glRenderer.setSize(SIZE, SIZE, false);
    // Pinned on BOTH engines. The node renderer applies output colour management that a raw
    // ShaderMaterial on the WebGL renderer does not, so leaving the defaults makes every pass differ
    // for a reason that has nothing to do with the shader being compared.
    glRenderer.outputColorSpace = GL.LinearSRGBColorSpace;
    glRenderer.toneMapping = GL.NoToneMapping;
    const glScene = new GL.Scene();
    const glCam = new GL.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const glQuad = new GL.Mesh(new GL.PlaneGeometry(2, 2), new GL.MeshBasicMaterial());
    glScene.add(glQuad);

    const glslPass = (body, uniforms = {}) =>
      new GL.ShaderMaterial({
        uniforms: {
          tSrc: { value: glTex },
          uTexel: { value: new GL.Vector2(...TEXEL) },
          ...uniforms,
        },
        vertexShader: `varying vec2 vUvIn; void main(){ vUvIn = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader:
          `precision highp float; varying vec2 vUvIn;\nuniform sampler2D tSrc;\nuniform vec2 uTexel;\n` +
          `${RAMP}\n${body}`,
        depthTest: false,
      });

    // ---- TSL side ------------------------------------------------------------
    const gpuCanvas = document.createElement("canvas");
    const gpuRenderer = new GPU.WebGPURenderer({
      canvas: gpuCanvas,
      antialias: false,
      forceWebGL: true,
    });
    gpuRenderer.setSize(SIZE, SIZE, false);
    gpuRenderer.outputColorSpace = GPU.LinearSRGBColorSpace;
    gpuRenderer.toneMapping = GPU.NoToneMapping;
    await gpuRenderer.init();
    const gpuScene = new GPU.Scene();
    const gpuCam = new GPU.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const gpuQuad = new GPU.Mesh(new GPU.PlaneGeometry(2, 2), new GPU.NodeMaterial());
    gpuScene.add(gpuQuad);

    const ramp = TSL.Fn(() => {
      const p = TSL.uv();
      const x = p.x.mul(2);
      return TSL.vec3(x, x.mul(p.y.mul(0.65).add(0.35)), x.mul(TSL.float(1).sub(p.y.mul(0.7))));
    });

    const read = (canvas) => {
      const c = document.createElement("canvas");
      c.width = SIZE;
      c.height = SIZE;
      c.getContext("2d").drawImage(canvas, 0, 0);
      return c.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
    };

    // Each case pairs a GLSL body with the TSL node meant to be identical to it.
    const cases = {
      passthrough: {
        glsl: `void main(){ gl_FragColor = vec4(rampColor(vUvIn), 1.0); }`,
        tsl: () => TSL.vec4(ramp(), 1),
      },
      tonemapAces: {
        glsl: `
        vec3 tonemapAces(vec3 v){
          vec3 c = max(v, vec3(0.0));
          c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
          return clamp(c, 0.0, 1.0);
        }
        void main(){ gl_FragColor = vec4(tonemapAces(rampColor(vUvIn)), 1.0); }`,
        tsl: () => TSL.vec4(nodes.tonemapAces(ramp()), 1),
      },
      linearToSrgb: {
        glsl: `
        vec3 linearToSrgb3(vec3 c){
          vec3 v = max(c, vec3(0.0));
          return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
        }
        void main(){ gl_FragColor = vec4(linearToSrgb3(clamp(rampColor(vUvIn), 0.0, 1.0)), 1.0); }`,
        tsl: () => TSL.vec4(nodes.linearToSrgb(ramp().clamp(0, 1)), 1),
      },
      srgbToLinear: {
        glsl: `
        vec3 srgbToLinear3(vec3 c){
          vec3 v = max(c, vec3(0.0));
          vec3 clamped = min(v, vec3(1.0));
          vec3 lo = mix(clamped / 12.92, pow((clamped + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), clamped));
          return mix(lo, v, step(vec3(1.0), v));
        }
        void main(){ gl_FragColor = vec4(clamp(srgbToLinear3(rampColor(vUvIn)), 0.0, 1.0), 1.0); }`,
        tsl: () => TSL.vec4(nodes.srgbToLinear(ramp()).clamp(0, 1), 1),
      },
      studioGradient: {
        glsl: `
        vec3 studioGradient(vec3 rd){
          float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
          return mix(vec3(0.55), vec3(1.02), smoothstep(0.20, 0.88, t));
        }
        void main(){
          vec3 rd = normalize(vec3(vUvIn * 2.0 - 1.0, 0.6));
          gl_FragColor = vec4(studioGradient(rd), 1.0);
        }`,
        tsl: () => {
          const rd = TSL.normalize(TSL.vec3(TSL.uv().mul(2).sub(1), 0.6));
          return TSL.vec4(nodes.studioGradient(rd), 1);
        },
      },
      valueNoise: {
        glsl: `
        float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float valueNoise(vec2 p){
          vec2 i = floor(p); vec2 f = fract(p);
          vec2 w = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), w.x),
                     mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), w.x), w.y);
        }
        void main(){ gl_FragColor = vec4(vec3(valueNoise(vUvIn * 9.0)), 1.0); }`,
        tsl: () => TSL.vec4(TSL.vec3(nodes.valueNoise(TSL.uv().mul(9))), 1),
      },
    };

    // ---- the bloom chain -----------------------------------------------------
    const passes = await import(base + "dist/renderer/nodes/index.js");

    cases.blit = {
      glsl: `void main(){ gl_FragColor = texture2D(tSrc, vUvIn); }`,
      tsl: () => passes.blitPass(gpuTex),
    };
    cases.bloomExtract = {
      glsl: `
      uniform float uThreshold;
      void main(){
        vec2 o = uTexel * 0.5;
        vec3 c = max((texture2D(tSrc, vUvIn + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUvIn + vec2(o.x, -o.y)).rgb
          + texture2D(tSrc, vUvIn + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUvIn + vec2(o.x, o.y)).rgb) * 0.25, vec3(0.0));
        float b = max(max(c.r, c.g), c.b);
        float t = max(uThreshold, 0.0);
        float knee = max(t * 0.5, 0.0001);
        float soft = clamp(b - t + knee, 0.0, 2.0 * knee);
        soft = soft * soft / (4.0 * knee + 0.0001);
        gl_FragColor = vec4(c * (max(b - t, soft) / max(b, 0.0001)), 1.0);
      }`,
      glslUniforms: { uThreshold: { value: 0.35 } },
      tsl: () => passes.bloomExtractPass(gpuTex, TSL.float(0.35), TSL.vec2(...TEXEL)),
    };
    cases.bloomDown = {
      glsl: `
      void main(){
        vec2 o = uTexel * 0.5;
        vec3 c = texture2D(tSrc, vUvIn + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUvIn + vec2(o.x, -o.y)).rgb
          + texture2D(tSrc, vUvIn + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUvIn + vec2(o.x, o.y)).rgb;
        gl_FragColor = vec4(max(c * 0.25, vec3(0.0)), 1.0);
      }`,
      tsl: () => passes.bloomDownPass(gpuTex, TSL.vec2(...TEXEL)),
    };
    cases.bloomBlur = {
      glsl: `
      #define BLOOM_TAPS 10
      uniform float uSigma; uniform vec2 uDir;
      void main(){
        float total = 1.0;
        vec3 acc = texture2D(tSrc, vUvIn).rgb;
        for (int i = 1; i < BLOOM_TAPS; i += 2){
          float a = float(i); float b = float(i + 1);
          float wa = exp(-0.5 * a * a / (uSigma * uSigma));
          float wb = i + 1 < BLOOM_TAPS ? exp(-0.5 * b * b / (uSigma * uSigma)) : 0.0;
          float w = wa + wb;
          vec2 off = uDir * uTexel * ((a * wa + b * wb) / w);
          acc += (texture2D(tSrc, vUvIn + off).rgb + texture2D(tSrc, vUvIn - off).rgb) * w;
          total += 2.0 * w;
        }
        gl_FragColor = vec4(max(acc / total, vec3(0.0)), 1.0);
      }`,
      glslUniforms: { uSigma: { value: 10 / 3 }, uDir: { value: new GL.Vector2(1, 0) } },
      tsl: () =>
        passes.bloomBlurPass(gpuTex, 10, TSL.float(10 / 3), TSL.vec2(1, 0), TSL.vec2(...TEXEL)),
    };
    cases.particleDown = {
      glsl: `
      vec3 srgbToLinear3(vec3 c){
        vec3 v = max(c, vec3(0.0));
        vec3 cl = min(v, vec3(1.0));
        vec3 lo = mix(cl / 12.92, pow((cl + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), cl));
        return mix(lo, v, step(vec3(1.0), v));
      }
      void main(){
        vec3 c = vec3(0.0);
        for (int y = 0; y < 8; y++){
          for (int x = 0; x < 8; x++){
            vec2 grid = vec2(float(x), float(y)) - vec2(3.5);
            c += srgbToLinear3(texture2D(tSrc, vUvIn + grid * 0.125 * vec2(4.0) * uTexel).rgb);
          }
        }
        gl_FragColor = vec4(max(c / 64.0, vec3(0.0)), 1.0);
      }`,
      tsl: () => passes.particleDownPass(gpuTex, TSL.vec2(...TEXEL), TSL.vec2(4, 4)),
    };

    // Both were missing before, and both use `select` — which is exactly where the argument-order
    // bug hid. A helper with no parity case is a helper nobody has checked.
    cases.tonemapNeutral = {
      glsl: `
      vec3 tonemapNeutral(vec3 v){
        vec3 c = max(v, vec3(0.0));
        const float START = 0.76; const float DESAT = 0.15;
        float lo = min(c.r, min(c.g, c.b));
        float offset = lo < 0.08 ? lo - 6.25 * lo * lo : 0.04;
        c -= vec3(offset);
        float peak = max(c.r, max(c.g, c.b));
        if (peak < START) return c;
        float d = 1.0 - START;
        float newPeak = 1.0 - d * d / (peak + d - START);
        c *= newPeak / max(peak, 0.0001);
        float amount = 1.0 - 1.0 / (DESAT * (peak - newPeak) + 1.0);
        return mix(c, vec3(newPeak), amount);
      }
      void main(){ gl_FragColor = vec4(tonemapNeutral(rampColor(vUvIn)), 1.0); }`,
      tsl: () => TSL.vec4(nodes.tonemapNeutral(ramp()), 1),
    };
    cases.studioSoftbox = {
      glsl: `
      vec3 srgbToLinear3(vec3 c){
        vec3 v = max(c, vec3(0.0));
        vec3 cl = min(v, vec3(1.0));
        vec3 lo = mix(cl / 12.92, pow((cl + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), cl));
        return mix(lo, v, step(vec3(1.0), v));
      }
      float panelMask(vec3 dir, vec3 fwd, vec2 size, float feather){
        vec3 f = normalize(fwd);
        vec3 helper = abs(f.y) > 0.92 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
        vec3 right = normalize(cross(helper, f));
        vec3 up = cross(f, right);
        float facing = dot(dir, f);
        if (facing <= 0.01) return 0.0;
        float lx = abs(dot(dir, right) / facing);
        float ly = abs(dot(dir, up) / facing);
        return (1.0 - smoothstep(size.x, size.x + feather, lx))
             * (1.0 - smoothstep(size.y, size.y + feather, ly));
      }
      void main(){
        vec3 d = normalize(vec3(vUvIn * 2.0 - 1.0, 0.6));
        float fb = 1.0 - smoothstep(-0.22, -0.02, d.y);
        vec3 room = mix(vec3(0.00025, 0.0003, 0.0004), vec3(0.0016, 0.0017, 0.0019), fb);
        vec3 back = panelMask(d, vec3(-0.82, 0.08, 0.57), vec2(1.35, 1.1), 0.22) * vec3(0.82, 0.84, 0.88) * 0.011;
        vec3 fill = panelMask(d, vec3(0.0, -0.707, 0.707), vec2(0.38, 0.62), 0.18) * vec3(1.0, 0.97, 0.91) * 0.22;
        vec3 key  = panelMask(d, vec3(0.612, 0.354, 0.707), vec2(0.5, 0.16), 0.035) * vec3(0.76, 0.88, 1.0) * 20.0;
        vec3 total = room + back + fill + key;
        vec3 mapped = total / (vec3(1.0) + total);
        gl_FragColor = vec4(srgbToLinear3(pow(max(mapped, vec3(0.0)), vec3(1.0 / 2.2))), 1.0);
      }`,
      tsl: () => {
        const d = TSL.normalize(TSL.vec3(TSL.uv().mul(2).sub(1), 0.6));
        return TSL.vec4(nodes.studioSoftbox(d), 1);
      },
    };

    // The room switch, the bake and one axis of the blur that builds the chain. `sampleEnv` itself
    // is not here: it reads an explicit mip level, and the harness renders single-level textures —
    // a case for it would compare two level-zero fetches and prove nothing.
    cases.envBlur = {
      glsl: `
      uniform vec2 uDir; uniform float uRadius, uCompensate;
      void main(){
        float sinTheta = max(sin(vUvIn.y * 3.141592653589793), 0.15);
        float scale = mix(1.0, 1.0 / sinTheta, uCompensate);
        vec2 stp = uDir * uTexel * uRadius * scale;
        float offsets[3];
        float weights[3];
        offsets[0] = 0.0;          weights[0] = 0.2270270270;
        offsets[1] = 1.3846153846; weights[1] = 0.3162162162;
        offsets[2] = 3.2307692308; weights[2] = 0.0702702703;
        vec4 sum = texture2D(tSrc, vUvIn) * weights[0];
        for (int i = 1; i < 3; i++){
          sum += texture2D(tSrc, vUvIn + stp * offsets[i]) * weights[i];
          sum += texture2D(tSrc, vUvIn - stp * offsets[i]) * weights[i];
        }
        gl_FragColor = sum;
      }`,
      glslUniforms: {
        uDir: { value: new GL.Vector2(1, 0) },
        uRadius: { value: 1.15 },
        uCompensate: { value: 1 },
      },
      tsl: () =>
        passes.envBlurPass(
          TSL.texture(gpuTex),
          TSL.vec2(...TEXEL),
          TSL.vec2(1, 0),
          TSL.float(1.15),
          TSL.float(1),
        ),
    };

    // The vertical axis, which runs UNCOMPENSATED — the sin(theta) correction is for rows covering
    // different solid angles, and applying it down the columns pulls the poles apart.
    cases.envBlurVertical = {
      glsl: cases.envBlur.glsl,
      glslUniforms: {
        uDir: { value: new GL.Vector2(0, 1) },
        uRadius: { value: 1.15 },
        uCompensate: { value: 0 },
      },
      tsl: () =>
        passes.envBlurPass(
          TSL.texture(gpuTex),
          TSL.vec2(...TEXEL),
          TSL.vec2(0, 1),
          TSL.float(1.15),
          TSL.float(0),
        ),
    };

    cases.bloomComposite = {
      glsl: `
      uniform sampler2D tL0, tL1, tL2; uniform float uRadius;
      void main(){
        float r = clamp(uRadius, 0.0, 1.0);
        float w0 = mix(1.0, 0.55, r), w1 = 0.8, w2 = mix(0.55, 1.0, r);
        vec3 c = texture2D(tL0, vUvIn).rgb * w0 + texture2D(tL1, vUvIn).rgb * w1
               + texture2D(tL2, vUvIn).rgb * w2;
        gl_FragColor = vec4(max(c / max(w0 + w1 + w2, 0.0001), vec3(0.0)), 1.0);
      }`,
      glslUniforms: {
        tL0: { value: glTex },
        tL1: { value: glTex1 },
        tL2: { value: glTex2 },
        uRadius: { value: 0.35 },
      },
      tsl: () => passes.bloomCompositePass(gpuTex, gpuTex1, gpuTex2, TSL.float(0.35)),
    };

    // ---- the post pass -------------------------------------------------------
    // Only the parts that are pure functions of the inputs: DOF gather, bloom mix, caustics, haze,
    // vignette and the tone map. Grain is excluded because it keys off a time uniform, and a
    // hash of it is not a meaningful parity target.
    const post = await import(base + "dist/renderer/nodes/post.js");
    const POST_CONST = { far: 60, dofTaps: 8, causticTaps: 6 };
    cases.post = {
      glsl: `
      #define DOF_TAPS 8
      #define CAUSTIC_TAPS 6
      uniform sampler2D tColor, tDepth, tBloom;
      uniform vec2 uRes, uMirror; uniform vec3 uHazeCol;
      uniform float uFocus, uRange, uAperture, uBloom, uCaustics, uHaze, uHazeTop, uVignette;
      uniform float uScale, uTransparent, uBloomRadius, uBloomThresh, uToneMap, uBloomMode;
      const float FAR = 60.0;
      const float TAPS = float(DOF_TAPS);
      const float GOLDEN_ANGLE = 2.39996323;
      float dec(vec2 e){ return e.x + e.y / 255.0; }
      float sat(vec3 c){ return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
      vec3 tonemapNeutral(vec3 v){
        vec3 c = max(v, vec3(0.0));
        const float START = 0.76; const float DESAT = 0.15;
        float lo = min(c.r, min(c.g, c.b));
        float offset = lo < 0.08 ? lo - 6.25 * lo * lo : 0.04;
        c -= vec3(offset);
        float peak = max(c.r, max(c.g, c.b));
        if (peak < START) return c;
        float d = 1.0 - START;
        float newPeak = 1.0 - d * d / (peak + d - START);
        c *= newPeak / max(peak, 0.0001);
        float amount = 1.0 - 1.0 / (DESAT * (peak - newPeak) + 1.0);
        return mix(c, vec3(newPeak), amount);
      }
      vec3 tonemapAces(vec3 v){
        vec3 c = max(v, vec3(0.0));
        c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
        return clamp(c, 0.0, 1.0);
      }
      void main(){
        vec2 vUv = mix(vUvIn, vec2(1.0) - vUvIn, step(0.5, uMirror));
        float dC = dec(texture2D(tDepth, vUv).rg) * FAR;
        float r0 = pow(clamp(abs(dC - uFocus) / uRange, 0.0, 1.0), 1.2) * uAperture * uScale;
        vec4 sum = texture2D(tColor, vUv);
        float wsum = 1.0;
        vec3 glow = vec3(0.0);
        for (int k = 0; k < DOF_TAPS; k++){
          float fi = float(k) + 1.0;
          float a = fi * GOLDEN_ANGLE;
          vec2 dir = vec2(cos(a), sin(a));
          float rad = sqrt(fi / TAPS) * r0;
          vec2 uv2 = vUv + dir * rad / uRes;
          float d2 = dec(texture2D(tDepth, uv2).rg) * FAR;
          float r2 = clamp(abs(d2 - uFocus) / uRange, 0.0, 1.0) * uAperture * uScale;
          float w = (d2 < dC - 0.4) ? smoothstep(0.0, rad + 0.001, r2) : 1.0;
          sum += texture2D(tColor, uv2) * w;
          wsum += w;
          vec3 g = texture2D(tColor, vUv + dir * (sqrt(fi / TAPS) * uBloomRadius * uScale) / uRes).rgb;
          glow += g * max(sat(g) - uBloomThresh, 0.0);
        }
        vec4 acc = sum / wsum;
        float alphaIn = acc.a;
        vec3 straight = acc.rgb / max(alphaIn, 1e-4);
        vec3 bloom = uBloomMode > 0.5 ? texture2D(tBloom, vUv).rgb * uBloom : (glow / TAPS) * uBloom;
        vec3 col = straight + bloom;
        float alpha = min(1.0, alphaIn + max(max(bloom.r, bloom.g), bloom.b));
        vec3 caus = vec3(0.0);
        for (int k = 0; k < CAUSTIC_TAPS; k++){
          float o = (float(k) + 1.0) / float(CAUSTIC_TAPS);
          vec3 c = texture2D(tColor, vUv + vec2(sin(o * 9.0) * 0.012, o * 0.20)).rgb;
          caus += c * sat(c) * (1.0 - o);
        }
        vec3 pool = (caus / float(CAUSTIC_TAPS)) * smoothstep(0.46, 0.0, vUv.y) * uCaustics * 3.2;
        col += pool;
        alpha = min(1.0, alpha + max(max(pool.r, pool.g), pool.b));
        float haze = smoothstep(uHazeTop, -0.02, vUv.y) * uHaze;
        col = mix(col, uHazeCol, haze);
        alpha *= 1.0 - haze * uTransparent;
        vec2 q = vUv - 0.5;
        col *= 1.0 - dot(q, q) * uVignette;
        if (uToneMap > 1.5) col = tonemapAces(col);
        else if (uToneMap > 0.5) col = tonemapNeutral(col);
        gl_FragColor = vec4(col * alpha, alpha);
      }`,
      glslUniforms: {
        tColor: { value: glTex },
        tDepth: { value: glDepth },
        tBloom: { value: glTex1 },
        uRes: { value: new GL.Vector2(SIZE, SIZE) },
        uMirror: { value: new GL.Vector2(0, 0) },
        uHazeCol: { value: new GL.Vector3(0.7, 0.75, 0.85) },
        uFocus: { value: 12 },
        uRange: { value: 9 },
        uAperture: { value: 1.4 },
        uScale: { value: 1 },
        uBloom: { value: 0.6 },
        uBloomMode: { value: 0 },
        uBloomRadius: { value: 5 },
        uBloomThresh: { value: 0.12 },
        uCaustics: { value: 0.5 },
        uHaze: { value: 0.3 },
        uHazeTop: { value: 0.4 },
        uVignette: { value: 0.25 },
        uTransparent: { value: 0 },
        uToneMap: { value: 1 },
      },
      tsl: () =>
        post.postPass({
          color: gpuTex,
          depth: gpuDepth,
          bloom: gpuTex1,
          res: TSL.vec2(SIZE, SIZE),
          mirror: TSL.vec2(0, 0),
          hazeColor: TSL.vec3(0.7, 0.75, 0.85),
          focus: TSL.float(12),
          range: TSL.float(9),
          aperture: TSL.float(1.4),
          scale: TSL.float(1),
          bloomAmount: TSL.float(0.6),
          bloomMode: TSL.float(0),
          bloomRadius: TSL.float(5),
          bloomThresh: TSL.float(0.12),
          caustics: TSL.float(0.5),
          haze: TSL.float(0.3),
          hazeTop: TSL.float(0.4),
          vignette: TSL.float(0.25),
          transparent: TSL.float(0),
          grain: TSL.float(0),
          time: TSL.float(0),
          toneMap: TSL.float(1),
          ...POST_CONST,
        }),
    };

    cases.postDofOnly = {
      glsl: cases.post.glsl,
      glslUniforms: {
        ...cases.post.glslUniforms,
        uBloom: { value: 0 },
        uCaustics: { value: 0 },
        uHaze: { value: 0 },
        uVignette: { value: 0 },
        uToneMap: { value: 0 },
      },
      tsl: () =>
        post.postPass({
          color: gpuTex,
          depth: gpuDepth,
          bloom: gpuTex1,
          res: TSL.vec2(SIZE, SIZE),
          mirror: TSL.vec2(0, 0),
          hazeColor: TSL.vec3(0.7, 0.75, 0.85),
          focus: TSL.float(12),
          range: TSL.float(9),
          aperture: TSL.float(1.4),
          scale: TSL.float(1),
          bloomAmount: TSL.float(0),
          bloomMode: TSL.float(0),
          bloomRadius: TSL.float(5),
          bloomThresh: TSL.float(0.12),
          caustics: TSL.float(0),
          haze: TSL.float(0),
          hazeTop: TSL.float(0.4),
          vignette: TSL.float(0),
          transparent: TSL.float(0),
          grain: TSL.float(0),
          time: TSL.float(0),
          toneMap: TSL.float(0),
          ...POST_CONST,
        }),
    };

    // Aperture 0 collapses the gather to its centre tap: if this matches, the loop is at fault; if
    // it does not, the setup before the loop is.
    cases.postNoGather = {
      glsl: cases.post.glsl,
      glslUniforms: {
        ...cases.post.glslUniforms,
        uAperture: { value: 0 },
        uBloom: { value: 0 },
        uCaustics: { value: 0 },
        uHaze: { value: 0 },
        uVignette: { value: 0 },
        uToneMap: { value: 0 },
      },
      tsl: () =>
        post.postPass({
          color: gpuTex,
          depth: gpuDepth,
          bloom: gpuTex1,
          res: TSL.vec2(SIZE, SIZE),
          mirror: TSL.vec2(0, 0),
          hazeColor: TSL.vec3(0.7, 0.75, 0.85),
          focus: TSL.float(12),
          range: TSL.float(9),
          aperture: TSL.float(0),
          scale: TSL.float(1),
          bloomAmount: TSL.float(0),
          bloomMode: TSL.float(0),
          bloomRadius: TSL.float(5),
          bloomThresh: TSL.float(0.12),
          caustics: TSL.float(0),
          haze: TSL.float(0),
          hazeTop: TSL.float(0.4),
          vignette: TSL.float(0),
          transparent: TSL.float(0),
          grain: TSL.float(0),
          time: TSL.float(0),
          toneMap: TSL.float(0),
          ...POST_CONST,
        }),
    };

    // Rebuild the post pass's opening in-line, one step at a time, to find where it goes to zero.
    const mirror = TSL.vec2(0, 0);
    const probes = {
      probeUv: () => {
        const vUv = TSL.mix(TSL.uv(), TSL.vec2(1).sub(TSL.uv()), mirror.step(0.5));
        return TSL.vec4(vUv, 0, 1);
      },
      probeSample: () => {
        const vUv = TSL.mix(TSL.uv(), TSL.vec2(1).sub(TSL.uv()), mirror.step(0.5));
        return TSL.texture(gpuTex, vUv);
      },
      probeAlpha: () => {
        const sum = TSL.texture(gpuTex, TSL.uv()).toVar();
        const wsum = TSL.float(1).toVar();
        const acc = sum.div(wsum);
        return TSL.vec4(TSL.vec3(acc.a), 1);
      },
    };
    for (const [name, build] of Object.entries(probes)) {
      cases[name] = {
        glsl:
          name === "probeUv"
            ? `void main(){ gl_FragColor = vec4(vUvIn, 0.0, 1.0); }`
            : name === "probeSample"
              ? `void main(){ gl_FragColor = texture2D(tSrc, vUvIn); }`
              : `void main(){ gl_FragColor = vec4(vec3(texture2D(tSrc, vUvIn).a), 1.0); }`,
        tsl: build,
      };
    }

    probes.probeSelect = () => {
      const c = TSL.texture(gpuTex, TSL.uv()).rgb;
      const mode = TSL.float(0);
      const picked = TSL.select(mode.greaterThan(0.5), c.mul(0.25), c);
      return TSL.vec4(picked, 1);
    };
    probes.probeToVarLoop = () => {
      const sum = TSL.texture(gpuTex, TSL.uv()).toVar();
      const wsum = TSL.float(1).toVar();
      for (let k = 0; k < 4; k++) {
        const w = TSL.float(1);
        sum.addAssign(TSL.texture(gpuTex, TSL.uv()).mul(w));
        wsum.addAssign(w);
      }
      const acc = sum.div(wsum);
      return TSL.vec4(acc.rgb.div(acc.a.max(1e-4)), 1);
    };
    probes.probeAssign = () => {
      const col = TSL.texture(gpuTex, TSL.uv()).rgb.toVar();
      const alpha = TSL.float(1).toVar();
      col.assign(TSL.mix(col, TSL.vec3(0.5), TSL.float(0)));
      alpha.mulAssign(TSL.float(1));
      return TSL.vec4(col.mul(alpha), alpha);
    };
    for (const [name, build] of Object.entries(probes)) {
      if (cases[name]) continue;
      cases[name] = {
        glsl: `void main(){ gl_FragColor = vec4(texture2D(tSrc, vUvIn).rgb, 1.0); }`,
        tsl: build,
      };
    }

    // ---- the glass foundations ----------------------------------------------
    const glassNodes = await import(base + "dist/renderer/nodes/glass.js");
    const LAMPS = [
      [0.28, 0.62, 0.22, 1.0],
      [0.55, 0.38, 0.17, 0.8],
      [0.79, 0.7, 0.13, 1.3],
    ];
    const LAMP_COLS = [
      [0.37, 0.53, 0.92],
      [0.61, 0.44, 0.88],
      [0.94, 0.5, 0.23],
    ];
    cases.plate = {
      glsl: `
      uniform vec4 uLamp[8]; uniform vec3 uLampCol[8];
      uniform int uLampCount; uniform float uLampGain, uLampLo, uLampHi;
      vec4 plate(vec2 p){
        vec3 c = vec3(0.0); float a = 0.0;
        for (int i = 0; i < 8; i++){
          if (i >= uLampCount) break;
          vec2 d = p - uLamp[i].xy;
          float w = exp(-dot(d, d) / max(uLamp[i].z * uLamp[i].z, 1e-6)) * uLamp[i].w;
          c += uLampCol[i] * w;
          a += w;
        }
        float amt = 1.0 - exp(-a * uLampGain);
        amt = smoothstep(uLampLo, uLampHi, amt);
        return vec4(c / max(a, 1e-4), amt);
      }
      void main(){ vec4 v = plate(vUvIn); gl_FragColor = vec4(v.rgb * v.a, 1.0); }`,
      glslUniforms: {
        uLamp: {
          value: [...LAMPS, ...Array.from({ length: 5 }, () => [0, 0, 1, 0])].map(
            (l) => new GL.Vector4(...l),
          ),
        },
        uLampCol: {
          value: [...LAMP_COLS, ...Array.from({ length: 5 }, () => [0, 0, 0])].map(
            (c) => new GL.Vector3(...c),
          ),
        },
        uLampCount: { value: 3 },
        uLampGain: { value: 1.35 },
        uLampLo: { value: 0.05 },
        uLampHi: { value: 0.95 },
      },
      tsl: () => {
        const plate = glassNodes.platePass({
          lamps: TSL.uniformArray(LAMPS.map((l) => new GPU.Vector4(...l))),
          colors: TSL.uniformArray(LAMP_COLS.map((c) => new GPU.Vector3(...c))),
          count: TSL.uniform(3, "int"),
          gain: TSL.float(1.35),
          lo: TSL.float(0.05),
          hi: TSL.float(0.95),
          maxLamps: 8,
        });
        const v = plate(TSL.uv());
        return TSL.vec4(v.rgb.mul(v.a), 1);
      },
    };

    const PLANES = [
      [1, 0, 0, -0.3],
      [-1, 0, 0, -0.3],
      [0, 1, 0, -0.25],
      [0, -1, 0, -0.25],
      [0, 0, 1, -0.2],
      [0, 0, -1, -0.2],
    ];
    cases.prismExit = {
      glsl: `
      uniform vec4 uPrismPlanes[6]; uniform int uPrismPlaneCount;
      float prismExit(vec3 ro, vec3 rd){
        float nearest = 1e9;
        for (int i = 0; i < 6; i++){
          if (i >= uPrismPlaneCount) break;
          vec4 pl = uPrismPlanes[i];
          float denom = dot(rd, pl.xyz);
          if (denom <= 1e-5) continue;
          float t = -(dot(ro, pl.xyz) + pl.w) / denom;
          if (t > 1e-4 && t < nearest) nearest = t;
        }
        return nearest > 1e8 ? 0.0 : nearest;
      }
      void main(){
        vec3 ro = vec3(vUvIn * 0.4 - 0.2, 0.0);
        vec3 rd = normalize(vec3(vUvIn * 2.0 - 1.0, -0.7));
        gl_FragColor = vec4(vec3(prismExit(ro, rd) * 1.6), 1.0);
      }`,
      glslUniforms: {
        uPrismPlanes: { value: PLANES.map((p) => new GL.Vector4(...p)) },
        uPrismPlaneCount: { value: 6 },
      },
      tsl: () => {
        const walk = glassNodes.prismExit(
          TSL.uniformArray(PLANES.map((p) => new GPU.Vector4(...p))),
          TSL.uniform(6, "int"),
        );
        const ro = TSL.vec3(TSL.uv().mul(0.4).sub(0.2), 0);
        const rd = TSL.normalize(TSL.vec3(TSL.uv().mul(2).sub(1), -0.7));
        return TSL.vec4(TSL.vec3(walk(ro, rd).mul(1.6)), 1);
      },
    };

    // The back-glass walk: four bounces of total internal reflection against the same plane set,
    // which is the most intricate control flow ported so far.
    cases.backGlass = {
      glsl: `
      uniform vec4 uPrismPlanes[6]; uniform int uPrismPlaneCount;
      uniform float uIOR, uBackStrength;
      float prismExitN(vec3 ro, vec3 rd, out vec3 outN){
        float nearest = 1e9;
        outN = vec3(0.0, 0.0, 1.0);
        for (int i = 0; i < 6; i++){
          if (i >= uPrismPlaneCount) break;
          vec4 pl = uPrismPlanes[i];
          float denom = dot(rd, pl.xyz);
          if (denom <= 1e-5) continue;
          float t = -(dot(ro, pl.xyz) + pl.w) / denom;
          if (t > 1e-4 && t < nearest){ nearest = t; outN = pl.xyz; }
        }
        return nearest > 1e8 ? 0.0 : nearest;
      }
      float dielectricFresnel(float ior, float facing){
        float f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
        float m = 1.0 - clamp(facing, 0.0, 1.0);
        float m2 = m * m;
        return f0 + (1.0 - f0) * m2 * m2 * m;
      }
      vec3 room(vec3 rd){
        float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
        return mix(vec3(0.55), vec3(1.02), smoothstep(0.20, 0.88, t));
      }
      void main(){
        vec3 wp = vec3(vUvIn * 0.34 - 0.17, 0.05);
        vec3 wn = normalize(vec3(vUvIn * 2.0 - 1.0, 0.55));
        vec3 cam = vec3(0.0, 0.0, 2.0);
        vec3 V = normalize(cam - wp);
        vec3 incident = -V;
        vec3 outward = normalize(wn);
        float facing = clamp(dot(-incident, outward), 0.0, 1.0);
        float fresnel = dielectricFresnel(uIOR, facing);
        vec3 dir = normalize(reflect(incident, outward));
        vec3 pos = wp; float escaped = 0.0; vec3 lastN = outward;
        for (int b = 0; b < 4; b++){
          vec3 faceN;
          float t = prismExitN(pos + dir * 2e-4, dir, faceN);
          if (t <= 0.0) break;
          pos = pos + dir * (t + 2e-4);
          lastN = faceN;
          vec3 refracted = refract(dir, -faceN, uIOR);
          if (dot(refracted, refracted) > 1e-6){ dir = normalize(refracted); escaped = 1.0; break; }
          dir = reflect(dir, faceN);
        }
        float exitFacing = clamp(dot(dir, lastN), 0.0, 1.0);
        float transmission = escaped > 0.5 ? (1.0 - dielectricFresnel(uIOR, exitFacing)) : 0.0;
        gl_FragColor = vec4(room(dir) * uBackStrength * fresnel * transmission, 1.0);
      }`,
      glslUniforms: {
        uPrismPlanes: { value: PLANES.map((p) => new GL.Vector4(...p)) },
        uPrismPlaneCount: { value: 6 },
        uIOR: { value: 1.5 },
        uBackStrength: { value: 2.0 },
      },
      tsl: () => {
        const pass = glassNodes.backGlassPass({
          planes: TSL.uniformArray(PLANES.map((p) => new GPU.Vector4(...p))),
          planeCount: TSL.uniform(6, "int"),
          ior: TSL.float(1.5),
          strength: TSL.float(2.0),
          plateDepth: TSL.float(1),
          room: (d) => nodes.studioGradient(d),
          bounces: 4,
        });
        const wp = TSL.vec3(TSL.uv().mul(0.34).sub(0.17), 0.05);
        const wn = TSL.normalize(TSL.vec3(TSL.uv().mul(2).sub(1), 0.55));
        return TSL.vec4(pass(wp, wn, TSL.vec3(0, 0, 2)).rgb, 1);
      },
    };

    // ---- the microfacet layer -----------------------------------------------
    // uv.x sweeps the angle term and uv.y the roughness, so one frame covers the whole domain of
    // every curve rather than a single material's worth of it.
    const brdf = await import(base + "dist/renderer/nodes/brdf.js");
    const BRDF_PRELUDE = `
    const float G3_PI = 3.14159265359;
    const float F82_SCHLICK_BAR = 0.46266437;
    const float F82_DENOM = 0.05665278;
    float D_GGX(float NoH, float a){
      float a2 = a * a;
      float f = (NoH * a2 - NoH) * NoH + 1.0;
      return a2 / (G3_PI * f * f);
    }
    float V_SmithGGXCorrelated(float NoV, float NoL, float a){
      float a2 = a * a;
      float GGXL = NoV * sqrt((-NoL * a2 + NoL) * NoL + a2);
      float GGXV = NoL * sqrt((-NoV * a2 + NoV) * NoV + a2);
      return 0.5 / max(GGXV + GGXL, 1e-5);
    }
    vec3 F_Schlick(vec3 f0, float u){ return f0 + (vec3(1.0) - f0) * pow(1.0 - u, 5.0); }
    vec3 F_82(vec3 f0, vec3 edge, float u){
      vec3 fs = F_Schlick(f0, u);
      vec3 fsBar = f0 + (vec3(1.0) - f0) * F82_SCHLICK_BAR;
      float k = u * pow(1.0 - u, 6.0) / F82_DENOM;
      return max(fs - k * (fsBar - edge), vec3(0.0));
    }
    vec3 thinFilm(float ndv, float ior, float film, float irid){
      float s2 = (1.0 - ndv * ndv) / (ior * ior);
      float cosT = sqrt(max(1.0 - s2, 0.0));
      vec3 phase = 6.2831853 * (2.0 * ior * film * cosT) / vec3(650.0, 550.0, 440.0);
      return mix(vec3(1.0), 0.5 + 0.5 * cos(phase), irid);
    }`;
    const F0 = [0.95, 0.78, 0.42],
      EDGE = [1.0, 0.9, 0.72];
    cases.distributionGGX = {
      glsl: `${BRDF_PRELUDE}
      void main(){
        float d = D_GGX(vUvIn.x, max(vUvIn.y * vUvIn.y, 0.002));
        gl_FragColor = vec4(vec3(d * 0.04), 1.0);
      }`,
      tsl: () =>
        TSL.vec4(
          TSL.vec3(
            brdf.distributionGGX(TSL.uv().x, TSL.uv().y.mul(TSL.uv().y).max(0.002)).mul(0.04),
          ),
          1,
        ),
    };
    cases.visibilitySmith = {
      glsl: `${BRDF_PRELUDE}
      void main(){
        float v = V_SmithGGXCorrelated(max(vUvIn.x, 0.02), max(1.0 - vUvIn.x, 0.02), max(vUvIn.y * vUvIn.y, 0.002));
        gl_FragColor = vec4(vec3(v * 0.5), 1.0);
      }`,
      tsl: () =>
        TSL.vec4(
          TSL.vec3(
            brdf
              .visibilitySmith(
                TSL.uv().x.max(0.02),
                TSL.float(1).sub(TSL.uv().x).max(0.02),
                TSL.uv().y.mul(TSL.uv().y).max(0.002),
              )
              .mul(0.5),
          ),
          1,
        ),
    };
    cases.fresnelF82 = {
      glsl: `${BRDF_PRELUDE}
      void main(){
        gl_FragColor = vec4(F_82(vec3(${F0}), vec3(${EDGE}), vUvIn.x), 1.0);
      }`,
      tsl: () => TSL.vec4(brdf.fresnelF82(TSL.vec3(...F0), TSL.vec3(...EDGE), TSL.uv().x), 1),
    };
    cases.thinFilm = {
      glsl: `${BRDF_PRELUDE}
      void main(){
        gl_FragColor = vec4(thinFilm(vUvIn.x, 1.5, vUvIn.y * 900.0, 0.8), 1.0);
      }`,
      tsl: () =>
        TSL.vec4(brdf.thinFilm(TSL.uv().x, TSL.float(1.5), TSL.uv().y.mul(900), TSL.float(0.8)), 1),
    };

    // The glint field. Footprint is passed in rather than derived from fwidth so both engines see
    // the same value — the derivative itself is checked separately by `derivative` above.
    cases.glitter = {
      glsl: `${BRDF_PRELUDE}
      float hash13(vec3 p){
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      vec3 jitter(vec3 N, vec3 seed, float amount){
        vec3 r = vec3(hash13(seed), hash13(seed + 7.13), hash13(seed + 19.7)) - 0.5;
        return normalize(N + r * amount);
      }
      void main(){
        vec3 wp = vec3(vUvIn * 6.0 - 3.0, 0.35);
        vec3 N = normalize(vec3(0.15, 0.2, 1.0));
        vec3 V = normalize(vec3(0.0, 0.0, 1.0));
        vec3 KEY = normalize(vec3(0.4, 0.7, 0.6));
        float footprint = 0.02;
        float density = min(60.0, 0.85 / max(footprint, 1e-4));
        vec3 cell = floor(wp * density);
        vec3 fN = jitter(N, cell, 0.85);
        vec3 Hs = normalize(V + KEY);
        float facet = D_GGX(max(dot(fN, Hs), 0.0), 0.02);
        float on = step(0.72, hash13(cell + 3.3));
        gl_FragColor = vec4(vec3(facet * on * 1.0 * 0.06), 1.0);
      }`,
      tsl: () => {
        const wp = TSL.vec3(TSL.uv().mul(6).sub(3), 0.35);
        const g = brdf.glitter(
          wp,
          TSL.normalize(TSL.vec3(0.15, 0.2, 1)),
          TSL.normalize(TSL.vec3(0, 0, 1)),
          TSL.normalize(TSL.vec3(0.4, 0.7, 0.6)),
          TSL.float(0.02),
          TSL.float(60),
          TSL.float(1),
        );
        return TSL.vec4(TSL.vec3(g), 1);
      },
    };

    // ---- the opaque path -----------------------------------------------------
    // Swept over view angle and roughness, once per material family, against a plate stand-in both
    // engines evaluate identically.
    const opaque = await import(base + "dist/renderer/nodes/opaque.js");
    const PLATE_STUB_GLSL = `
    vec4 plateStub(vec3 rd){
      float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
      return vec4(mix(vec3(0.2, 0.3, 0.55), vec3(0.95, 0.9, 0.8), t), 0.6);
    }
    vec3 roomStub(vec3 rd){
      float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
      return mix(vec3(0.55), vec3(1.02), smoothstep(0.20, 0.88, t));
    }`;
    const plateStubTsl = (rd) => {
      const t = rd.y.mul(0.5).add(0.5).clamp(0, 1);
      return TSL.vec4(TSL.mix(TSL.vec3(0.2, 0.3, 0.55), TSL.vec3(0.95, 0.9, 0.8), t), 0.6);
    };
    for (const [label, kindValue] of [
      ["Metal", 3.0],
      ["Ceramic", 6.0],
      ["Plastic", 5.0],
    ]) {
      cases["opaque" + label] = {
        glsl: `${BRDF_PRELUDE}
        ${PLATE_STUB_GLSL}
        void main(){
          vec3 N = normalize(vec3(vUvIn * 2.0 - 1.0, 0.85));
          vec3 V = normalize(vec3(0.1, 0.05, 1.0));
          float ndv = clamp(dot(N, V), 0.0, 1.0);
          float uRough = max(vUvIn.y, 0.03);
          float uKind = ${kindValue.toFixed(1)};   // .toFixed: GLSL ES 1.00 has no int->float coercion
          vec3 uAlbedo = vec3(0.94, 0.77, 0.42);
          vec3 uEdge = vec3(1.0, 0.9, 0.72);
          float uUseEdge = 1.0, uSpec = 1.2, uRim = 0.8, uEnvOn = 0.0;
          vec3 L = normalize(vec3(-0.45, 0.55, 0.70));
          vec3 H = normalize(V + L);
          float NoV = max(ndv, 1e-4), NoL = max(dot(N, L), 0.0);
          float NoH = max(dot(N, H), 0.0), LoH = max(dot(L, H), 0.0);
          float a = uRough * uRough;
          bool metal = uKind < 4.5;
          vec3 f0 = metal ? uAlbedo : vec3(0.04);
          float D = D_GGX(NoH, a);
          float Vis = V_SmithGGXCorrelated(NoV, NoL, a);
          bool edged = metal && uUseEdge > 0.5;
          vec3 F = edged ? F_82(f0, uEdge, LoH) : F_Schlick(f0, LoH);
          vec3 direct = D * Vis * F * NoL;
          direct = direct / (1.0 + direct);
          vec3 R = reflect(-V, N);
          vec4 env = plateStub(R);
          vec4 behind = plateStub(-N);
          vec3 fill = mix(vec3(0.92), behind.rgb, behind.a * 0.6);
          float coneFade = uEnvOn > 0.5 ? uRough * 0.18 : uRough * 0.75;
          vec3 envCol = mix(mix(roomStub(R), env.rgb, env.a), fill, coneFade);
          vec3 Fenv = edged ? F_82(f0, uEdge, NoV) : F_Schlick(f0, NoV);
          vec3 col;
          if (metal){ col = envCol * Fenv + direct * uSpec; }
          else {
            float wrapped = uKind > 5.5 ? NoL : pow(NoL * 0.5 + 0.5, 1.7);
            vec3 kd = (vec3(1.0) - Fenv) * uAlbedo;
            col = kd * (fill * 0.42 + wrapped * 0.82) + direct * uSpec + envCol * Fenv;
          }
          col = col + fill * pow(1.0 - ndv, 3.0) * uRim * 1.6;
          gl_FragColor = vec4(col, 1.0);
        }`,
        tsl: () => {
          const N = TSL.normalize(TSL.vec3(TSL.uv().mul(2).sub(1), 0.85));
          const V = TSL.normalize(TSL.vec3(0.1, 0.05, 1));
          const ndv = N.dot(V).clamp(0, 1);
          return TSL.vec4(
            opaque.shadeOpaque({
              kind: TSL.float(kindValue),
              albedo: TSL.vec3(0.94, 0.77, 0.42),
              edgeTint: TSL.vec3(1.0, 0.9, 0.72),
              useEdge: TSL.float(1),
              roughness: TSL.uv().y.max(0.03),
              spec: TSL.float(1.2),
              rim: TSL.float(0.8),
              envOn: TSL.float(0),
              room: (dir) => nodes.studioGradient(dir),
              plate: plateStubTsl,
            })(N, V, ndv),
            1,
          );
        },
      };
    }

    cases.preludeProbe = {
      glsl: `${BRDF_PRELUDE}
      ${PLATE_STUB_GLSL}
      void main(){ gl_FragColor = vec4(plateStub(vec3(vUvIn, 1.0)).rgb, 1.0); }`,
      tsl: () => TSL.vec4(plateStubTsl(TSL.vec3(TSL.uv(), 1)).rgb, 1),
    };

    // ---- the transmissive path ----------------------------------------------
    const trans = await import(base + "dist/renderer/nodes/transmissive.js");
    const TRANS_PRELUDE = `
    vec3 bendDir(vec3 V, vec3 N, float eta){
      float cosI = clamp(dot(N, V), -1.0, 1.0);
      float k = 1.0 - eta * eta * (1.0 - cosI * cosI);
      if (k < 0.0) return reflect(-V, N);
      return -V * eta + N * (eta * cosI - sqrt(max(k, 0.0)));
    }
    float coneRotation(vec2 pixel){
      return fract(sin(dot(floor(pixel), vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
    }
    vec3 coneDirection(vec3 dir, float i, float radius, float rotation, float samples){
      vec3 axis = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
      vec3 tangent = normalize(cross(axis, dir));
      vec3 bitangent = cross(dir, tangent);
      float r = sqrt((i + 0.5) / samples);
      float a = i * 2.39996323 + rotation;
      return normalize(dir + (cos(a) * tangent + sin(a) * bitangent) * r * radius);
    }
    vec3 spectralWeight(float t){
      return vec3(
        exp(-pow((t - 0.05) / 0.45, 2.0)),
        exp(-pow((t - 0.50) / 0.38, 2.0)),
        exp(-pow((t - 0.95) / 0.45, 2.0)));
    }`;
    cases.bendDir = {
      glsl: `${TRANS_PRELUDE}
      void main(){
        vec3 V = normalize(vec3(0.1, 0.0, 1.0));
        vec3 N = normalize(vec3(vUvIn * 2.0 - 1.0, 0.7));
        gl_FragColor = vec4(bendDir(V, N, 0.5 + vUvIn.y) * 0.5 + 0.5, 1.0);
      }`,
      tsl: () => {
        const V = TSL.normalize(TSL.vec3(0.1, 0, 1));
        const N = TSL.normalize(TSL.vec3(TSL.uv().mul(2).sub(1), 0.7));
        return TSL.vec4(trans.bendDir(V, N, TSL.uv().y.add(0.5)).mul(0.5).add(0.5), 1);
      },
    };
    cases.spectralWeight = {
      glsl: `${TRANS_PRELUDE}
      void main(){ gl_FragColor = vec4(spectralWeight(vUvIn.x), 1.0); }`,
      tsl: () => TSL.vec4(trans.spectralWeight(TSL.uv().x), 1),
    };
    cases.coneDirection = {
      glsl: `${TRANS_PRELUDE}
      void main(){
        vec3 d = normalize(vec3(vUvIn * 2.0 - 1.0, 1.2));
        float rot = coneRotation(vUvIn * 128.0);
        vec3 c = coneDirection(d, 4.0, 0.25, rot, 11.0);
        gl_FragColor = vec4(c * 0.5 + 0.5, 1.0);
      }`,
      tsl: () => {
        const d = TSL.normalize(TSL.vec3(TSL.uv().mul(2).sub(1), 1.2));
        const rot = trans.coneRotation(TSL.uv().mul(128));
        const spread = trans.coneDirection(11);
        return TSL.vec4(spread(d, TSL.float(4), TSL.float(0.25), rot).mul(0.5).add(0.5), 1);
      },
    };
    cases.rotateHue = {
      glsl: `
      void main(){
        vec3 lit = rampColor(vUvIn) * 0.5;
        float ha = vUvIn.y * 6.2831853;
        vec3 k = vec3(0.57735027);
        vec3 r = max(lit * cos(ha) + cross(k, lit) * sin(ha) + k * dot(k, lit) * (1.0 - cos(ha)), 0.0);
        gl_FragColor = vec4(r, 1.0);
      }`,
      tsl: () => TSL.vec4(trans.rotateHue(ramp().mul(0.5), TSL.uv().y), 1),
    };
    cases.transmittedHue = {
      glsl: `
      void main(){
        vec3 lit = rampColor(vUvIn) * 0.5;
        vec3 hue = lit / max(max(lit.r, max(lit.g, lit.b)), 0.001);
        gl_FragColor = vec4(mix(lit, hue, 0.55), 1.0);
      }`,
      tsl: () => TSL.vec4(trans.transmittedHue(ramp().mul(0.5)), 1),
    };
    cases.coneTransmission = {
      glsl: `${TRANS_PRELUDE}
      ${PLATE_STUB_GLSL}
      void main(){
        vec3 V = normalize(vec3(0.1, 0.05, 1.0));
        vec3 N = normalize(vec3(vUvIn * 2.0 - 1.0, 0.8));
        float e0 = 1.0 / 1.5;
        float rotation = coneRotation(gl_FragCoord.xy);
        float radius = 0.4 * 0.4 * 0.18;
        vec3 spectrum = vec3(0.0); vec3 weightSum = vec3(0.0); float cover = 0.0;
        for (int i = 0; i < 11; i++){
          float t = (float(i) + 0.5) / 11.0;
          vec3 base = bendDir(V, N, e0 + (t - 0.5) * 2.0 * 0.06);
          vec4 p = plateStub(coneDirection(base, float(i), radius, rotation, 11.0));
          vec3 w = spectralWeight(t);
          spectrum += p.rgb * w; weightSum += w; cover += p.a;
        }
        gl_FragColor = vec4(spectrum / max(weightSum, vec3(1e-4)) * (cover / 11.0), 1.0);
      }`,
      tsl: () => {
        const V = TSL.normalize(TSL.vec3(0.1, 0.05, 1));
        const N = TSL.normalize(TSL.vec3(TSL.uv().mul(2).sub(1), 0.8));
        const cone = trans.coneTransmission({
          samples: 11,
          ior: TSL.float(1.5),
          dispersion: TSL.float(0.06),
          roughness: TSL.float(0.4),
          plate: plateStubTsl,
        });
        const r = cone(V, N, TSL.screenCoordinate);
        return TSL.vec4(r.rgb.mul(r.a), 1);
      },
    };

    // ---- the light-sheet materials ------------------------------------------
    const beamNodes = await import(base + "dist/renderer/nodes/beam.js");
    cases.beam = {
      glsl: `
      void main(){
        vec3 vCol = vec3(0.9, 0.75, 0.55);
        float vProfile = vUvIn.x * 2.0 - 1.0;
        float vTravel = vUvIn.y;
        float uEdgeFalloff = 16.0, uFalloffRate = 3.8, uFalloffPower = 3.7, uIntensity = 1.0;
        float r = abs(vProfile);
        float radial = exp(-uEdgeFalloff * r * r) * (1.0 - smoothstep(0.55, 1.0, r));
        float longitudinal = 1.0 / pow(1.0 + max(uFalloffRate, 0.0) * max(vTravel, 0.0),
                                       max(uFalloffPower, 0.0001));
        gl_FragColor = vec4(vCol * radial * longitudinal * uIntensity, 1.0);
      }`,
      // Reveal pinned to 1 so the branch is the settled one; the feather uses a derivative, which is
      // checked on its own by `derivative`.
      tsl: () => {
        const pass = beamNodes.beamPass({
          intensity: TSL.float(1),
          edgeFalloff: TSL.float(16),
          falloffRate: TSL.float(3.8),
          falloffPower: TSL.float(3.7),
          reveal: TSL.float(1),
        });
        return TSL.vec4(
          pass(TSL.vec3(0.9, 0.75, 0.55), TSL.uv().x.mul(2).sub(1), TSL.uv().y).rgb,
          1,
        );
      },
    };
    cases.dust = {
      glsl: `
      vec3 linearToSrgb3(vec3 c){
        vec3 v = max(c, vec3(0.0));
        return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
      }
      vec3 srgbToLinear3(vec3 c){
        vec3 v = max(c, vec3(0.0));
        vec3 cl = min(v, vec3(1.0));
        vec3 lo = mix(cl / 12.92, pow((cl + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), cl));
        return mix(lo, v, step(vec3(1.0), v));
      }
      vec3 tonemapAces(vec3 v){
        vec3 c = max(v, vec3(0.0));
        c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
        return clamp(c, 0.0, 1.0);
      }
      void main(){
        vec2 vCorner = vUvIn * 2.0 - 1.0;
        float vSoft = 0.4, vSparkle = 1.2, vOpacity = 0.9;
        float uResponse = 82.0, uFalloffPower = 5.5, uExposure = 0.72, uIntensity = 1.0;
        float r2 = dot(vCorner, vCorner);
        vec3 colorLight = srgbToLinear3(max(texture2D(tSrc, vUvIn).rgb, vec3(0.0)));
        vec3 light = max(texture2D(tSrc, vUvIn).rgb, vec3(0.0));
        float brightness = max(max(light.r, light.g), light.b);
        float illumination = pow(clamp(1.0 - exp(-brightness * uResponse), 0.0, 1.0), uFalloffPower);
        float edgeFade = 1.0 - smoothstep(0.62, 1.0, r2);
        float core = exp(-r2 * mix(6.5, 1.8, vSoft));
        float halo = exp(-r2 * 1.25) * vSoft * 0.2;
        float radial = (core + halo) * edgeFade;
        float colorBrightness = max(max(colorLight.r, colorLight.g), colorLight.b);
        vec3 hueSource = colorBrightness > 1e-7 ? colorLight : light;
        float hueBrightness = max(max(hueSource.r, hueSource.g), hueSource.b);
        vec3 lightColor = linearToSrgb3(clamp(hueSource / max(hueBrightness, 1e-6), 0.0, 1.0));
        float energy = illumination * radial * vSparkle * uExposure * uIntensity;
        float displayEnergy = linearToSrgb3(tonemapAces(vec3(energy))).r;
        gl_FragColor = vec4(lightColor * displayEnergy * vOpacity, 1.0);
      }`,
      tsl: () => {
        const pass = beamNodes.dustPass({
          intensity: TSL.float(1),
          response: TSL.float(82),
          falloffPower: TSL.float(5.5),
          exposure: TSL.float(0.72),
          light: (p) => TSL.texture(gpuTex, p),
          color: (p) => TSL.texture(gpuTex, p),
          linearToSrgb: (c) => nodes.linearToSrgb(c),
          srgbToLinear: (c) => nodes.srgbToLinear(c),
          tonemapAces: (c) => nodes.tonemapAces(c),
        });
        return TSL.vec4(
          pass(TSL.uv().mul(2).sub(1), TSL.uv(), TSL.float(0.4), TSL.float(1.2), TSL.float(0.9))
            .rgb,
          1,
        );
      },
    };

    // ---- the caustic, the backdrop and the finish pass ------------------------
    // Every GLSL body below is transcribed from `shaders.ts`; see the rule at the top of the file.
    const backdropNodes = await import(base + "dist/renderer/nodes/backdrop.js");
    const finishNodes = await import(base + "dist/renderer/nodes/finish.js");

    const NOISE_PRELUDE = `
      float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float valueNoise(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
                   mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
      }`;

    cases.caustic = {
      glsl:
        NOISE_PRELUDE +
        `
      void main(){
        vec3 vCol = vec3(0.9, 0.75, 0.55);
        float vProfile = vUvIn.x * 2.0 - 1.0;
        float vTravel = vUvIn.y;
        float vWave = 1.0;
        vec2 vWorld = vUvIn * 4.0 - 2.0;
        float uEdgeFalloff = 16.0, uFalloffRate = 3.8, uFalloffPower = 3.7;
        float uStrength = 1.9, uCoverage = 0.86, uFarDesat = 0.04, uFarBright = 0.02;
        float uTravelScale = 1.0, uRateScale = 0.12, uPowerScale = 0.5;
        float uNormalInfluence = 1.0, uNormalElevation = 35.0;
        float uWallScale = 1.0 / 2.4, uWallNormal = 0.22;
        vec2 uBeamDir = vec2(1.0, 0.0);

        float r = abs(vProfile);
        float radial = exp(-uEdgeFalloff * r * r) * (1.0 - smoothstep(0.55, 1.0, r));
        float distance = clamp(vTravel / max(uTravelScale, 0.001), 0.0, 1.0);
        float outgoing = 1.0 / pow(
          1.0 + max(uFalloffRate, 0.0) * max(uRateScale, 0.0) * max(vTravel, 0.0),
          max(uFalloffPower * max(uPowerScale, 0.0), 0.0001));

        float e = 0.02;
        float m0 = valueNoise(vWorld * uWallScale * 3.7);
        float mx = valueNoise((vWorld + vec2(e, 0.0)) * uWallScale * 3.7);
        float my = valueNoise((vWorld + vec2(0.0, e)) * uWallScale * 3.7);
        vec3 N = normalize(vec3((m0 - mx) * uWallNormal, (m0 - my) * uWallNormal, 1.0));
        float elev = clamp(uNormalElevation, 1.0, 89.0) * 0.01745329252;
        vec3 incident = normalize(vec3(normalize(uBeamDir) * cos(elev), sin(elev)));
        float flat0 = max(incident.z, 0.05);
        float relative = clamp(max(dot(N, incident), 0.0) / flat0, 0.0, 2.5);
        float surface = mix(1.0, relative, clamp(uNormalInfluence, 0.0, 1.0));

        float energy = max(max(vCol.r, max(vCol.g, vCol.b)), 0.0) * radial * outgoing;
        float bounded = 1.0 - exp(-energy * max(uStrength, 0.0));
        float farMix = smoothstep(0.16, 0.92, distance) * uFarDesat;
        vec3 spectral = vCol;
        vec3 neutral = vec3(max(max(spectral.r, spectral.g), spectral.b) + uFarBright * distance);
        vec3 tint = clamp(mix(spectral, neutral, farMix) * (0.62 + bounded * 0.68), 0.0, 1.45);
        float coverage = clamp(bounded * uCoverage, 0.0, 1.0);
        gl_FragColor = vec4(tint * coverage * surface * step(0.0, vWave), 1.0);
      }`,
      tsl: () => {
        const pass = beamNodes.causticPass({
          edgeFalloff: TSL.float(16),
          falloffRate: TSL.float(3.8),
          falloffPower: TSL.float(3.7),
          strength: TSL.float(1.9),
          coverage: TSL.float(0.86),
          farDesat: TSL.float(0.04),
          farBright: TSL.float(0.02),
          travelScale: TSL.float(1),
          rateScale: TSL.float(0.12),
          powerScale: TSL.float(0.5),
          normalInfluence: TSL.float(1),
          normalElevation: TSL.float(35),
          wallScale: TSL.float(1 / 2.4),
          wallNormal: TSL.float(0.22),
          beamDir: TSL.vec2(1, 0),
        });
        return TSL.vec4(
          pass(
            TSL.vec3(0.9, 0.75, 0.55),
            TSL.uv().x.mul(2).sub(1),
            TSL.uv().y,
            TSL.float(1),
            TSL.uv().mul(4).sub(2),
          ).rgb,
          1,
        );
      },
    };

    cases.shadowContrastCurve = {
      glsl: `
      float shadowContrastCurve(float v, float contrast, float pivot){
        float p = clamp(pivot, 0.001, 0.999);
        float k = max(contrast, 0.001);
        return v < p ? p * pow(v / p, k) : 1.0 - (1.0 - p) * pow((1.0 - v) / (1.0 - p), k);
      }
      void main(){
        gl_FragColor = vec4(vec3(shadowContrastCurve(vUvIn.x, 1.0 + vUvIn.y * 8.0, 0.9)), 1.0);
      }`,
      tsl: () =>
        TSL.vec4(
          TSL.vec3(
            backdropNodes.shadowContrastCurve(TSL.uv().x, TSL.uv().y.mul(8).add(1), TSL.float(0.9)),
          ),
          1,
        ),
    };

    cases.softInside = {
      glsl: `
      float softInside(float distance, float amplitude){
        float edge = max(amplitude * 0.5, 0.0001);
        return 1.0 - smoothstep(-edge, edge, distance);
      }
      void main(){
        gl_FragColor = vec4(vec3(softInside(vUvIn.x * 2.0 - 1.0, vUvIn.y * 1.6)), 1.0);
      }`,
      tsl: () =>
        TSL.vec4(
          TSL.vec3(backdropNodes.softInside(TSL.uv().x.mul(2).sub(1), TSL.uv().y.mul(1.6))),
          1,
        ),
    };

    cases.dotScreen = {
      glsl: `
      float dotScreen(vec2 coord, float value, float angle, float cell){
        float ca = cos(angle), sa = sin(angle);
        vec2 r = mat2(ca, sa, -sa, ca) * coord;
        vec2 c = fract(r / max(cell, 2.0)) - 0.5;
        float radius = sqrt(clamp(value, 0.0, 1.0)) * 0.5;
        return smoothstep(radius, radius - 0.06, length(c));
      }
      void main(){
        gl_FragColor = vec4(vec3(dotScreen(vUvIn * 64.0, vUvIn.x, 1.309, 6.0)), 1.0);
      }`,
      tsl: () =>
        TSL.vec4(
          TSL.vec3(
            finishNodes.dotScreen(TSL.uv().mul(64), TSL.uv().x, TSL.float(1.309), TSL.float(6)),
          ),
          1,
        ),
    };

    cases.bayer = {
      glsl: `
      const int bayer8x8[64] = int[64](
        0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
        12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
        3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
        15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21
      );
      float bayer(vec2 uv){
        ivec2 pos = ivec2(fract(uv / 8.0) * 8.0);
        return float(bayer8x8[pos.y * 8 + pos.x]) / 64.0;
      }
      void main(){ gl_FragColor = vec4(vec3(bayer(vUvIn * 32.0)), 1.0); }`,
      tsl: () => TSL.vec4(TSL.vec3(finishNodes.bayer(TSL.uv().mul(32))), 1),
    };

    const out = [];
    for (const [name, def] of Object.entries(cases)) {
      try {
        glQuad.material = glslPass(def.glsl, def.glslUniforms);
        glRenderer.render(glScene, glCam);
        const a = read(glCanvas);

        const mat = new GPU.NodeMaterial();
        mat.fragmentNode = def.tsl();
        mat.depthTest = false;
        gpuQuad.material = mat;
        await gpuRenderer.renderAsync(gpuScene, gpuCam);
        const b = read(gpuCanvas);

        let worst = 0;
        let over1 = 0;
        let over4 = 0;
        for (let i = 0; i < a.length; i += 4) {
          for (let k = 0; k < 3; k++) {
            const d = Math.abs(a[i + k] - b[i + k]);
            if (d > worst) worst = d;
            if (d > 1) over1++;
            if (d > 4) over4++;
          }
        }
        const wanted = name === (globalThis["__dumpCase"] ?? "");
        out.push({
          name,
          worst,
          over1,
          over4,
          samples: (a.length / 4) * 3,
          ...(wanted ? { glPng: glCanvas.toDataURL(), gpuPng: gpuCanvas.toDataURL() } : {}),
        });
      } catch (e) {
        out.push({ name, error: String(e.message).slice(0, 140) });
      }
    }
    return out;
  },
  [url, DUMP],
);

let failed = 0;
for (const r of results) {
  if (r.error) {
    console.log(`  ${r.name.padEnd(16)} ERROR ${r.error}`);
    failed++;
    continue;
  }
  // One level of 8-bit quantisation is the floor for two independently compiled shaders; anything
  // beyond that is a real difference in the maths.
  const ok = r.worst <= 1;
  if (!ok) failed++;
  console.log(
    `  ${r.name.padEnd(16)} ${ok ? "match" : "DIFFER"}  worst ${String(r.worst).padStart(3)}/255` +
      `  >1: ${r.over1}  >4: ${r.over4}  of ${r.samples}`,
  );
}
for (const r of results) {
  if (!r.glPng) continue;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`/tmp/parity-${r.name}-glsl.png`, Buffer.from(r.glPng.split(",")[1], "base64"));
  await writeFile(`/tmp/parity-${r.name}-tsl.png`, Buffer.from(r.gpuPng.split(",")[1], "base64"));
  console.log(`  dumped /tmp/parity-${r.name}-{glsl,tsl}.png`);
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
