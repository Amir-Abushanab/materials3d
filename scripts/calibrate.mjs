/**
 * `pnpm calibrate <reference.png> [render.png] [--box x0,y0,x1,y1] [--step n]`
 *
 * Art-directing this renderer by eye repeatedly overshot. Measuring against a reference frame was
 * faster and more reliable, so the measurement ships as a tool rather than living in a notebook.
 *
 * Two numbers matter:
 *
 *   CLEAR-GLASS RATIO, the fraction of pixels that are near-neutral but bright (saturation < 0.18,
 *   lightness > 0.72), i.e. reading as *clear glass* rather than tinted. This is the metric that
 *   catches the failure the eye forgives: successive builds measured 27% → 34% → 37% → 44% against
 *   a 43% reference, and every one of them had looked "about right".
 *
 *   HUE HISTOGRAM, where the saturated pixels actually sit. This is how the palette was derived
 *   instead of guessed. The reference is warm (~39%), pink/magenta (~36%) and blue-violet (~21%),
 *   with green near zero and NO CYAN AT ALL, which is why a cosine palette sweeping full hue was
 *   wrong on the evidence.
 *
 * PNG only, and only the 8-bit non-interlaced flavour a browser's `canvas.toBlob("image/png")`
 * produces, decoded here with node:zlib so the tool has no dependencies. In Materials Studio,
 * shift-click "Save still" to get a PNG.
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { basename } from "node:path";
import { parseArgs, run } from "./lib/cli.mjs";

// --------------------------------------------------------------- PNG decode --

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG into `{ width, height, channels, data }`. */
function decodePng(buffer) {
  for (const [i, byte] of PNG_SIGNATURE.entries()) {
    if (buffer[i] !== byte) throw new Error("not a PNG file");
  }

  let offset = 8;
  let header;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length; // length + type + data + CRC
  }
  if (!header) throw new Error("PNG has no IHDR");
  if (header.depth !== 8) throw new Error(`unsupported bit depth ${header.depth} (need 8)`);
  if (header.interlace !== 0) throw new Error("interlaced PNGs are not supported");
  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : 0;
  if (channels === 0) {
    throw new Error(`unsupported colour type ${header.colorType} (need 2 = RGB or 6 = RGBA)`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  // Undo the per-scanline filters. Each row is prefixed with its filter byte and predicts from
  // the pixel to the left (a), the row above (b), and up-left (c).
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= channels ? out[prev + x - channels] : 0;
      let result;
      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + a;
          break;
        case 2:
          result = value + b;
          break;
        case 3:
          result = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      out[row + x] = result & 0xff;
    }
    src += stride;
  }
  return { width, height, channels, data: out };
}

// ----------------------------------------------------------------- measures --

/** HLS, matching Python's `colorsys.rgb_to_hls`: lightness is (max+min)/2. */
function rgbToHls(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, l, 0];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, l, s];
}

const HUE_BUCKETS = 18; // 20° each

function measure(image, box, step) {
  const [x0, y0, x1, y1] = box;
  const hues = Array.from({ length: HUE_BUCKETS }, () => 0);
  let clear = 0;
  let saturated = 0;
  let total = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * image.width + x) * image.channels;
      const [h, l, s] = rgbToHls(
        image.data[i] / 255,
        image.data[i + 1] / 255,
        image.data[i + 2] / 255,
      );
      total++;
      if (s < 0.18 && l > 0.72) clear++;
      // "Saturated" for the histogram: enough chroma to carry a readable hue, and not so dark or
      // blown out that the hue is noise.
      if (s >= 0.25 && l > 0.15 && l < 0.92) {
        saturated++;
        hues[Math.min(HUE_BUCKETS - 1, Math.floor(h / 20))]++;
      }
    }
  }
  return { total, clearPct: (100 * clear) / total, saturated, hues };
}

// ---------------------------------------------------------------- reporting --

