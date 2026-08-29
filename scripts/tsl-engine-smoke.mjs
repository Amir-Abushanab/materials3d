/**
 * Drives the node engine end to end through the same shell entry a consumer uses, and checks that
 * the composed frame is a picture rather than a blank.
 *
 *   node scripts/tsl-engine-smoke.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const THREE_BUILD = resolve("node_modules/.pnpm/three@0.185.1/node_modules/three/build");
const DIST = resolve("packages/core/dist");
const server = createServer(async (q, r) => {
  const name = (q.url ?? "/").split("?")[0];
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
    `<!doctype html><meta charset=utf-8><style>html,body{margin:0}#host{position:fixed;inset:0}</style><div id=host></div>`,
  );
});
await new Promise((d) => server.listen(0, "127.0.0.1", d));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 380 } });
page.on("pageerror", (e) => console.error("PAGE:", e.message.slice(0, 240)));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE:", m.text().slice(0, 300));
});
await page.goto(url);

const result = await page.evaluate(async (base) => {
  const { NodeMaterialRenderer } = await import(base + "dist/renderer/NodeMaterialRenderer.js");
  const { PRESETS } = await import(base + "dist/presets.js");
  const host = document.getElementById("host");
  const out = [];
  const saved = {};
  // Bracket notation: see the matching note in `tsl-parity`.
  globalThis["__tslDebug"] = new URL(location.href).searchParams.get("dbg") ?? undefined;
  for (const name of ["prism", "skewer"]) {
    try {
      host.replaceChildren();
      const r = new NodeMaterialRenderer(host, PRESETS[name](), { respectReducedMotion: false });
      const blob = await r.captureImage("image/png", 0.9, 0);
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      let nonzero = 0;
      for (let i = 0; i < px.length; i += 4) {
        const v = Math.max(px[i], px[i + 1], px[i + 2]);
        sum += v;
        if (v > 4) nonzero++;
      }
      const total = px.length / 4;
      out.push(
        `  ${name.padEnd(8)} ${c.width}x${c.height}  mean ${(sum / total).toFixed(1)}` +
          `  lit ${((nonzero / total) * 100).toFixed(1)}%`,
      );
      out.push(`           png ${blob.size} bytes`);
      saved[name] = c.toDataURL();
      r.dispose();
    } catch (e) {
      out.push(`  ${name.padEnd(8)} THREW ${String(e.message).slice(0, 160)}`);
    }
  }
  return { text: out.join("\n"), images: saved };
}, url);
console.log(result.text);
const { writeFile } = await import("node:fs/promises");
for (const [name, data] of Object.entries(result.images ?? {})) {
  await writeFile(`/tmp/tsl-${name}.png`, Buffer.from(data.split(",")[1], "base64"));
  console.log(`  saved /tmp/tsl-${name}.png`);
}
await browser.close();
server.close();
