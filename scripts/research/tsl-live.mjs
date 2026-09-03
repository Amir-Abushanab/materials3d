/**
 * Compare a LIVE frame from each engine, at an identical scene time.
 *
 *   pnpm tsl:live                            # prism
 *   pnpm tsl:live skewer --no-dust --out renders/live
 *
 * Flags: --out <dir> (default renders/)  --no-dust (take the dust out)
 *
 * A research tool rather than a gate: it needs a real Chrome, takes several seconds per run and
 * reports numbers for a person to read, which is why it lives under scripts/research/.
 *
 * WHY THIS EXISTS ALONGSIDE `tsl-compare`. That harness compares through `captureImage`, which is
 * NOT the path a person watches: it applies each binding's REST value, resets the interaction
 * camera and renders one frame on demand. This drives both engines' own rAF loops, pauses the
 * clock, seeks both to the same time, and photographs the result.
 *
 * The difference is not academic. The dust light-field tap was sampling the pyramid mirrored, which
 * lit every grain from the wrong half of the frame. It was worth 1.4 here and almost nothing
 * through `captureImage`, so every static comparison called it fine; it was found by a person
 * looking at the studio and saying the light seemed off.
 *
 * A COMPOSITED SCREENSHOT, not a canvas readback. A WebGPU surface without a preserved drawing
 * buffer reads back empty outside the rAF that presented it, and the first version of this script
 * duly measured the node engine as pure black.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertPresets,
  launch,
  outputDir,
  parseArgs,
  presetNames,
  requireBuild,
  run,
  serve,
  sideBySideHtml,
  writeDataUrl,
} from "../lib/harness.mjs";

const USAGE = `usage: pnpm tsl:live [<preset>] [--no-dust] [--out <dir>]

Runs both engines' own frame loops side by side in a real Chrome, seeks both to t=3s, and diffs a
composited screenshot. Writes live-<preset>-{page,glsl,tsl,diff}.png.

  --no-dust    render without dust
  --out <dir>  where the images go (default renders/)`;

const W = 1064;
const H = 598;

await run(async (defer) => {
  const args = parseArgs(process.argv.slice(2), { out: "", "no-dust": false });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  requireBuild({ dist: true });
  const preset = args.positionals[0] ?? "prism";

  const server = await serve({ html: sideBySideHtml(W, H) });
  defer(server.close);
  const { page, check, close } = await launch({ width: W * 2, height: H, headed: true });
  defer(close);
  await page.goto(server.url);
  check();
  assertPresets([preset], await presetNames(page, server.url));

  await page.evaluate(
    async ([base, name, noDust]) => {
      const gl = await import(base + "bundle.js");
      const { NodeMaterialRenderer } = await import(base + "dist/renderer/NodeMaterialRenderer.js");
      const A = document.getElementById("a");
      const B = document.getElementById("b");
      // PAUSED, so the loop keeps drawing but the clock does not advance and `seek` holds.
      const cfg = () => {
        const c = { ...gl.PRESETS[name](), paused: true };
        if (noDust && c.dust) c.dust = { ...c.dust, count: 0 };
        return c;
      };
      const a = new gl.MaterialRenderer(A, cfg(), { respectReducedMotion: false });
      const b = new NodeMaterialRenderer(B, cfg(), { respectReducedMotion: false });
      a.start();
      b.start();
      await new Promise((done) => setTimeout(done, 5000));
      a.seek(3.0);
      b.seek(3.0);
      await new Promise((done) => setTimeout(done, 2000));
    },
    [server.url, preset, args["no-dust"]],
  );

  // A COMPOSITED screenshot, not a canvas readback; see the header.
  const shot = await page.screenshot();
  const dir = await outputDir(args.out || undefined);
  await writeFile(resolve(dir, `live-${preset}-page.png`), shot);
  const res = await page.evaluate(
    async ([dataUrl, w, h]) => {
      const img = await new Promise((ok) => {
        const i = new Image();
        i.addEventListener("load", () => ok(i));
        i.src = dataUrl;
      });
      const cut = (x) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, -x, 0);
        return c;
      };
      const ca = cut(0);
      const cb = cut(w);
      const pa = ca.getContext("2d").getImageData(0, 0, w, h).data;
      const pb = cb.getContext("2d").getImageData(0, 0, w, h).data;
      const stats = globalThis.m3dHelpers.frameDiff(pa, pb);
      const d = document.createElement("canvas");
      d.width = w;
      d.height = h;
      d.getContext("2d").putImageData(new ImageData(stats.image, w, h), 0, 0);
      return {
        stats: `mean|d| ${stats.mean.toFixed(2)}  worst ${stats.worst}  pixels>4 ${stats.overPct.toFixed(1)}%  brightness ${stats.brightnessA.toFixed(1)} / ${stats.brightnessB.toFixed(1)}`,
        glsl: ca.toDataURL(),
        tsl: cb.toDataURL(),
        diff: d.toDataURL(),
      };
    },
    ["data:image/png;base64," + shot.toString("base64"), W, H],
  );
  console.log(" ", res.stats);
  for (const k of ["glsl", "tsl", "diff"]) {
    await writeDataUrl(resolve(dir, `live-${preset}-${k}.png`), res[k]);
  }
  console.log(`  wrote ${dir}/live-${preset}-{page,glsl,tsl,diff}.png`);
});