function bar(fraction, width = 24) {
  const filled = Math.round(fraction * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function huePercents(m) {
  return m.hues.map((n) => (m.saturated > 0 ? (100 * n) / m.saturated : 0));
}

/** The families the palette was actually derived in, rather than raw 20° buckets. */
const FAMILIES = [
  ["warm (0–60°)", [0, 1, 2]],
  ["green (60–140°)", [3, 4, 5, 6]],
  ["cyan (140–200°)", [7, 8, 9]],
  ["blue-violet (200–300°)", [10, 11, 12, 13, 14]],
  ["pink/magenta (300–360°)", [15, 16, 17]],
];

function report(label, m) {
  console.log(`\n${label}`);
  console.log(`  sampled          ${m.total} px`);
  console.log(`  clear-glass      ${m.clearPct.toFixed(1)}%   ${bar(m.clearPct / 100)}`);
  console.log(`  saturated        ${m.saturated} px`);
  const pct = huePercents(m);
  for (const [name, buckets] of FAMILIES) {
    const share = buckets.reduce((sum, b) => sum + pct[b], 0);
    console.log(`  ${name.padEnd(24)} ${share.toFixed(1).padStart(5)}%  ${bar(share / 100, 18)}`);
  }
}

function compare(reference, render) {
  const delta = render.clearPct - reference.clearPct;
  const sign = delta >= 0 ? "+" : "";
  console.log("\ndelta (render − reference)");
  console.log(`  clear-glass      ${sign}${delta.toFixed(1)} pts`);
  const a = huePercents(reference);
  const b = huePercents(render);
  for (const [name, buckets] of FAMILIES) {
    const d = buckets.reduce((sum, i) => sum + b[i], 0) - buckets.reduce((sum, i) => sum + a[i], 0);
    console.log(`  ${name.padEnd(24)} ${(d >= 0 ? "+" : "") + d.toFixed(1)} pts`);
  }
  console.log(
    `\n${Math.abs(delta) <= 3 ? "within 3 pts of the reference" : "off the reference, the clear-glass ratio is the knob to chase (lamp gate, then density)"}`,
  );
}

// ---------------------------------------------------------------------- CLI --

const USAGE = `usage: pnpm calibrate <reference.png> [render.png] [--box x0,y0,x1,y1] [--step n]

Measures the clear-glass ratio and hue histogram of a PNG (8-bit, non-interlaced, as a browser's
canvas.toBlob produces), and with a second file the delta between them.

  --box x0,y0,x1,y1   the region to sample (default: the middle 70% band)
  --step n            sample every n-th pixel (default 5)`;

function boxFor(image, box) {
  if (!box) {
    // Default to the middle band: the subject sits there in every scene this renderer produces,
    // and including the full frame dilutes the ratio with plain backdrop.
    return [0, Math.round(image.height * 0.15), image.width, Math.round(image.height * 0.85)];
  }
  const [x0, y0, x1, y1] = box;
  return [Math.max(0, x0), Math.max(0, y0), Math.min(image.width, x1), Math.min(image.height, y1)];
}

await run(() => {
  const args = parseArgs(process.argv.slice(2), { step: 5, box: "" });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const files = args.positionals;
  if (files.length === 0) throw new Error(USAGE);
  const box = args.box ? args.box.split(",").map(Number) : undefined;
  if (box && (box.length !== 4 || box.some((n) => !Number.isFinite(n)))) {
    throw new Error("--box needs four numbers: x0,y0,x1,y1");
  }

  const images = files.map((file) => {
    try {
      return { file, image: decodePng(readFileSync(file)) };
    } catch (error) {
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
  });

  const measured = images.map(({ file, image }) => ({
    file,
    m: measure(image, boxFor(image, box), Math.max(1, args.step)),
  }));

  for (const { file, m } of measured) report(basename(file), m);
  if (measured.length >= 2) compare(measured[0].m, measured[1].m);
  console.log();
});
