/**
 * Drive the running studio in a REAL Chrome and check every preset on both engines.
 *
 * This exists because the headless browser is not a substitute here. Headless Chromium falls back
 * to a software adapter whose WGSL front end is more permissive than a Metal- or Vulkan-backed
 * Chrome's: `pow()` with a negative constant base compiled fine headlessly and was rejected
 * outright on a real GPU, which took down every pipeline in the node engine. Nothing in
 * `tsl-parity` or `tsl-compare` could see it, both run headless, so the node engine passed every
 * check while rendering nothing at all for anyone actually using it.
 *
 * It also drives the studio's own UI rather than constructing a renderer directly, which is the
 * only way to exercise preset switching, the engine picker and `setConfig` the way a person does.
 *
 *   pnpm --filter materials-studio dev        # in another terminal
 *   node scripts/real-chrome-smoke.mjs --url http://localhost:5173/
 *
 * Flags: --url <origin>  --engine webgl|webgpu|both  --shots <dir>
 */
import { mkdir } from "node:fs/promises";
import { launch, parseArgs, run } from "./lib/harness.mjs";

const USAGE = `usage: pnpm tsl:chrome [--url <origin>] [--engine webgl|webgpu|both] [--shots <dir>]

Needs a running studio (pnpm dev) and a real Chrome. Clicks through every preset on the chosen
engine(s), reports whether each drew anything, and fails on any page or console error.

  --url <origin>     the studio (default http://localhost:5173/)
  --engine <which>   webgl, webgpu or both (default both)
  --shots <dir>      also save a screenshot per engine and preset`;

await run(async (defer) => {
  const args = parseArgs(process.argv.slice(2), {
    url: "http://localhost:5173/",
    engine: "both",
    shots: "",
  });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!["webgl", "webgpu", "both"].includes(args.engine)) {
    throw new Error(`--engine must be webgl, webgpu or both, got "${args.engine}"`);
  }
  const engines = args.engine === "both" ? ["webgl", "webgpu"] : [args.engine];
  if (args.shots) await mkdir(args.shots, { recursive: true });

  const { page, pageErrors, consoleErrors, close } = await launch({
    width: 1440,
    height: 900,
    headed: true,
  });
  defer(close);
  await page.goto(args.url, { waitUntil: "load" });
  await page.waitForTimeout(2500);

  /**
   * Read the PRESENTED surface from inside a `requestAnimationFrame`.
   *
   * Outside one, a WebGPU canvas configured without a preserved drawing buffer reads back empty
   * and every scene measures as black, which is a property of the readback, not of the render,
   * and is an easy way to spend an afternoon debugging a renderer that was working.
   */
  const stat = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => {
            const live = document.querySelector("#scene canvas");
            if (!live) return resolve("no canvas");
            const copy = document.createElement("canvas");
            copy.width = live.width;
            copy.height = live.height;
            const ctx = copy.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(live, 0, 0);
            const px = ctx.getImageData(0, 0, copy.width, copy.height).data;
            const { mean, litPct } = globalThis.m3dHelpers.litStats(px);
            resolve(`mean ${mean.toFixed(1).padStart(6)}  lit ${litPct.toFixed(1).padStart(5)}%`);
          }),
        ),
    );

  const setEngine = (want) =>
    page.evaluate((w) => {
      for (const select of document.querySelectorAll("select")) {
        const isEnginePicker = [...select.options].some((o) =>
          /webgpu/i.test(o.value + o.textContent),
        );
        if (!isEnginePicker) continue;
        const option = [...select.options].find((o) =>
          new RegExp(w, "i").test(o.value + o.textContent),
        );
        if (!option) return `no option ${w}`;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return option.value;
      }
      return "no engine picker";
    }, want);

  const presets = await page.evaluate(() =>
    [...document.querySelectorAll("[data-preset]")].map((el) => el.dataset.preset),
  );
  console.log(`presets: ${presets.join(" ")}`);

  let failed = false;
  for (const engine of engines) {
    const chosen = await setEngine(engine);
    console.log(`\n== ${engine} (${chosen}) ==`);
    // The node engine negotiates a device before it can draw anything.
    await page.waitForTimeout(3000);
    for (const preset of presets) {
      await page.click(`[data-preset="${preset}"]`);
      await page.waitForTimeout(2200);
      const line = await stat();
      console.log(`  ${preset.padEnd(12)} ${line}`);
      if (/mean\s+0\.0/.test(line)) failed = true;
      if (args.shots) {
        try {
          await page.screenshot({
            path: `${args.shots}/${engine}-${preset}.png`,
            clip: { x: 0, y: 0, width: 1120, height: 900 },
            timeout: 15000,
          });
        } catch {
          console.log("      (screenshot timed out)");
        }
      }
    }
  }

  const errors = [
    ...new Set([
      ...pageErrors.map((text) => `PAGEERROR: ${text}`),
      ...consoleErrors.map((text) => `ERROR: ${text.slice(0, 300)}`),
    ]),
  ];
  console.log(
    errors.length ? `\n--- errors ---\n${errors.slice(0, 15).join("\n")}` : "\n(no errors)",
  );
  return !failed && errors.length === 0;
});
