/* oxlint-disable unicorn/consistent-function-scoping -- Browser helpers are serialized with page.evaluate. */
/** Verify that live bindings wake skipped depth/bloom passes and return to an identical rest frame.
 *  Run after `pnpm build:packages`: node scripts/render-gating.mjs */
import { launch, requireBuild, run, serve } from "./lib/harness.mjs";

await run(async (defer) => {
  requireBuild({ dist: true });
  const server = await serve();
  defer(server.close);
  const { page, check, close, consoleErrors } = await launch({ width: 480, height: 320 });
  defer(close);
  await page.goto(server.url);
  const rows = await page.evaluate(async (base) => {
    const gl = await import(base + "bundle.js");
    const { NodeMaterialRenderer } = await import(base + "dist/renderer/NodeMaterialRenderer.js");
    const results = [];
    for (const [engine, Renderer] of [
      ["webgl", gl.MaterialRenderer],
      ["webgpu", NodeMaterialRenderer],
    ]) {
      const config = gl.PRESETS.assembly();
      config.paused = true;
      config.post = { ...config.post, aperture: 0, bloom: 0, bloomMode: "pyramid", grain: 0 };
      config.interaction = {
        enabled: true,
        bindings: [
          { source: "custom:effects", target: "aperture", from: 0, to: 4, smoothing: 0 },
          { source: "custom:effects", target: "bloom", from: 0, to: 0.5, smoothing: 0 },
        ],
      };
      const renderer = new Renderer(document.getElementById("host"), config, {
        respectReducedMotion: false,
      });
      try {
        renderer.setOutputSize({ width: 480, height: 320 });
        await renderer.captureImage("image/png", 1, 0);
        // Node rendering is asynchronous. Await its active draw without capturing, because capture
        // deliberately resets interaction and could never test what a live binding displays.
        const draw = async () => {
          await renderer.drawing;
          renderer.seek(0);
          await renderer.drawing;
        };
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 320;
        const context = canvas.getContext("2d");
        const pixels = () => {
          context.clearRect(0, 0, 480, 320);
          context.drawImage(renderer.renderer.domElement, 0, 0);
          return context.getImageData(0, 0, 480, 320).data;
        };
        const worst = (a, b) => a.reduce((max, v, i) => Math.max(max, Math.abs(v - b[i])), 0);
        let calls = 0;
        const original = renderer.renderer.render.bind(renderer.renderer);
        renderer.renderer.render = (...args) => {
          calls++;
          return original(...args);
        };
        const states = [];
        for (const input of [0, 1, 0]) {
          renderer.setInteractionInput("effects", input);
          renderer.interaction.settle();
          calls = 0;
          await draw();
          states.push({ calls, pixels: pixels() });
        }
        // The live enabled frame must equal the same effects authored directly into the config.
        renderer.getConfig().interaction.enabled = false;
        renderer.getConfig().post.aperture = 4;
        renderer.getConfig().post.bloom = 0.5;
        renderer.refresh();
        await draw();
        const enabledDifference = worst(states[1].pixels, pixels());
        const restoredDifference = worst(states[0].pixels, states[2].pixels);
        const passCounts = states.map((state) => state.calls);
        results.push({ engine, passCounts, enabledDifference, restoredDifference });
      } finally {
        renderer.dispose();
      }
    }
    return results;
  }, server.url);
  check();
  for (const row of rows) console.log(JSON.stringify(row));
  return (
    consoleErrors.length === 0 &&
    rows.every(
      (row) =>
        row.passCounts.join(",") === "4,15,4" &&
        row.enabledDifference <= 1 &&
        row.restoredDifference === 0,
    )
  );
});
