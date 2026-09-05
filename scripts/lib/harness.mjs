/**
 * The browser side of the scripts: an HTTP server for the build outputs, a Playwright page that
 * reports what breaks inside it, and the pixel helpers the pages run.
 *
 * Nine scripts carried their own copy of the server and the page boot; this is the one place
 * either lives now. The path constants and CLI helpers are re-exported so a browser script needs
 * a single import.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { chromium } from "playwright";
import { BUNDLE, DIST, RENDERS, STUDIO_PUBLIC, threeBuildDir } from "./paths.mjs";

export * from "./paths.mjs";
export * from "./cli.mjs";

/** Content types for what the studio's public dir actually holds. */
const ASSET_TYPES = {
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/** One full-window host, which is what the single-renderer scripts want. */
const HOST_HTML = `<!doctype html><meta charset=utf-8><style>html,body{margin:0}#host{position:fixed;inset:0}</style><div id=host></div>`;

/** Two hosts side by side, `#a` and `#b`, each `width` by `height`, for the engine-versus-engine scripts. */
export const sideBySideHtml = (width, height) =>
  `<!doctype html><meta charset=utf-8><style>html,body{margin:0}` +
  `#a,#b{position:absolute;top:0;width:${width}px;height:${height}px}#a{left:0}#b{left:${width}px}` +
  `</style><div id=a></div><div id=b></div>`;

/**
 * Serve the build outputs to a page on a loopback port.
 *
 * The standalone bundle is an ES module, and a file:// page cannot import one: its origin is
 * opaque, so the import is blocked before anything runs. The unbundled dist chunks import three by
 * bare specifier, so they are rewritten on the way out to point at three's own builds, served from
 * the same origin.
 *
 *   /bundle.js       the standalone bundle, served as is
 *   /dist/<path>.js  packages/core/dist
 *   /<file>.js       three's build directory
 *   /<asset>         apps/studio/public, when the file is there
 *   anything else    `html`
 *
 * The asset case is what lets a scene naming `/knot.glb` render here as it does in the studio.
 * Without it every non-`.js` request answered with the host HTML, so a `model` shape fetched a
 * page, failed to parse it, and drew the placeholder sphere: a still of the wrong scene with
 * nothing on the image to say so.
 */
export async function serve({ html = HOST_HTML } = {}) {
  const threeBuild = threeBuildDir();
  const server = createServer(async (req, res) => {
    const name = (req.url ?? "/").split("?")[0];
    if (!name.endsWith(".js")) {
      const asset = resolve(STUDIO_PUBLIC, name.slice(1));
      // Inside the public dir and actually there, or it is a page request. The containment check
      // is what stops a `..` in the path from serving the repo.
      const contained = !relative(STUDIO_PUBLIC, asset).startsWith("..");
      if (name.length > 1 && contained && existsSync(asset)) {
        const type = ASSET_TYPES[extname(asset)] ?? "application/octet-stream";
        return res.writeHead(200, { "content-type": type }).end(await readFile(asset));
      }
      return res.writeHead(200, { "content-type": "text/html" }).end(html);
    }
    const bundle = name === "/bundle.js";
    const from = bundle
      ? BUNDLE
      : name.startsWith("/dist/")
        ? resolve(DIST, name.slice("/dist/".length))
        : resolve(threeBuild, name.slice(1));
    try {
      let code = await readFile(from, "utf8");
      if (!bundle) {
        code = code
          .replace(/from\s*["']three\/webgpu["']/g, 'from "/three.webgpu.js"')
          .replace(/from\s*["']three["']/g, 'from "/three.module.js"');
      }
      res.writeHead(200, { "content-type": "text/javascript" }).end(code);
    } catch (error) {
      res.writeHead(404).end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

/**
 * Pixel helpers for the page.
 *
 * A `page.evaluate` callback is serialized into the browser and can only reference what the page
 * already has, so these are installed as source before navigation (see `launch`) and reached as
 * `globalThis.m3dHelpers` from inside any callback. They must stay self-contained.
 */
const pageHelpers = {
  /**
   * Write a dotted path into a config, creating nothing: a typo surfaces as an error rather than
   * as a field the renderer ignores. A leading `+` means CREATE, for sparse blocks such as an
   * item's `material`, where an unauthored knob has no path to write to.
   */
  put: (object, path, value) => {
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
  },
  /** Mean brightness and the share of lit pixels of an RGBA buffer: did it draw anything at all. */
  litStats: (px) => {
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      const v = Math.max(px[i], px[i + 1], px[i + 2]);
      sum += v;
      if (v > 4) lit++;
    }
    const n = px.length / 4;
    return { mean: sum / n, litPct: (100 * lit) / n };
  },
  /**
   * Compare two same-size RGBA buffers: the worst channel difference per pixel, averaged and at
   * its maximum, the share of pixels off by more than four levels, each side's brightness and
   * saturation, and a diff image amplified so a difference that matters is visible rather than
   * merely present.
   */
  frameDiff: (A, B) => {
    const n = A.length / 4;
    const image = new Uint8ClampedArray(A.length);
    let total = 0;
    let worst = 0;
    let over = 0;
    let sumA = 0;
    let sumB = 0;
    let satA = 0;
    let satB = 0;
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.max(
        Math.abs(A[i] - B[i]),
        Math.abs(A[i + 1] - B[i + 1]),
        Math.abs(A[i + 2] - B[i + 2]),
      );
      total += d;
      if (d > worst) worst = d;
      if (d > 4) over++;
      const maxA = Math.max(A[i], A[i + 1], A[i + 2]);
      const maxB = Math.max(B[i], B[i + 1], B[i + 2]);
      sumA += maxA;
      sumB += maxB;
      // Saturation as max minus min, which is what "washed out" means numerically.
      satA += maxA - Math.min(A[i], A[i + 1], A[i + 2]);
      satB += maxB - Math.min(B[i], B[i + 1], B[i + 2]);
      const v = Math.min(255, d * 4);
      image[i] = v;
      image[i + 1] = v;
      image[i + 2] = v;
      image[i + 3] = 255;
    }
    return {
      mean: total / n,
      worst,
      overPct: (100 * over) / n,
      brightnessA: sumA / n,
      brightnessB: sumB / n,
      saturationA: satA / n,
      saturationB: satB / n,
      image,
    };
  },
};

const PAGE_HELPERS_SOURCE = `globalThis.m3dHelpers = {\n${Object.entries(pageHelpers)
  .map(([name, fn]) => `  ${name}: ${fn.toString()}`)
  .join(",\n")}\n};`;

/**
 * A page that collects what goes wrong inside it instead of throwing from an event handler.
 *
 * A throw inside `page.on("pageerror")` escapes as an unhandled rejection, which skips every
 * `finally` on the way out and leaves a browser and a server running. Errors are collected and
 * printed as they happen; `check()` throws with the page errors, so call it after `goto` and after
 * any evaluate whose failure would otherwise surface later as an inscrutable undefined. Console
 * errors are kept apart: for the parity tools a shader compile failure is a diagnostic that the
 * per-case results already account for.
 *
 * `headed` runs real Chrome rather than the bundled headless Chromium, for the scripts that need a
 * hardware GPU: headless Chromium serves WebGPU from a software adapter.
 */
export async function launch({ width = 1280, height = 720, headed = false } = {}) {
  const browser = await chromium.launch(headed ? { channel: "chrome", headless: false } : {});
  const page = await browser.newPage({ viewport: { width, height } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => {
    const text = error.message.slice(0, 300);
    pageErrors.push(text);
    console.error(`PAGE: ${text}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // three warns about `renderAsync` on every frame; it is not a failure and drowns the rest.
    if (/renderAsync/.test(text)) return;
    consoleErrors.push(text.slice(0, 600));
    console.error(`CONSOLE: ${text.slice(0, 600)}`);
  });
  await page.addInitScript(PAGE_HELPERS_SOURCE);
  return {
    browser,
    page,
    pageErrors,
    consoleErrors,
    check() {
      if (pageErrors.length > 0)
        throw new Error(`page error: ${[...new Set(pageErrors)].join("\n")}`);
    },
    close: () => browser.close(),
  };
}

/** The preset names the bundle exports, read in the page, so a typo fails with the list. */
export function presetNames(page, url) {
  return page.evaluate(
    async (base) => Object.keys((await import(base + "bundle.js")).PRESETS),
    url,
  );
}

/** Every name must be a preset; the error lists the valid ones rather than crashing on `undefined()`. */
export function assertPresets(names, valid) {
  const unknown = names.filter((name) => !valid.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `no preset called ${unknown.map((name) => `"${name}"`).join(", ")}; presets are: ${valid.join(", ")}`,
    );
  }
}

/** An output directory, created on demand. A relative path resolves from the working directory. */
export async function outputDir(dir = RENDERS) {
  const abs = resolve(dir);
  await mkdir(abs, { recursive: true });
  return abs;
}

/** Write a canvas `toDataURL()` result to disk. */
export function writeDataUrl(path, dataUrl) {
  return writeFile(path, Buffer.from(dataUrl.split(",")[1], "base64"));
}
