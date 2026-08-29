/**
 * `pnpm render <scene> [options]` — a config to a PNG, without a studio.
 *
 * The renderer is WebGL, so there is no way to rasterize a scene without a browser; what there IS
 * is a browser we drive ourselves, headless, one explicit frame at a time. That distinction is the
 * whole point of this file. Driving the *studio* through a live page fails in ways that are hard
 * to even notice: `requestAnimationFrame` stops in a backgrounded tab, so the canvas quietly holds
 * a stale frame and every screenshot of it is a lie. Nothing here waits for a frame loop — it
 * calls `captureImage`, which seeks to a fixed time and renders once, synchronously.
 *
 * It goes through exactly the path the studio's "Save still" uses (`setOutputSize` then
 * `captureImage(mime, quality, time)`), so a headless render and a studio export of the same
 * config are the same image.
 *
 * Deterministic by construction: time defaults to 0 — the frame a scene opens on — so re-rendering
 * a preset does not churn in git, and a visual diff means something actually changed.
 *
 *   pnpm render assembly                        → assembly.png at 1920×1080
 *   pnpm render gallery/skewer.json -o hero.png
 *   pnpm render --all -d renders/ -w 1200 -h 630
 *   pnpm render slimes -t 2.5                   → the frame 2.5s in
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, resolve, join, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE = resolve(ROOT, "packages/core/dist/standalone/materials3d.standalone.js");

const FORMATS = {
  ".png": { mime: "image/png", lossy: false },
  ".webp": { mime: "image/webp", lossy: true },
  ".jpg": { mime: "image/jpeg", lossy: true },
  ".jpeg": { mime: "image/jpeg", lossy: true },
};

function parseArgs(argv) {
  const out = {
    scenes: [],
    width: 1920,
    height: 1080,
    time: 0,
    quality: 0.94,
    dir: ".",
    all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--all") out.all = true;
    else if (a === "-o" || a === "--out") out.out = next();
    else if (a === "-d" || a === "--dir") out.dir = next();
    else if (a === "-w" || a === "--width") out.width = Number(next());
    else if (a === "-h" || a === "--height") out.height = Number(next());
    else if (a === "-t" || a === "--time") out.time = Number(next());
    else if (a === "-q" || a === "--quality") out.quality = Number(next());
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else out.scenes.push(a);
  }
  if (
    !Number.isFinite(out.width) ||
    !Number.isFinite(out.height) ||
    out.width < 1 ||
    out.height < 1
  ) {
    throw new Error("width and height must be positive numbers");
  }
  if (!Number.isFinite(out.time)) throw new Error("time must be a number");
  return out;
}

/**
 * Serve the bundle over HTTP rather than reading it off disk.
 *
 * The standalone build is an ES module, and a `file://` page cannot import one — the origin is
 * opaque, so the import is blocked before any of this gets a chance to run.
 */
async function serveBundle() {
  const code = await readFile(BUNDLE, "utf8");
  const page = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#fff} #host{position:fixed;inset:0}
  </style><div id="host"></div>`;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/materials3d.standalone.js")) {
      res.writeHead(200, { "content-type": "text/javascript" }).end(code);
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

/** A scene argument is either a preset name or a path to a config file. */
async function loadScene(scene, presetNames) {
  if (presetNames.includes(scene)) return { name: scene, preset: scene };
  const path = resolve(scene);
  if (!existsSync(path)) {
    throw new Error(`no preset or file called "${scene}" — presets are: ${presetNames.join(", ")}`);
  }
  return { name: basename(path, extname(path)), config: JSON.parse(await readFile(path, "utf8")) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `standalone bundle missing at ${BUNDLE}\nRun: pnpm --filter @materials3d/core build:standalone`,
    );
  }

  const server = await serveBundle();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    // A page error here means the bundle threw on import; without this it surfaces much later as
    // an inscrutable "renderer is undefined".
    page.on("pageerror", (error) => {
      throw new Error(`page error: ${error.message}`);
    });
    await page.goto(server.url);

    const presetNames = await page.evaluate(async (url) => {
      const mod = await import(url);
      globalThis.m3d = mod;
      return Object.keys(mod.PRESETS);
    }, `${server.url}materials3d.standalone.js`);

    const gl = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const ctx = c.getContext("webgl2") || c.getContext("webgl");
      return ctx ? ctx.getParameter(ctx.VERSION) : null;
    });
    if (!gl) throw new Error("headless Chromium has no WebGL context — cannot render");

    const scenes = args.all
      ? presetNames.map((name) => ({ name, preset: name }))
      : await Promise.all(
          (args.scenes.length ? args.scenes : ["skewer"]).map((s) => loadScene(s, presetNames)),
        );

    for (const scene of scenes) {
      const out = resolve(
        args.out && scenes.length === 1 ? args.out : join(args.dir, `${scene.name}.png`),
      );
      const format = FORMATS[extname(out).toLowerCase()];
      if (!format) throw new Error(`unsupported output extension on ${out}`);

      const base64 = await page.evaluate(
        async ({ preset, config, width, height, time, mime, quality }) => {
          const { MaterialRenderer, PRESETS } = globalThis.m3d;
          const host = document.getElementById("host");
          host.replaceChildren();
          const renderer = new MaterialRenderer(host, preset ? PRESETS[preset]() : config, {
            // The scene must not be frozen to one pose by a headless profile's reduced-motion
            // default, or `time` would silently do nothing.
            respectReducedMotion: false,
            preserveDrawingBuffer: true,
          });
          try {
            renderer.setOutputSize({ width, height });
            const blob = await renderer.captureImage(mime, quality, time);
            return await new Promise((done) => {
              const reader = new FileReader();
              reader.addEventListener("load", () => done(String(reader.result).split(",")[1]), {
                once: true,
              });
              reader.readAsDataURL(blob);
            });
          } finally {
            renderer.dispose();
          }
        },
        {
          preset: scene.preset ?? null,
          config: scene.config ?? null,
          width: args.width,
          height: args.height,
          time: args.time,
          mime: format.mime,
          quality: format.lossy ? args.quality : undefined,
        },
      );

      await mkdir(dirname(out), { recursive: true });
      const bytes = Buffer.from(base64, "base64");
      await writeFile(out, bytes);
      console.log(`${out}  ${args.width}×${args.height}  ${(bytes.length / 1024).toFixed(0)} kB`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
