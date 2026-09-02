/* oxlint-disable unicorn/consistent-function-scoping -- The helpers below live inside a
   `page.evaluate` callback, which is serialized into the browser and can only reference what it
   declares itself. Hoisting them to module scope, as the rule asks, puts them out of reach of the
   only code that calls them. */
/**
 * Time both engines on the same scenes, in a REAL Chrome.
 *
 *   pnpm tsl:perf                       # every preset, 900x540
 *   pnpm tsl:perf --scene materials,prism --width 1920 --height 1080
 *
 * Flags: --scene <preset[,preset...]|all>  --width  --height  --frames  --out <json>
 *
 * WHY A REAL BROWSER. Headless Chromium serves WebGPU from a software adapter, so a headless
 * timing run measures SwiftShader against a hardware WebGL context and reports a slowdown that has
 * nothing to do with either engine. Same reason `real-chrome-smoke` exists.
 *
 * WHAT IS TIMED. `captureImage`, because it is the only entry point on both engines that AWAITS a
 * finished frame. `renderOnce` returns as soon as the work is submitted, and on the node engine it
 * is worse than useless here: `drawGuarded` DROPS a frame when one is already in flight, so a tight
 * loop of `renderOnce` measures how fast a mutex can reject calls.
 *
 * The cost of encoding the blob is included, and it is not small. That is what `floor` is for: the
 * same measurement on the same canvas with an empty scene, which is encode plus a clear. `scene`
 * is the subtraction, and it is the number to read. Both engines pay the same encoder on
 * near-identical images — that is the point of everything else in this directory — so the
 * subtraction is fair even though neither raw figure is a render time.
 *
 * NOT a frame-rate benchmark. Nothing here runs the rAF loop, so nothing is vsync-limited and
 * these numbers are not the fps a user sees. They are the cost of producing one frame, which is
 * the part the engine controls.
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
const scene = flag("scene", "all");
const width = Number(flag("width", 900));
const height = Number(flag("height", 540));
/** Enough that the median is not one unlucky frame, few enough to stay under a minute per preset. */
const frames = Number(flag("frames", 24));
const outFile = flag("out", "");

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

// Headed, and on real Chrome rather than bundled Chromium — see the note above.
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width, height } });
page.on("pageerror", (e) => console.error("PAGE:", e.message.slice(0, 300)));
page.on("console", (m) => {
  const text = m.text();
  if (m.type() === "error" && !/renderAsync/.test(text))
    console.error("CONSOLE:", text.slice(0, 300));
});
await page.goto(url);

const presets =
  scene === "all"
    ? await page.evaluate(
        async (base) => Object.keys((await import(base + "bundle.js")).PRESETS),
        [url],
      )
    : scene.split(",");

const results = [];
for (const preset of presets) {
  const row = await page.evaluate(
    async ([base, name, w, h, n]) => {
      const gl = await import(base + "bundle.js");
      const { NodeMaterialRenderer } = await import(base + "dist/renderer/NodeMaterialRenderer.js");
      const host = document.getElementById("host");

      const median = (xs) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)];

      /**
       * Time `count` awaited frames, discarding the first quarter.
       *
       * The discard is not tidiness: the first frames of either engine include pipeline compilation
       * and the room bake, which is real cost a user pays once and noise in a per-frame median.
       */
      const timeFrames = async (renderer, count) => {
        const times = [];
        for (let i = 0; i < count; i++) {
          const t0 = performance.now();
          await renderer.captureImage("image/png", 0.92, i * 0.05);
          times.push(performance.now() - t0);
        }
        return times.slice(Math.ceil(count / 4));
      };

      const run = async (make, cfg) => {
        host.replaceChildren();
        const renderer = make(cfg);
        renderer.setOutputSize({ width: w, height: h });
        const times = await timeFrames(renderer, n);
        renderer.dispose();
        return times;
      };

      const full = gl.PRESETS[name]();
      // The floor: encode, a clear and the backdrop, and NOTHING else that either engine can spend
      // real time on.
      //
      // Dust and the bloom mode have to go explicitly. Zeroing `bloom` does not retire the pyramid
      // — the WebGL engine still allocates and renders it when `bloomMode` is "pyramid" OR any dust
      // exists, because dust reads its widest level. Leaving those on made the floor for `cascade`
      // 16ms on one engine and 10ms on the other, and subtracting two different numbers reported
      // WebGPU as ELEVEN TIMES faster there. A floor that is not actually a floor is worse than no
      // subtraction at all: it produces a headline rather than an error.
      const empty = gl.PRESETS[name]();
      empty.items = [];
      delete empty.scatter;
      if (empty.dust) empty.dust = { ...empty.dust, count: 0 };
      empty.post = {
        ...empty.post,
        bloom: 0,
        bloomMode: "gather",
        caustics: 0,
        haze: 0,
        vignette: 0,
        grain: 0,
      };

      const makeGl = (c) => new gl.MaterialRenderer(host, c, { respectReducedMotion: false });
      const makeNode = (c) => new NodeMaterialRenderer(host, c, { respectReducedMotion: false });

      const out = {};
      for (const [key, make] of [
        ["webgl", makeGl],
        ["webgpu", makeNode],
      ]) {
        out[key] = {
          full: median(await run(make, structuredClone(full))),
          floor: median(await run(make, structuredClone(empty))),
        };
        out[key].scene = out[key].full - out[key].floor;
      }
      return { preset: name, ...out };
    },
    [url, preset, width, height, frames],
  );
  results.push(row);
  const f = (x) => x.toFixed(1).padStart(6);
  console.log(
    `  ${row.preset.padEnd(11)} scene  webgl ${f(row.webgl.scene)}ms   webgpu ${f(row.webgpu.scene)}ms` +
      `   ratio ${(row.webgpu.scene / Math.max(row.webgl.scene, 0.01)).toFixed(2)}x` +
      `   (total ${f(row.webgl.full)} / ${f(row.webgpu.full)})`,
  );
}

if (outFile) await writeFile(outFile, JSON.stringify({ width, height, frames, results }, null, 2));
await browser.close();
server.close();
