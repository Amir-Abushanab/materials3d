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
 * near-identical images (that is the point of everything else in this directory), so the
 * subtraction is fair even though neither raw figure is a render time.
 *
 * NOT a frame-rate benchmark. Nothing here runs the rAF loop, so nothing is vsync-limited and
 * these numbers are not the fps a user sees. They are the cost of producing one frame, which is
 * the part the engine controls.
 */
import { writeFile } from "node:fs/promises";
import {
  assertPresets,
  launch,
  parseArgs,
  presetNames,
  requireBuild,
  run,
  serve,
} from "./lib/harness.mjs";

const USAGE = `usage: pnpm tsl:perf [--scene <preset[,preset...]|all>] [--width <px>] [--height <px>] [--frames <n>] [--out <json>]

Opens a real Chrome (hardware GPU) and times captureImage on both engines, per preset.

  --scene    presets to time, or all (default all)
  --width    frame width (default 900)
  --height   frame height (default 540)
  --frames   frames per measurement; the first quarter is discarded (default 24)
  --out      also write the results as JSON`;

await run(async (defer) => {
  const args = parseArgs(process.argv.slice(2), {
    scene: "all",
    width: 900,
    height: 540,
    /** Enough that the median is not one unlucky frame, few enough to stay under a minute per preset. */
    frames: 24,
    out: "",
  });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  requireBuild({ dist: true });
  const { width, height, frames } = args;

  const server = await serve();
  defer(server.close);
  // Headed, and on real Chrome rather than bundled Chromium; see the note above.
  const { page, check, close } = await launch({ width, height, headed: true });
  defer(close);
  await page.goto(server.url);
  check();

  const valid = await presetNames(page, server.url);
  const presets = args.scene === "all" ? valid : args.scene.split(",");
  assertPresets(presets, valid);

  const results = [];
  for (const preset of presets) {
    const row = await page.evaluate(
      async ([base, name, w, h, n]) => {
        const gl = await import(base + "bundle.js");
        const { NodeMaterialRenderer } = await import(
          base + "dist/renderer/NodeMaterialRenderer.js"
        );
        const host = document.getElementById("host");

        const median = (xs) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)];

        /**
         * Time `count` awaited frames, discarding the first quarter.
         *
         * The discard is not tidiness: the first frames of either engine include pipeline
         * compilation and the room bake, which is real cost a user pays once and noise in a
         * per-frame median.
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

        const measure = async (make, cfg) => {
          host.replaceChildren();
          const renderer = make(cfg);
          renderer.setOutputSize({ width: w, height: h });
          const times = await timeFrames(renderer, n);
          renderer.dispose();
          return times;
        };

        const full = gl.PRESETS[name]();
        // The floor: encode, a clear and the backdrop, and NOTHING else that either engine can
        // spend real time on.
        //
        // Dust and the bloom mode have to go explicitly. Zeroing `bloom` does not retire the
        // pyramid: the WebGL engine still allocates and renders it when `bloomMode` is "pyramid"
        // OR any dust exists, because dust reads its widest level. Leaving those on made the floor
        // for the dust-heavy `cascade` preset (since removed) 16ms on one engine and 10ms on the
        // other, and subtracting two different numbers reported WebGPU as ELEVEN TIMES faster
        // there. A floor that is not actually a floor is worse than no subtraction at all: it
        // produces a headline rather than an error.
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
            full: median(await measure(make, structuredClone(full))),
            floor: median(await measure(make, structuredClone(empty))),
          };
          out[key].scene = out[key].full - out[key].floor;
        }
        return { preset: name, ...out };
      },
      [server.url, preset, width, height, frames],
    );
    results.push(row);
    const f = (x) => x.toFixed(1).padStart(6);
    console.log(
      `  ${row.preset.padEnd(11)} scene  webgl ${f(row.webgl.scene)}ms   webgpu ${f(row.webgpu.scene)}ms` +
        `   ratio ${(row.webgpu.scene / Math.max(row.webgl.scene, 0.01)).toFixed(2)}x` +
        `   (total ${f(row.webgl.full)} / ${f(row.webgpu.full)})`,
    );
  }

  if (args.out) {
    await writeFile(args.out, JSON.stringify({ width, height, frames, results }, null, 2));
  }
});
