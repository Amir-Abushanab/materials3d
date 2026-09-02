/**
 * `pnpm sweep <scene> <path>=<v,v,v> [<path>=<v,v,v>] [options]` — one contact sheet, many values.
 *
 * Built for the edit loop rather than for output. Tuning a scene means asking "which of these" far
 * more often than "is this one right", and answering that by rendering one PNG per guess is the
 * slow way round: a browser launch and a page load per frame, and one picture per round trip. This
 * launches once, renders every variant into a labelled grid, and hands back a single image.
 *
 * That matters most when the thing being tuned is SOLVED rather than shaded. A beam's route through
 * a chain of solids survives only a few degrees of aim, so finding it is a search — and a search
 * wants a contact sheet, not a sequence of stills.
 *
 *   pnpm sweep orb +items.0.material.magnify=0,0.5,1
 *   pnpm sweep orb plate.z=-2,-6,-14 +items.0.material.magnify=0,1
 *   pnpm sweep gallery/prism.json post.bloom=0,0.3,0.7 -o bloom.png
 *   pnpm sweep orb +items.0.material.magnify=0,0.5,1     # + creates a missing override
 *
 * One path sweeps a row; two make a grid, the first across and the second down. Values are parsed
 * as JSON when they can be, so `true`, `0.5` and `"#ff0000"` all work.
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE = resolve(ROOT, "packages/core/dist/standalone/materials3d.standalone.js");

/** Per-cell size. Small on purpose: a contact sheet is for comparing, not for pixel-peeping, and
 *  twelve full-size frames is a slow render and an image too big to take in at once. */
const CELL = { width: 480, height: 280 };

function parseArgs(argv) {
  const out = { scene: null, axes: [], cell: { ...CELL }, time: 0, out: "sweep.png" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "-o" || a === "--out") out.out = next();
    else if (a === "-w" || a === "--width") out.cell.width = Number(next());
    else if (a === "-h" || a === "--height") out.cell.height = Number(next());
    else if (a === "-t" || a === "--time") out.time = Number(next());
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (a.includes("=")) {
      const at = a.indexOf("=");
      const path = a.slice(0, at);
      const values = a
        .slice(at + 1)
        .split(",")
        .map((v) => {
          try {
            return JSON.parse(v);
          } catch {
            return v;
          }
        });
      if (values.length === 0) throw new Error(`no values for ${path}`);
      out.axes.push({ path, values });
    } else if (!out.scene) out.scene = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!out.scene) throw new Error("a preset name or config path is required");
  if (out.axes.length === 0) throw new Error("at least one <path>=<v,v,v> sweep is required");
  if (out.axes.length > 2) throw new Error("at most two sweep axes (a grid has two dimensions)");
  return out;
}

