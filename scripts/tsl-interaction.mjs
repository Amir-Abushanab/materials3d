/* oxlint-disable unicorn/consistent-function-scoping -- The helpers below live inside a
   `page.evaluate` callback, which is serialized into the browser and can only reference what it
   declares itself. Hoisting them to module scope, as the rule asks, puts them out of reach of the
   only code that calls them. */
/**
 * Compare the two engines' INTERACTION state under identical pointer input.
 *
 *   node scripts/tsl-interaction.mjs                  # prism and skewer
 *   node scripts/tsl-interaction.mjs --scene prism
 *
 * Flags: --scene <preset[,preset...]>  --width  --height  --settle <ms>  --rest
 *
 * WHY NOT PIXELS. `captureImage` deliberately strips the live interaction state on BOTH engines
 * (a poster must not be framed from wherever the pointer happened to be), so a pixel comparison
 * through it can never see interaction at all. This reads the state the bindings produce instead,
 * which is also the more diagnostic thing to read: a number that is wrong tells you which binding,
 * where a frame that is wrong tells you only that something moved.
 *
 * WHY STEADY STATE. Bindings ease toward their target with per-binding smoothing, and each engine
 * drives that easing from its own wall clock, so the two are never at the same point of the same
 * curve at the same instant. Comparing mid-flight would measure scheduling. After settling, the
 * eased value is its target, which is deterministic and path-independent, so this checks that the
 * same pointer produces the same POSE and the same binding outputs, and deliberately does not
 * check that they take the same route there.
 */
import {
  assertPresets,
  launch,
  parseArgs,
  presetNames,
  requireBuild,
  run,
  serve,
  sideBySideHtml,
} from "./lib/harness.mjs";

const USAGE = `usage: pnpm tsl:interaction [--scene <preset[,preset...]>] [--width <px>] [--height <px>] [--settle <ms>] [--rest]

Drives both engines with the same pointer, wheel and right-drag input and compares the settled
interaction state. Exits non-zero when any value differs.

  --scene    presets to compare (default prism,skewer)
  --settle   how long the slowest binding gets to reach its target (default 1600)
  --rest     dispatch nothing and compare the idle state instead`;

