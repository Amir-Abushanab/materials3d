/**
 * Compare a LIVE frame from each engine, at an identical scene time.
 *
 *   pnpm tsl:live                 # prism
 *   pnpm tsl:live cascade
 *
 * Env: OUT=<dir> to write the images, NODUST=1 to take the dust out.
 *
 * WHY THIS EXISTS ALONGSIDE `tsl-compare`. That harness compares through `captureImage`, which is
 * NOT the path a person watches: it applies each binding's REST value, resets the interaction
 * camera and renders one frame on demand. This drives both engines' own rAF loops, pauses the
 * clock, seeks both to the same time, and photographs the result.
 *
 * The difference is not academic. The dust light-field tap was sampling the pyramid mirrored, which
 * lit every grain from the wrong half of the frame. It was worth 1.4 here and almost nothing
 * through `captureImage`, so every static comparison called it fine — it was found by a person
 * looking at the studio and saying the light seemed off.
 *
 * A COMPOSITED SCREENSHOT, not a canvas readback. A WebGPU surface without a preserved drawing
 * buffer reads back empty outside the rAF that presented it, and the first version of this script
 * duly measured the node engine as pure black.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const THREE_BUILD = resolve("node_modules/.pnpm/three@0.185.1/node_modules/three/build");
const DIST = resolve("packages/core/dist");
const BUNDLE = resolve(DIST, "standalone/materials3d.standalone.js");
const preset = process.argv[2] ?? "prism";
const W = 1064,
  H = 598;
const server = createServer(async (q, r) => {
  const n = (q.url ?? "/").split("?")[0];
  if (n === "/bundle.js")
    return r
      .writeHead(200, { "content-type": "text/javascript" })
      .end(await readFile(BUNDLE, "utf8"));
  if (n.endsWith(".js")) {
    const from = n.startsWith("/dist/")
      ? resolve(DIST, n.slice(6))
      : resolve(THREE_BUILD, n.slice(1));
    try {
      const code = (await readFile(from, "utf8"))
        .replace(/from\s*["']three\/webgpu["']/g, 'from "/three.webgpu.js"')
        .replace(/from\s*["']three["']/g, 'from "/three.module.js"');
      return r.writeHead(200, { "content-type": "text/javascript" }).end(code);
    } catch {
      return r.writeHead(404).end();
    }
  }
  r.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><meta charset=utf-8><style>html,body{margin:0}#a,#b{position:absolute;top:0;width:${W}px;height:${H}px}#a{left:0}#b{left:${W}px}</style><div id=a></div><div id=b></div>`,
  );
});
await new Promise((d) => server.listen(0, "127.0.0.1", d));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: W * 2, height: H } });
page.on("pageerror", (e) => console.error("PAGE:", e.message.slice(0, 200)));
await page.goto(url);
await page.evaluate(
  async ([base, name, noDust]) => {
    const gl = await import(base + "bundle.js");
    const { NodeMaterialRenderer } = await import(base + "dist/renderer/NodeMaterialRenderer.js");
    const A = document.getElementById("a"),
      B = document.getElementById("b");
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
    await new Promise((d) => setTimeout(d, 5000));
    a.seek(3.0);
    b.seek(3.0);
    await new Promise((d) => setTimeout(d, 2000));
  },
  [url, preset, process.env.NODUST === "1"],
);

// A COMPOSITED screenshot, not a canvas readback: a WebGPU surface without a preserved drawing
// buffer reads back empty outside the rAF that presented it, which is how the first attempt
// measured this engine as pure black.
const shot = await page.screenshot();
const out = process.env.OUT ?? ".";
await writeFile(`${out}/live-${preset}-page.png`, shot);
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
    const ca = cut(0),
      cb = cut(w);
    const pa = ca.getContext("2d").getImageData(0, 0, w, h).data;
    const pb = cb.getContext("2d").getImageData(0, 0, w, h).data;
    const d = document.createElement("canvas");
    d.width = w;
    d.height = h;
    const im = d.getContext("2d").createImageData(w, h);
    let tot = 0,
      worst = 0,
      over = 0,
      sa = 0,
      sb = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const v = Math.max(
        Math.abs(pa[i] - pb[i]),
        Math.abs(pa[i + 1] - pb[i + 1]),
        Math.abs(pa[i + 2] - pb[i + 2]),
      );
      tot += v;
      worst = Math.max(worst, v);
      if (v > 4) over++;
      sa += Math.max(pa[i], pa[i + 1], pa[i + 2]);
      sb += Math.max(pb[i], pb[i + 1], pb[i + 2]);
      const s = Math.min(255, v * 4);
      im.data[i] = s;
      im.data[i + 1] = s;
      im.data[i + 2] = s;
      im.data[i + 3] = 255;
    }
    d.getContext("2d").putImageData(im, 0, 0);
    const n = pa.length / 4;
    return {
      stats: `mean|d| ${(tot / n).toFixed(2)}  worst ${worst}  pixels>4 ${((100 * over) / n).toFixed(1)}%  brightness ${(sa / n).toFixed(1)} / ${(sb / n).toFixed(1)}`,
      glsl: ca.toDataURL(),
      tsl: cb.toDataURL(),
      diff: d.toDataURL(),
    };
  },
  ["data:image/png;base64," + shot.toString("base64"), W, H],
);
console.log(" ", res.stats);
for (const k of ["glsl", "tsl", "diff"])
  await writeFile(`${out}/live-${preset}-${k}.png`, Buffer.from(res[k].split(",")[1], "base64"));
await browser.close();
server.close();
