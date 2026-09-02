/* oxlint-disable unicorn/consistent-function-scoping -- The helpers below live inside a
   `page.evaluate` callback, which is serialized into the browser and can only reference what it
   declares itself. Hoisting them to module scope, as the rule asks, puts them out of reach of the
   only code that calls them. */
/**
 * Compare the two engines' INTERACTION state under identical pointer input.
 *
 *   node scripts/tsl-interaction.mjs                  # prism and cascade
 *   node scripts/tsl-interaction.mjs --scene prism
 *
 * Flags: --scene <preset[,preset...]>  --width  --height  --settle <ms>
 *
 * WHY NOT PIXELS. `captureImage` deliberately strips the live interaction state on BOTH engines —
 * a poster must not be framed from wherever the pointer happened to be — so a pixel comparison
 * through it can never see interaction at all. This reads the state the bindings produce instead,
 * which is also the more diagnostic thing to read: a number that is wrong tells you which binding,
 * where a frame that is wrong tells you only that something moved.
 *
 * WHY STEADY STATE. Bindings ease toward their target with per-binding smoothing, and each engine
 * drives that easing from its own wall clock, so the two are never at the same point of the same
 * curve at the same instant. Comparing mid-flight would measure scheduling. After settling, the
 * eased value is its target, which is deterministic and path-independent — so this checks that the
 * same pointer produces the same POSE and the same binding outputs, and deliberately does not
 * check that they take the same route there.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const THREE_BUILD = resolve("node_modules/.pnpm/three@0.185.1/node_modules/three/build");
const DIST = resolve("packages/core/dist");
const BUNDLE = resolve(DIST, "standalone/materials3d.standalone.js");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const scenes = flag("scene", "prism,cascade").split(",");
const width = Number(flag("width", 900));
const height = Number(flag("height", 540));
/** Long enough for the slowest binding's smoothing to reach its target. */
const settle = Number(flag("settle", 1600));
/**
 * Dispatch NOTHING and compare the idle state.
 *
 * The live renderers sit here whenever a pointer has never touched the canvas, and it is NOT the
 * same as the rest state: `captureImage` applies each binding's authored base, while an idle live
 * frame evaluates the bindings against whatever the controller's sources idle at. Every pixel
 * comparison in this directory goes through `captureImage`, so none of them has ever looked at it.
 */
const restOnly = args.includes("--rest");

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
    `<!doctype html><meta charset=utf-8><style>html,body{margin:0}
     #a,#b{position:absolute;top:0;width:${width}px;height:${height}px}
     #a{left:0}#b{left:${width}px}</style><div id=a></div><div id=b></div>`,
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: width * 2, height } });
page.on("pageerror", (e) => console.error("PAGE:", e.message.slice(0, 300)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/renderAsync/.test(t)) console.error("CONSOLE:", t.slice(0, 300));
});
await page.goto(url);

let failed = false;
for (const preset of scenes) {
  const rows = await page.evaluate(
    async ([base, name, w, h, ms, idleOnly]) => {
      const gl = await import(base + "bundle.js");
      const { NodeMaterialRenderer } = await import(base + "dist/renderer/NodeMaterialRenderer.js");
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

      // A TRAJECTORY, not a snapshot. The state is continuously animated, so one reading compares
      // two phases of an ongoing curve and reports scheduling as if it were a binding bug. Held
      // pointer, sampled repeatedly: if both approach the same asymptote the targets agree, and
      // whether they take the same route is a separate (and much less important) question.
      // WAIT FOR BOTH CONTROLLERS FIRST. The WebGL engine attaches its listeners synchronously in
      // the constructor; this one builds its controller after negotiating a WebGPU device, so a
      // pointer dispatched immediately after `start()` lands before anything is listening. That is
      // a real if narrow behavioural difference — a pointer already over the canvas during startup
      // is missed — but it is not the binding difference this script exists to find, and reading it
      // as one cost a diagnosis.
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

      // WHEEL, then a right-button DRAG. Neither is a pointer binding: they are the renderer's own
      // orbit controls, and nothing else in this directory exercises them. The entire block was
      // missing from the node engine — `yaw`, `pitch` and `distance` existed and the camera read
      // them, but nothing ever wrote them — and every comparison stayed green because they all
      // move a pointer and none of them turns a wheel.
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
    [url, preset, width, height, settle, restOnly],
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

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
