/**
 * Turning what someone pasted into path data.
 *
 * Two jobs, both pure string work — no three, so the config normalizer can do them at the boundary
 * where untrusted JSON arrives rather than deferring to the renderer.
 *
 * The premise is that people paste what they HAVE. What they have is an `.svg` file, or a fragment
 * copied out of a design tool, and the `d` attribute is buried inside it. Asking them to open the
 * file, find the `<path>` and copy one attribute out is a manual step for something a regex does
 * exactly as well.
 */

/** `<path … d="…">`, in either quote style, with any attribute order. */
const PATH_ELEMENT = /<path\b[^>]*?\sd\s*=\s*(["'])([\s\S]*?)\1/gi;

/** The command letters of SVG path data — the only safe places to cut it. */
const COMMAND = /[MmZzLlHhVvCcSsQqTtAa]/;

/**
 * The path data in `input`, whether it arrived as markup or as a bare `d`.
 *
 * Every `<path>` in document order, joined — which lands exactly on the outline-then-holes
 * contract the parser already has, because that is the order a vector tool writes a shape and its
 * counters in. Anything that is not a `<path>` is not read: `<circle>`, `<rect>` and `<polygon>`
 * are each a different attribute set, and half-supporting five elements would mean a paste that
 * silently loses part of the drawing rather than one that visibly does nothing.
 *
 * `transform` attributes are ignored, and mostly do not matter: a translate or a scale is absorbed
 * by the refit downstream, since that recentres and rescales whatever it is given. A rotate or a
 * skew is not, and a drawing that depends on one comes out unrotated — flatten it in the tool.
 */
export function extractPathData(input: string): string {
  // No angle bracket, no markup: it is already path data, and running the regex over it would
  // return nothing rather than leaving it alone.
  if (!input.includes("<")) return input.trim();
  const found: string[] = [];
  for (const match of input.matchAll(PATH_ELEMENT)) found.push(match[2].trim());
  return found.join(" ").trim();
}

/**
 * Shorten path data to `max` characters, cutting only between commands.
 *
 * A blind `slice` can land inside a number — `L45.6` becomes `L45.` — and one truncated
 * coordinate poisons its whole contour, so the shape does not come out shortened, it comes out
 * GONE, replaced by the default outline with nothing to say why. Cutting back to the last command
 * letter loses a little of the tail and keeps the rest drawable, which is the failure worth having.
 */
export function capPathData(d: string, max: number): string {
  if (d.length <= max) return d;
  const cut = d.slice(0, max);
  // Back up to the start of the last command, dropping it: its arguments are what got cut.
  for (let i = cut.length - 1; i >= 0; i--) {
    if (COMMAND.test(cut[i])) return cut.slice(0, i).trim();
  }
  return "";
}
