/**
 * Feasibility spike for a TSL migration: does three's node renderer, driven by TSL, run in the
 * same headless Chromium our render and regression pipeline depends on, and can it express the
 * constructs our existing GLSL actually uses?
 *
 * Run with `node scripts/tsl-feasibility.mjs`.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BUILD = resolve("node_modules/.pnpm/three@0.185.1/node_modules/three/build");
const server = createServer(async (q, r) => {
  const name = (q.url ?? "/").split("?")[0];
  if (name.endsWith(".js")) {
    try {
      const code = await readFile(resolve(BUILD, name.slice(1)), "utf8");
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
page.on("pageerror", (e) => console.error("PAGE:", e.message.slice(0, 200)));
await page.goto(url);
console.log(
  await page.evaluate(async (base) => {
    const THREE = await import(base + "three.webgpu.js");
    // The TSL bound to the SAME module instance as the renderer. A separate `three/tsl` import is
    // a different node registry, and every node then fails its weak-map lookup at render time.
    const TSL = THREE.TSL;
    const out = [];
    const renderer = new THREE.WebGPURenderer({ forceWebGL: true, antialias: true });
    renderer.setSize(256, 256);
    await renderer.init();
    out.push("backend: " + (renderer.backend?.constructor?.name ?? "?"));
    document.body.appendChild(renderer.domElement);

    // A texture to sample, with mips, standing in for the environment chain.
    const data = new Uint8Array(64 * 64 * 4).map((_, i) => (i * 7) % 251);
    const tex = new THREE.DataTexture(data, 64, 64);
    tex.needsUpdate = true;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;

    const scale = TSL.uniform(3.0);
    const planes = TSL.uniformArray([
      new THREE.Vector4(1, 0, 0, -0.2),
      new THREE.Vector4(0, 1, 0, -0.2),
      new THREE.Vector4(-1, 0, 0, -0.2),
    ]);
    const count = TSL.uniform(3, "int");

    const stages = {
      constant: () => TSL.vec4(0.2, 0.4, 0.6, 1),
      uv: () => TSL.vec4(TSL.uv().x, TSL.uv().y, 0, 1),
      uniform: () => TSL.vec4(TSL.uv().x.mul(scale).fract(), 0.3, 0, 1),
      derivative: () => TSL.vec4(TSL.dFdx(TSL.uv().x).abs().mul(200), 0.2, 0, 1),
      loop: () => {
        const acc = TSL.float(0).toVar();
        TSL.Loop(4, () => acc.addAssign(TSL.uv().x.mul(0.25)));
        return TSL.vec4(acc, 0.1, 0, 1);
      },
      fn: () => TSL.Fn(() => TSL.vec4(TSL.uv().y, 0.5, 0.1, 1))(),
      // The constructs the harder shaders actually need.
      texture: () => TSL.texture(tex, TSL.uv()),
      textureLod: () => TSL.texture(tex, TSL.uv()).level(TSL.float(2.0)),
      "array+loop": () => {
        // GLASS_FRAG walks `uPrismPlanes[6]` against a dynamic count.
        const acc = TSL.float(0).toVar();
        TSL.Loop(count, ({ i }) => {
          const pl = planes.element(i);
          acc.addAssign(pl.xyz.dot(TSL.vec3(TSL.uv(), 0)).add(pl.w).max(0));
        });
        return TSL.vec4(acc, 0.2, 0.4, 1);
      },
      // If/Else needs an Fn() scope: outside one the node stack is null and it throws.
      conditional: () =>
        TSL.Fn(() => {
          const c = TSL.float(0).toVar();
          TSL.If(TSL.uv().x.greaterThan(0.5), () => c.assign(1)).Else(() => c.assign(0.2));
          return TSL.vec4(c, 0.3, 0.5, 1);
        })(),
      discard: () =>
        TSL.Fn(() => {
          TSL.uv().x.greaterThan(0.9).discard();
          return TSL.vec4(0.7, 0.2, 0.2, 1);
        })(),
    };

    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.NodeMaterial());
    scene.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    for (const [name, build] of Object.entries(stages)) {
      try {
        const mat = new THREE.NodeMaterial();
        mat.fragmentNode = build();
        quad.material = mat;
        renderer.setRenderTarget(null);
        await renderer.renderAsync(scene, cam);
        // Straight off the canvas, which is how the real harness captures a frame.
        const png = renderer.domElement.toDataURL("image/png");
        out.push(`  ${name.padEnd(12)} rendered, png ${png.length} bytes`);
      } catch (e) {
        out.push(`  ${name.padEnd(12)} THREW ${String(e.message).slice(0, 110)}`);
      }
    }

    // Render targets and MRT, which the four-pass architecture depends on.
    try {
      const target = new THREE.RenderTarget(128, 128, { count: 2 });
      renderer.setRenderTarget(target);
      await renderer.renderAsync(scene, cam);
      renderer.setRenderTarget(null);
      out.push(`  MRT target   ok, textures ${target.textures.length}`);
    } catch (e) {
      out.push(`  MRT target   THREW ${String(e.message).slice(0, 110)}`);
    }
    return out.join("\n");
  }, url),
);
await browser.close();
server.close();
