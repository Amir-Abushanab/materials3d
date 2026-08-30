/**
 * Renders one scene through BOTH engines and diffs the frames.
 *
 *   node scripts/tsl-compare.mjs materials
 *   node scripts/tsl-compare.mjs prism --crop 240,40,160,120
 *   node scripts/tsl-compare.mjs materials --probe base
 *
 * The sibling of `tsl-parity.mjs`, and deliberately not the same tool. Parity compares one PASS at
 * a time on synthetic input, which is what proves a port is arithmetically faithful; this compares
 * whole FRAMES of a real scene, which is what catches the things a pass-level test cannot see —
 * a uniform never written, a pass never called, two correct passes composed in the wrong order.
 *
 * `--probe` substitutes one intermediate of the node engine's glass graph (see `devProbe` in
 * `NodeMaterialRenderer`) so a divergence can be walked back to the term that causes it.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const THREE_BUILD = resolve("node_modules/.pnpm/three@0.185.1/node_modules/three/build");
const DIST = resolve("packages/core/dist");
const BUNDLE = resolve(DIST, "standalone/materials3d.standalone.js");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const scene =
  args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true) ??
  "materials";
const width = Number(flag("width", 640));
const height = Number(flag("height", 380));
const probe = flag("probe", "");
const crop = flag("crop", "");
const outDir = flag("out", "/tmp");
/**
 * Pixels to print side by side, as `x,y;x,y`.
 *
 * Values are reported RAW — byte/255 — because neither engine applies a display transfer at
 * output: the WebGL one writes `gl_FragColor` directly and the node one has its output colour
 * management turned off to match. Decoding these as sRGB is the single most effective way to
 * misread this tool, and it produced several confident wrong conclusions before it was noticed.
 */
const at = flag("at", "");
/** Raw channel triple, as fractions of full scale. */
const fmt = (v) => `(${v.map((n) => (n / 255).toFixed(3)).join(", ")})`;
/** How many frames to render before capturing. Two by default, so a first-frame bake settles. */
const frames = Number(flag("frames", 2));
/**
 * Run the node engine's rAF loop before capturing, instead of only awaited draws.
 *
 * The two are not the same test. `captureImage` awaits each draw; the loop fires them without
 * waiting, so anything `draw` mutates across an `await` can interleave between frames. That is a
 * failure mode this harness could not see until it could start the loop.
 */
const loop = args.includes("--loop");

/** A short filesystem-safe name for a preset name or an inline JSON scene. */
const gl_label = (s) => (s.trim().startsWith("{") ? "scene" : s.replace(/[^a-z0-9_-]/gi, ""));