async function serveBundle() {
  const code = await readFile(BUNDLE, "utf8");
  const page = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#111} #host{position:fixed;inset:0}
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
    page.on("pageerror", (error) => {
      throw new Error(`page error: ${error.message}`);
    });
    await page.goto(server.url);
    const presetNames = await page.evaluate(async (url) => {
      globalThis.m3d = await import(url);
      return Object.keys(globalThis.m3d.PRESETS);
    }, `${server.url}materials3d.standalone.js`);

    let base = null;
    if (!presetNames.includes(args.scene)) {
      const path = resolve(args.scene);
      if (!existsSync(path)) {
        throw new Error(
          `no preset or file called "${args.scene}" — presets are: ${presetNames.join(", ")}`,
        );
      }
      base = JSON.parse(await readFile(path, "utf8"));
    }

    const label = basename(args.scene, extname(args.scene));
    const base64 = await page.evaluate(
      async ({ preset, config, axes, cell, time }) => {
        const { MaterialRenderer, PRESETS, ensureSceneConfig } = globalThis.m3d;
        const host = document.getElementById("host");
        const cols = axes[0].values.length;
        const rows = axes[1] ? axes[1].values.length : 1;

        /**
         * Write a dotted path into a config, creating nothing — a typo should surface as an error
         * rather than as a new field the renderer ignores in silence.
         *
         * Declared inside the evaluate callback and not hoisted, despite capturing nothing: this
         * whole function is serialized and run in the browser, so anything it calls has to be
         * defined within it.
         */
        // oxlint-disable-next-line unicorn/consistent-function-scoping
        const put = (object, path, value) => {
          // A leading `+` means CREATE. An item's `material` is a sparse override set — absent
          // means "take the resolved default" — so a knob that has never been authored has no path
          // to write to, and refusing is right for a typo and wrong for adding an override.
          const create = path.startsWith("+");
          if (create) path = path.slice(1);
          const keys = path.split(".");
          let node = object;
          for (const key of keys.slice(0, -1)) {
            if (node?.[key] === undefined) throw new Error(`no such config path: ${path}`);
            node = node[key];
          }
          const last = keys[keys.length - 1];
          if (!create && node?.[last] === undefined) {
            throw new Error(`no such config path: ${path} (prefix with + to create it)`);
          }
          node[last] = value;
        };

        const sheet = document.createElement("canvas");
        sheet.width = cell.width * cols;
        sheet.height = cell.height * rows;
        const ctx = sheet.getContext("2d");
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, sheet.width, sheet.height);

        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const scene = ensureSceneConfig(preset ? PRESETS[preset]() : structuredClone(config));
            put(scene, axes[0].path, axes[0].values[col]);
            if (axes[1]) put(scene, axes[1].path, axes[1].values[row]);
            host.replaceChildren();
            const renderer = new MaterialRenderer(host, scene, {
              respectReducedMotion: false,
              preserveDrawingBuffer: true,
            });
            let bitmap;
            try {
              renderer.setOutputSize(cell);
              bitmap = await createImageBitmap(await renderer.captureImage("image/png", 1, time));
            } finally {
              renderer.dispose();
            }
            const x = col * cell.width;
            const y = row * cell.height;
            ctx.drawImage(bitmap, x, y, cell.width, cell.height);
            bitmap.close();

            // Labelled in the image itself. A grid whose cells are only identifiable by counting
            // is one you have to hold the axis order in your head to read.
            // oxlint-disable-next-line unicorn/consistent-function-scoping
            const short = (p) => p.replace(/^\+/, "").split(".").pop();
            const text =
              `${short(axes[0].path)} ${axes[0].values[col]}` +
              (axes[1] ? `  ·  ${short(axes[1].path)} ${axes[1].values[row]}` : "");
            ctx.font = "600 13px ui-monospace, monospace";
            const w = ctx.measureText(text).width;
            ctx.fillStyle = "rgba(0,0,0,0.66)";
            ctx.fillRect(x + 6, y + 6, w + 12, 22);
            ctx.fillStyle = "#fff";
            ctx.fillText(text, x + 12, y + 21);
            ctx.strokeStyle = "rgba(255,255,255,0.16)";
            ctx.strokeRect(x + 0.5, y + 0.5, cell.width - 1, cell.height - 1);
          }
        }

        const blob = await new Promise((done) => sheet.toBlob(done, "image/png"));
        return await new Promise((done) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => done(String(reader.result).split(",")[1]), {
            once: true,
          });
          reader.readAsDataURL(blob);
        });
      },
      {
        preset: base ? null : args.scene,
        config: base,
        axes: args.axes,
        cell: args.cell,
        time: args.time,
      },
    );

    const out = resolve(args.out);
    await mkdir(dirname(out), { recursive: true });
    const bytes = Buffer.from(base64, "base64");
    await writeFile(out, bytes);
    const cells = args.axes.reduce((n, a) => n * a.values.length, 1);
    console.log(
      `  ${out}  ${cells} cells of ${label}  ${args.axes.map((a) => a.path).join(" x ")}  ${Math.round(bytes.length / 1024)} kB`,
    );
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