await run(async (defer) => {
  const args = parseArgs(process.argv.slice(2), {
    scene: "prism,skewer",
    width: 900,
    height: 540,
    /** Long enough for the slowest binding's smoothing to reach its target. */
    settle: 1600,
    /**
     * Dispatch NOTHING and compare the idle state.
     *
     * The live renderers sit here whenever a pointer has never touched the canvas, and it is NOT
     * the same as the rest state: `captureImage` applies each binding's authored base, while an
     * idle live frame evaluates the bindings against whatever the controller's sources idle at.
     * Every pixel comparison in this directory goes through `captureImage`, so none of them has
     * ever looked at it.
     */
    rest: false,
  });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  requireBuild({ dist: true });
  const { width, height } = args;
  const scenes = args.scene.split(",");

  const server = await serve({ html: sideBySideHtml(width, height) });
  defer(server.close);
  const { page, check, close } = await launch({ width: width * 2, height });
  defer(close);
  await page.goto(server.url);
  check();
  assertPresets(scenes, await presetNames(page, server.url));

  let failed = false;
  for (const preset of scenes) {
    const rows = await page.evaluate(
      async ([base, name, w, h, ms, idleOnly]) => {
        const gl = await import(base + "bundle.js");
        const { NodeMaterialRenderer } = await import(
          base + "dist/renderer/NodeMaterialRenderer.js"
        );
        const hostA = document.getElementById("a");
        const hostB = document.getElementById("b");
        hostA.replaceChildren();
        hostB.replaceChildren();

        const cfg = gl.PRESETS[name];
        const a = new gl.MaterialRenderer(hostA, cfg(), { respectReducedMotion: false });
        const b = new NodeMaterialRenderer(hostB, cfg(), { respectReducedMotion: false });
        a.setOutputSize({ width: w, height: h });
        b.setOutputSize({ width: w, height: h });
        a.start();
        b.start();

        /** The same pointer, in each host's own client coordinates. */
        const point = (host, fx, fy, type) => {
          const r = host.getBoundingClientRect();
          host.dispatchEvent(
            new PointerEvent(type, {
              clientX: r.left + r.width * fx,
              clientY: r.top + r.height * fy,
              bubbles: true,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
        };
        const wait = (t) => new Promise((done) => setTimeout(done, t));

        const read = (r) => ({
          beamIncidence: r.interactionSceneOut.beamIncidence,
          beamEntry: r.interactionSceneOut.beamEntry,
          orbitYaw: r.interactionSceneOut.orbitYaw,
          orbitPitch: r.interactionSceneOut.orbitPitch,
          zoom: r.interactionSceneOut.zoom,
          camX: r.camera.position.x,
          camY: r.camera.position.y,
          camZ: r.camera.position.z,
        });

        // A TRAJECTORY, not a snapshot. The state is continuously animated, so one reading
        // compares two phases of an ongoing curve and reports scheduling as if it were a binding
        // bug. Held pointer, sampled repeatedly: if both approach the same asymptote the targets
        // agree, and whether they take the same route is a separate (and much less important)
        // question.
        // WAIT FOR BOTH CONTROLLERS FIRST. The WebGL engine attaches its listeners synchronously
        // in the constructor; this one builds its controller after negotiating a WebGPU device,
        // so a pointer dispatched immediately after `start()` lands before anything is listening.
        // That is a real if narrow behavioural difference (a pointer already over the canvas
        // during startup is missed), but it is not the binding difference this script exists to
        // find, and reading it as one cost a diagnosis.
        const out = [];
        for (let i = 0; i < 200 && !(a.interaction && b.interaction); i++) await wait(50);
        if (!a.interaction || !b.interaction) return { rows: [], diag: { ready: false } };
        if (!idleOnly) {
          for (const host of [hostA, hostB]) {
            point(host, 0.8, 0.7, "pointerenter");
            point(host, 0.8, 0.7, "pointermove");
          }
        }
        for (let k = 0; k < 4; k++) {
          await wait(ms / 8);
          out.push({
            label: `hover t+${Math.round(((k + 1) * ms) / 8)}ms`,
            glsl: read(a),
            tsl: read(b),
          });
        }

        if (idleOnly) {
          a.stop();
          b.stop();
          a.dispose();
          b.dispose();
          return { rows: out, diag: {} };
        }

        // WHEEL, then a right-button DRAG. Neither is a pointer binding: they are the renderer's
        // own orbit controls, and nothing else in this directory exercises them. The entire block
        // was missing from the node engine (`yaw`, `pitch` and `distance` existed and the camera
        // read them, but nothing ever wrote them) and every comparison stayed green because they
        // all move a pointer and none of them turns a wheel.
        const canvasOf = (host) => host.querySelector("canvas") ?? host;
        for (const host of [hostA, hostB]) {
          canvasOf(host).dispatchEvent(
            new WheelEvent("wheel", { deltaY: 300, bubbles: true, cancelable: true }),
          );
        }
        await wait(ms / 2);
        out.push({ label: "wheel", glsl: read(a), tsl: read(b) });

        for (const host of [hostA, hostB]) {
          const c = canvasOf(host);
          const r = host.getBoundingClientRect();
          const at = (x, y, type, button) =>
            c.dispatchEvent(
              new PointerEvent(type, {
                clientX: r.left + x,
                clientY: r.top + y,
                button,
                buttons: button === 2 ? 2 : 0,
                bubbles: true,
                pointerId: 2,
                pointerType: "mouse",
              }),
            );
          // Right button: the primary one belongs to whatever is layered above.
          at(100, 100, "pointerdown", 2);
          at(220, 160, "pointermove", 2);
          at(220, 160, "pointerup", 2);
        }
        await wait(ms / 2);
        out.push({ label: "right-drag", glsl: read(a), tsl: read(b) });
        const ctl = (r) =>
          r.interaction &&
          JSON.stringify({
            ndc: r.interaction.ndc,
            ndcTarget: r.interaction.ndcTarget,
            presence: r.interaction.presence,
            presenceTarget: r.interaction.presenceTarget,
          });
        out.diag = { glsl: ctl(a), tsl: ctl(b) };

        a.stop();
        b.stop();
        a.dispose();
        b.dispose();
        return { rows: out, diag: out.diag };
      },
      [server.url, preset, width, height, args.settle, args.rest],
    );

    console.log(`\n== ${preset} ==`);
    console.log("  diag:", JSON.stringify(rows.diag));
    for (const row of rows.rows) {
      const keys = Object.keys(row.glsl);
      const bad = keys.filter((k) => Math.abs(row.glsl[k] - row.tsl[k]) > 0.01);
      const worst = Math.max(...keys.map((k) => Math.abs(row.glsl[k] - row.tsl[k])));
      console.log(
        `  ${row.label.padEnd(16)} max|d| ${worst.toFixed(4)}  ${bad.length ? "DIFFER" : "match"}`,
      );
      for (const k of bad) {
        console.log(
          `      ${k.padEnd(14)} glsl ${row.glsl[k].toFixed(4)}   tsl ${row.tsl[k].toFixed(4)}`,
        );
        failed = true;
      }
    }
  }
  return !failed;
});
