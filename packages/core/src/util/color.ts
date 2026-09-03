/**
 * Colour parsing for Materials3D, deliberately *not* three's `Color`.
 *
 * three r152+ runs colour management by default: `new Color("#f8c852")` converts sRGB to the
 * linear working space on parse, and the renderer converts back on output. That round trip is
 * lossless for a colour on its own, but every piece of MATH in between then happens in linear
 * space, and Materials3D's look was calibrated in display space (see the clear-glass ratio and hue
 * histogram in the technique notes). Beer–Lambert absorption, the chroma-vs-brightness split and
 * the DOF/bloom gathers all change character when you move them to linear.
 *
 * So the whole pass chain stays in display (sRGB) space, end to end, and colour management is
 * bypassed rather than fought:
 *   - colours reach the shaders as raw sRGB components through {@link parseHex} (Vector3, no Color),
 *   - clear colours are written straight into a `Color`'s fields by {@link setRaw} (no conversion),
 *   - the intermediate render targets are `NoColorSpace`, so sampling them returns what was stored,
 *   - the post pass writes display-referred values to a drawing buffer that is already tagged sRGB.
 *
 * The one thing you must not do is hand a `new THREE.Color(hex)` to a Materials3D uniform: that value
 * is linear, and the glass will read washed out and green-shifted.
 */

/** RGB in display (sRGB) space, each component 0–1. */
export type RGB = readonly [number, number, number];

const HEX3 = /^#?([\da-f])([\da-f])([\da-f])$/i;
const HEX6 = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

/**
 * Parse `"#rgb"`, `"#rrggbb"` or a `0xrrggbb` number into raw sRGB components (0–1).
 * Unparseable input falls back to white rather than throwing, a bad colour in a config should
 * make one shape wrong, not take the page down.
 */
export function parseHex(hex: string | number): RGB {
  if (typeof hex === "number") {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }
  const long = HEX6.exec(hex);
  if (long) {
    return [
      Number.parseInt(long[1], 16) / 255,
      Number.parseInt(long[2], 16) / 255,
      Number.parseInt(long[3], 16) / 255,
    ];
  }
  const short = HEX3.exec(hex);
  if (short) {
    return [
      Number.parseInt(short[1] + short[1], 16) / 255,
      Number.parseInt(short[2] + short[2], 16) / 255,
      Number.parseInt(short[3] + short[3], 16) / 255,
    ];
  }
  return [1, 1, 1];
}

function byteHex(v: number): string {
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, "0");
}

/** Format raw sRGB components (0–1) back to `"#rrggbb"`. */
export function toHex(rgb: RGB): string {
  return `#${byteHex(rgb[0])}${byteHex(rgb[1])}${byteHex(rgb[2])}`;
}

/** HSL (h in degrees, s/l in 0–1) from raw sRGB components, the studio's colour maths. */
export function rgbToHsl(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}