const server = createServer(async (q, r) => {
  const name = (q.url ?? "/").split("?")[0];
  if (name === "/bundle.js") {
    return r
      .writeHead(200, { "content-type": "text/javascript" })
      .end(await readFile(BUNDLE, "utf8"));
  }
  if (name.endsWith(".js")) {
    const from = name.startsWith("/dist/")
      ? resolve(DIST, name.slice(6))
      : resolve(THREE_BUILD, name.slice(1));
    try {
      const code = (await readFile(from, "utf8"))
        .replace(/from\s*["']three\/webgpu["']/g, 'from "/three.webgpu.js"')
        .replace(/from\s*["']three["']/g, 'from "/three.module.js"');
      return r.writeHead(200, { "content-type": "text/javascript" }).end(code);
    } catch (e) {
      return r.writeHead(404).end(String(e));
    }
  }
  r.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><meta charset=utf-8><style>html,body{margin:0}#host{position:fixed;inset:0}</style><div id=host></div>`,
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });
page.on("pageerror", (e) => console.error("PAGE:", e.message.slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE:", m.text().slice(0, 300));
});
await page.goto(url);

const result = await page.evaluate(
  async ([base, sceneArg, w, h, probeName, cropSpec, label, atSpec, frameCount, runLoop]) => {
    const gl = await import(base + "bundle.js");
    const { NodeMaterialRenderer } = await import(base + "dist/renderer/NodeMaterialRenderer.js");
    const host = document.getElementById("host");
    const cfg = gl.PRESETS[sceneArg] ? gl.PRESETS[sceneArg]() : JSON.parse(sceneArg);

    const region = cropSpec ? cropSpec.split(",").map(Number) : [0, 0, w, h];
    const grab = async (renderer) => {
      const blob = await renderer.captureImage("image/png", 0.92, 0);
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = region[2];
      c.height = region[3];
      c.getContext("2d").drawImage(bitmap, -region[0], -region[1]);
      return c;
    };

    host.replaceChildren();
    // The GLSL twin of the node engine's probe, so both sides can be asked the same question.
    const GLSL_PROBES = [
      "",
      "trans",
      "lit",
      "hue",
      "chord",
      "base",
      "amt",
      "grey",
      "roomR",
      "plateR",
      "plateCover",
      "fill",
      "opaqueGrey",
      "gradR",
      "backZ",
      "viewZ",
      "depthGuard",
      "plateA",
      "guardMargin",
      "offset",
      "alphaOut",
    ];
    globalThis["__glslProbe"] = Math.max(0, GLSL_PROBES.indexOf(probeName));
    const a = new gl.MaterialRenderer(host, cfg, {
      respectReducedMotion: false,
      preserveDrawingBuffer: true,
    });
    a.setOutputSize({ width: w, height: h });
    const glCanvas = await grab(a);
    globalThis["__glslProbe"] = 0;
    a.dispose();

    host.replaceChildren();
    // Set BEFORE construction: the probe is read when the material graph is built.
    globalThis["__tslDebug"] = probeName || undefined;
    const b = new NodeMaterialRenderer(host, cfg, { respectReducedMotion: false });
    b.setOutputSize({ width: w, height: h });
    // Two frames. The first may bake the room and rebuild the item materials; the second is drawn
    // through the finished state, which is what a consumer actually sees.
    for (let i = 1; i < frameCount; i++) await b.captureImage("image/png", 0.92, 0);
    if (runLoop) {
      b.start();
      await new Promise((done) => setTimeout(done, 600));
    }
    const tslCanvas = await grab(b);
    if (runLoop) b.stop();
    globalThis["__tslDebug"] = undefined;
    b.dispose();

    // Read inline rather than through a helper: this callback is serialized into the page, so it
    // can only reference what it declares itself.
    const A = glCanvas.getContext("2d").getImageData(0, 0, glCanvas.width, glCanvas.height).data;
    const B = tslCanvas.getContext("2d").getImageData(0, 0, tslCanvas.width, tslCanvas.height).data;
    const diff = document.createElement("canvas");
    diff.width = glCanvas.width;
    diff.height = glCanvas.height;
    const image = diff.getContext("2d").createImageData(diff.width, diff.height);

    let total = 0;
    let worst = 0;
    let over = 0;
    let sumA = 0;
    let sumB = 0;
    let satA = 0;
    let satB = 0;
    const n = A.length / 4;
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.max(
        Math.abs(A[i] - B[i]),
        Math.abs(A[i + 1] - B[i + 1]),
        Math.abs(A[i + 2] - B[i + 2]),
      );
      total += d;
      worst = Math.max(worst, d);
      if (d > 4) over++;
      sumA += Math.max(A[i], A[i + 1], A[i + 2]);
      sumB += Math.max(B[i], B[i + 1], B[i + 2]);
      // Saturation as max-minus-min, which is what "washed out" actually means numerically.
      satA += Math.max(A[i], A[i + 1], A[i + 2]) - Math.min(A[i], A[i + 1], A[i + 2]);
      satB += Math.max(B[i], B[i + 1], B[i + 2]) - Math.min(B[i], B[i + 1], B[i + 2]);
      // Amplified, so a difference that matters is visible rather than merely present.
      const v = Math.min(255, d * 4);
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
    diff.getContext("2d").putImageData(image, 0, 0);

    const samples = {};
    for (const p of (atSpec || "").split(";").filter(Boolean)) {
      const [x, y] = p.split(",").map(Number);
      const i = ((y - region[1]) * diff.width + (x - region[0])) * 4;
      if (i < 0 || i >= A.length) continue;
      samples[p] = { glsl: [A[i], A[i + 1], A[i + 2]], tsl: [B[i], B[i + 1], B[i + 2]] };
    }

    return {
      stats:
        `  ${label} ${diff.width}x${diff.height}${probeName ? ` probe=${probeName}` : ""}\n` +
        `    mean|d| ${(total / n).toFixed(2)}   worst ${worst}   pixels>4 ${((100 * over) / n).toFixed(1)}%\n` +
        `    brightness  glsl ${(sumA / n).toFixed(1)}  tsl ${(sumB / n).toFixed(1)}\n` +
        `    saturation  glsl ${(satA / n).toFixed(1)}  tsl ${(satB / n).toFixed(1)}`,
      glsl: glCanvas.toDataURL(),
      tsl: tslCanvas.toDataURL(),
      diff: diff.toDataURL(),
      samples,
    };
  },
  [url, scene, width, height, probe, crop, gl_label(scene), at, frames, loop],
);

console.log(result.stats);
if (at) {
  console.log("    pixel          glsl                     tsl");
  for (const p of at.split(";")) {
    const [x, y] = p.split(",").map(Number);
    const g = result.samples[p];
    if (!g) continue;
    console.log(
      `    (${String(x).padStart(3)},${String(y).padStart(3)})  ${fmt(g.glsl).padEnd(24)} ${fmt(g.tsl)}`,
    );
  }
}
// A name from the scene, so an inline JSON scene does not become a filename.
const label = flag("label", gl_label(scene));
for (const key of ["glsl", "tsl", "diff"]) {
  const path = `${outDir}/compare-${label}-${key}.png`;
  await writeFile(path, Buffer.from(result[key].split(",")[1], "base64"));
}
console.log(`    wrote ${outDir}/compare-${label}-{glsl,tsl,diff}.png`);

await browser.close();
server.close();
