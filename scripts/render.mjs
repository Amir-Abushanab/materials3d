/**
 * `pnpm render <scene> [options]`: a config to a PNG, without a studio.
 *
 * The renderer is WebGL, so there is no way to rasterize a scene without a browser; what there IS
 * is a browser we drive ourselves, headless, one explicit frame at a time. That distinction is the
 * whole point of this file. Driving the *studio* through a live page fails in ways that are hard
 * to even notice: `requestAnimationFrame` stops in a backgrounded tab, so the canvas quietly holds
 * a stale frame and every screenshot of it is a lie. Nothing here waits for a frame loop; it
 * calls `captureImage`, which seeks to a fixed time and renders once, synchronously.
 *
 * It goes through exactly the path the studio's "Save still" uses (`setOutputSize` then
 * `captureImage(mime, quality, time)`), so a headless render and a studio export of the same
 * config are the same image.
 *
 * Deterministic by construction: time defaults to 0, the frame a scene opens on, so re-rendering
 * a preset does not churn in git, and a visual diff means something actually changed.
 *
 *   pnpm render assembly                        → renders/assembly.png at 1920x1080
 *   pnpm render gallery/skewer.json -o hero.png
 *   pnpm render --all -d stills/ -w 1200 -h 630
 *   pnpm render slimes -t 2.5                   → the frame 2.5s in
 *   pnpm render skewer --clip 18.48 --fps 12    → renders/skewer.webp, an animated WebP that loops
 *   pnpm render --help
 *
 * `--clip` walks the scene one frame at a time through the same `captureImage` and muxes the
 * frames with the studio's own animated-WebP muxer (from the core build), so a headless clip and a
 * studio recording of one config are the same frames.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, RENDERS, launch, requireBuild, run, serve } from "./lib/harness.mjs";

const USAGE = `usage: pnpm render [<preset>|<config.json>]... [options]

  --all               render every preset
  -o, --out <file>    output file for a single scene; the extension picks png, webp or jpg
  -d, --dir <dir>     output directory (default renders/)
  -w, --width <px>    default 1920
  -h, --height <px>   default 1080 (-h is height here, not help)
  -t, --time <s>      scene time to capture (default 0)
  -q, --quality <q>   lossy quality 0..1 (default 0.94)
  --clip <s>          an animated WebP of this many seconds instead of a still; sets loopSeconds
                      to the clip length when the scene has none, so the motion closes
  --fps <n>           frames per second for --clip (default 12; durations are whole ms)
  --set <path>=<v>    write a dotted config path first (repeatable; prefix + to create it)
  --help              this text`;

const FORMATS = {
  ".png": { mime: "image/png", lossy: false },
  ".webp": { mime: "image/webp", lossy: true },
  ".jpg": { mime: "image/jpeg", lossy: true },
  ".jpeg": { mime: "image/jpeg", lossy: true },
};

/** Its own parser rather than the shared one: the short flags predate it, and `-h` is height. */
function parseArgs(argv) {
  const out = {
    scenes: [],
    width: 1920,
    height: 1080,
    time: 0,
    quality: 0.94,
    clip: 0,
    fps: 12,
    sets: [],
    dir: RENDERS,
    all: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--help") out.help = true;
    else if (a === "--all") out.all = true;
    else if (a === "-o" || a === "--out") out.out = next();
    else if (a === "-d" || a === "--dir") out.dir = next();
    else if (a === "-w" || a === "--width") out.width = Number(next());
    else if (a === "-h" || a === "--height") out.height = Number(next());
    else if (a === "-t" || a === "--time") out.time = Number(next());
    else if (a === "-q" || a === "--quality") out.quality = Number(next());
    else if (a === "--clip") out.clip = Number(next());
    else if (a === "--fps") out.fps = Number(next());
    else if (a === "--set") out.sets.push(parseSet(next()));
    else if (a.startsWith("-")) throw new Error(`unknown option ${a} (--help for usage)`);
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
  if (!Number.isFinite(out.clip) || out.clip < 0)
    throw new Error("clip must be a number of seconds");
  if (!Number.isFinite(out.fps) || out.fps <= 0) throw new Error("fps must be positive");
  return out;
}

/** `path=value`, the value as JSON where it parses (numbers, booleans, objects) and text otherwise. */
function parseSet(spec) {
  const at = spec?.indexOf("=") ?? -1;
  if (at < 1) throw new Error(`--set wants path=value, got ${spec}`);
  const path = spec.slice(0, at);
  const raw = spec.slice(at + 1);
  try {
    return [path, JSON.parse(raw)];
  } catch {
    return [path, raw];
  }
}

/** A scene argument is either a preset name or a path to a config file. */
async function loadScene(scene, presetNames) {
  if (presetNames.includes(scene)) return { name: scene, preset: scene };
  const path = resolve(scene);
  if (!existsSync(path)) {
    throw new Error(`no preset or file called "${scene}"; presets are: ${presetNames.join(", ")}`);
  }
  return { name: basename(path, extname(path)), config: JSON.parse(await readFile(path, "utf8")) };
}

await run(async (defer) => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  requireBuild();
  const muxer = resolve(DIST, "studio/webpMux.js");
  if (args.clip && !existsSync(muxer)) {
    throw new Error(
      `--clip needs the core build for its muxer (${muxer})\nRun: pnpm --filter @materials3d/core build`,
    );
  }

  const server = await serve();
  defer(server.close);
  const { page, check, close } = await launch();
  defer(close);
  await page.goto(server.url);
  check();

  const presetNames = await page.evaluate(async (url) => {
    const mod = await import(url);
    globalThis.m3d = mod;
    return Object.keys(mod.PRESETS);
  }, `${server.url}bundle.js`);
  // A page error here means the bundle threw on import; without this it surfaces much later as
  // an inscrutable "renderer is undefined".
  check();

  const gl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const ctx = c.getContext("webgl2") || c.getContext("webgl");
    return ctx ? ctx.getParameter(ctx.VERSION) : null;
  });
  if (!gl) throw new Error("headless Chromium has no WebGL context; cannot render");

  const scenes = args.all
    ? presetNames.map((name) => ({ name, preset: name }))
    : await Promise.all(
        (args.scenes.length ? args.scenes : ["skewer"]).map((s) => loadScene(s, presetNames)),
      );

  const frames = args.clip ? Math.max(1, Math.round(args.clip * args.fps)) : 1;
  for (const scene of scenes) {
    const out = resolve(
      args.out && scenes.length === 1
        ? args.out
        : join(args.dir, `${scene.name}.${args.clip ? "webp" : "png"}`),
    );
    const format = FORMATS[extname(out).toLowerCase()];
    if (!format) throw new Error(`unsupported output extension on ${out}`);
    if (args.clip && format.mime !== "image/webp") {
      throw new Error(`--clip writes an animated WebP; use a .webp output, not ${out}`);
    }

    const captures = await page.evaluate(
      async ({ preset, config, sets, width, height, time, mime, quality, count, fps, clip }) => {
        const { MaterialRenderer, PRESETS, ensureSceneConfig } = globalThis.m3d;
        const cfg = ensureSceneConfig(preset ? PRESETS[preset]() : config);
        for (const [path, value] of sets) globalThis.m3dHelpers.put(cfg, path, value);
        // A clip loops, so every rate is snapped to whole cycles over its length unless the
        // scene already names a loop of its own.
        if (count > 1 && !(cfg.loopSeconds > 0)) cfg.loopSeconds = clip;
        const host = document.getElementById("host");
        host.replaceChildren();
        const renderer = new MaterialRenderer(host, cfg, {
          // The scene must not be frozen to one pose by a headless profile's reduced-motion
          // default, or `time` would silently do nothing.
          respectReducedMotion: false,
          preserveDrawingBuffer: true,
        });
        // Runs in the browser, so it cannot live at module scope.
        // oxlint-disable-next-line unicorn/consistent-function-scoping
        const toBase64 = (blob) =>
          new Promise((done) => {
            const reader = new FileReader();
            reader.addEventListener("load", () => done(String(reader.result).split(",")[1]), {
              once: true,
            });
            reader.readAsDataURL(blob);
          });
        try {
          renderer.setOutputSize({ width, height });
          const list = [];
          for (let i = 0; i < count; i++) {
            list.push(await toBase64(await renderer.captureImage(mime, quality, time + i / fps)));
          }
          return list;
        } finally {
          renderer.dispose();
        }
      },
      {
        preset: scene.preset ?? null,
        config: scene.config ?? null,
        sets: args.sets,
        width: args.width,
        height: args.height,
        time: args.time,
        mime: format.mime,
        quality: format.lossy ? args.quality : undefined,
        count: frames,
        fps: args.fps,
        clip: args.clip,
      },
    );

    await mkdir(dirname(out), { recursive: true });
    let bytes;
    if (args.clip) {
      const { encodeAnimatedWebp } = await import(pathToFileURL(muxer).href);
      const durationMs = 1000 / args.fps;
      const blob = encodeAnimatedWebp(
        captures.map((b) => ({ file: new Uint8Array(Buffer.from(b, "base64")), durationMs })),
        args.width,
        args.height,
      );
      bytes = Buffer.from(await blob.arrayBuffer());
    } else {
      bytes = Buffer.from(captures[0], "base64");
    }
    await writeFile(out, bytes);
    const clipNote = args.clip ? `  ${frames} frames at ${args.fps} fps` : "";
    console.log(
      `${out}  ${args.width}x${args.height}${clipNote}  ${(bytes.length / 1024).toFixed(0)} kB`,
    );
  }
});
