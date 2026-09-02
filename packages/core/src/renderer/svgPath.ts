/**
 * SVG path data, tessellated into closed polylines.
 *
 * The `path` shape kind exists so a silhouette that is not a lathe and not a rounded rectangle —
 * a pair of spectacles, a logo, a leaf — can be authored the way silhouettes are actually drawn:
 * in a vector tool, copied out as a `d` attribute. Everything downstream of here already handles
 * arbitrary outlines, because `slab` and `arrow` are extruded 2D contours too; the only thing
 * missing was a way to SAY one in JSON.
 *
 * A subset, deliberately. `d` is a drawing language with a stroke model, fill rules and open
 * subpaths, and none of that survives extrusion into a solid — an open subpath has no inside.
 * What is honoured is every command that describes a closed contour: M/L/H/V/C/S/Q/T/A/Z, in both
 * absolute and relative form. Anything else is a stroke instruction, and a shape built from one
 * would be a guess.
 *
 * Curves are tessellated HERE rather than handed to three as `Curve` objects, because the contour
 * has to be measured and refitted (see `pathShape`) before it becomes geometry, and a curve that
 * has not been sampled has no bounding box that survives the transform.
 */

import * as THREE from "three";

/** Samples per curve. Matches `extrude`'s own `curveSegments`, so a hand-drawn corner tessellates
 *  no more coarsely than a `slab`'s rounded one. */
const CURVE_SEGMENTS = 24;

/**
 * Total samples one outline may spend, across every curve in it.
 *
 * A path pasted from a vector tool can carry hundreds of curve commands, and 24 samples apiece
 * would hand the extruder a contour of many thousand vertices — which triangulates slowly, ships
 * badly in a share link, and buys nothing visible at the size these shapes render. The budget is
 * spread evenly instead of truncating the path: a coarser curve is a small inaccuracy, a truncated
 * path is a different shape.
 */
const MAX_SAMPLES = 4000;

/** Sticky number scan. SVG permits `10-5`, `1.5.5` and `1e3` with no separator anywhere, so the
 *  cursor has to be advanced by a matcher rather than by splitting on whitespace. */
const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/y;

/**
 * A cursor over path data.
 *
 * Hand-written rather than a tokenizer over one regex because of the arc flags: `A`'s
 * `large-arc` and `sweep` are single characters, and SVG lets them run together with what follows
 * (`a1 1 0 011 1` is legal and common in optimizer output). A generic number scanner reads `011`
 * as eleven and the arc lands somewhere else entirely, so flags need a reader that consumes
 * exactly one character.
 */
class Cursor {
  private i = 0;

  constructor(private readonly src: string) {}

  private skip(): void {
    while (
      this.i < this.src.length &&
      (this.src[this.i] === " " ||
        this.src[this.i] === "," ||
        this.src[this.i] === "\t" ||
        this.src[this.i] === "\n" ||
        this.src[this.i] === "\r")
    )
      this.i++;
  }

  /** The next command letter, or null when the next token is another argument for the current one. */
  command(): string | null {
    this.skip();
    const c = this.src[this.i];
    if (c !== undefined && /[MmZzLlHhVvCcSsQqTtAa]/.test(c)) {
      this.i++;
      return c;
    }
    return null;
  }

  hasNumber(): boolean {
    this.skip();
    const c = this.src[this.i];
    return c !== undefined && /[0-9.+-]/.test(c);
  }

  /**
   * The next number, or NaN — consuming a character either way.
   *
   * The unconditional advance is a liveness guarantee, not tidiness. `hasNumber` accepts a leading
   * `-` or `.`, so data like `L-a` looks like an argument and does not match; returning NaN without
   * moving would leave the caller reading the same non-number forever. Progress is what makes
   * malformed input finish as a dropped contour rather than as a hung frame.
   */
  number(): number {
    this.skip();
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.src);
    if (!m) {
      this.i++;
      return Number.NaN;
    }
    this.i = NUMBER.lastIndex;
    return Number.parseFloat(m[0]);
  }

  /** One character, `0` or `1`. See the class note. */
  flag(): number {
    this.skip();
    const c = this.src[this.i];
    if (c === "0" || c === "1") {
      this.i++;
      return c === "1" ? 1 : 0;
    }
    // Malformed, but a wrong flag is a wrong arc rather than a broken parse — take a number and
    // let the caller's NaN guard decide.
    return this.number() ? 1 : 0;
  }
}

function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  const dot = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
  const a = Math.acos(Math.min(1, Math.max(-1, dot)));
  return ux * vy - uy * vx < 0 ? -a : a;
}

/**
 * Parse `d` into closed contours, in the source's own coordinates — Y still pointing DOWN, at
 * whatever scale it was authored. Reorienting and refitting is the caller's job, because only the
 * caller knows what size the shape is meant to come out.
 *
 * The FIRST contour is the outline and every later one is a hole. That is a contract rather than
 * a winding rule or an even-odd fill: a containment test would have to answer "which of these
 * three overlapping subpaths is inside which", and getting that wrong silently turns a hole into
 * a second body. First-is-outer is what a vector tool emits anyway, and it is checkable by eye.
 */
export function parseSvgPath(d: string): THREE.Vector2[][] {
  // Budget the curve samples before drawing anything: the count is needed by the first curve.
  const curveCount = (d.match(/[CcSsQqTtAa]/g) ?? []).length;
  const segments = Math.max(
    4,
    Math.min(CURVE_SEGMENTS, Math.floor(MAX_SAMPLES / Math.max(1, curveCount))),
  );

  const contours: THREE.Vector2[][] = [];
  let current: THREE.Vector2[] | null = null;
  // Current point, subpath start, and the previous curve's second control point (for S/T).
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let kx = 0;
  let ky = 0;
  let previous = "";

  const cursor = new Cursor(d);

  /** Reopen a contour after a `Z`, at the point the closed subpath started from — per the spec, a
   *  draw command following a closepath begins a new subpath there. */
  const ensure = (): THREE.Vector2[] => {
    if (!current) {
      current = [new THREE.Vector2(cx, cy)];
      contours.push(current);
    }
    return current;
  };

  const lineTo = (x: number, y: number): void => {
    ensure().push(new THREE.Vector2(x, y));
    cx = x;
    cy = y;
  };

  /** Sample a cubic; the start point is already on the contour, so `i` runs from 1. */
  const cubicTo = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
    const contour = ensure();
    const x0 = cx;
    const y0 = cy;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const u = 1 - t;
      contour.push(
        new THREE.Vector2(
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
        ),
      );
    }
    kx = x2;
    ky = y2;
    cx = x;
    cy = y;
  };

  const quadTo = (x1: number, y1: number, x: number, y: number): void => {
    const contour = ensure();
    const x0 = cx;
    const y0 = cy;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const u = 1 - t;
      contour.push(
        new THREE.Vector2(
          u * u * x0 + 2 * u * t * x1 + t * t * x,
          u * u * y0 + 2 * u * t * y1 + t * t * y,
        ),
      );
    }
    kx = x1;
    ky = y1;
    cx = x;
    cy = y;
  };

  /**
   * Endpoint-parameterized elliptical arc, converted to centre form and sampled — the W3C
   * implementation notes' algorithm, verbatim in structure.
   *
   * Worth having rather than approximating with a line: `A` is how every rounded corner of a
   * hand-drawn outline arrives from some tools, and a straight chord across one is exactly the
   * crease the `beveledPrism` note warns about — it catches the environment as a hard line.
   */
  const arcTo = (
    rx: number,
    ry: number,
    rotation: number,
    largeArc: number,
    sweep: number,
    x: number,
    y: number,
  ): void => {
    // A degenerate radius is a straight line, per the spec — not an error.
    if (rx === 0 || ry === 0 || (cx === x && cy === y)) {
      lineTo(x, y);
      return;
    }
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (rotation * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (cx - x) / 2;
    const dy = (cy - y) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    // Radii too small to span the endpoints are scaled up until they exactly reach — again the
    // spec's own correction, and the reason a hand-edited `d` still draws something sane.
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
      const s = Math.sqrt(lambda);
      rx *= s;
      ry *= s;
    }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const co = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
    const cxp = (co * (rx * y1)) / ry;
    const cyp = (-co * (ry * x1)) / rx;
    const ccx = cos * cxp - sin * cyp + (cx + x) / 2;
    const ccy = sin * cxp + cos * cyp + (cy + y) / 2;
    const ux = (x1 - cxp) / rx;
    const uy = (y1 - cyp) / ry;
    const vx = (-x1 - cxp) / rx;
    const vy = (-y1 - cyp) / ry;
    const theta = angleBetween(1, 0, ux, uy);
    let sweepAngle = angleBetween(ux, uy, vx, vy);
    if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
    if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;

    const contour = ensure();
    for (let i = 1; i <= segments; i++) {
      const a = theta + (sweepAngle * i) / segments;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      contour.push(
        new THREE.Vector2(cos * rx * ca - sin * ry * sa + ccx, sin * rx * ca + cos * ry * sa + ccy),
      );
    }
    kx = x;
    ky = y;
    cx = x;
    cy = y;
  };

  let cmd = "";
  for (;;) {
    const next = cursor.command();
    if (next) cmd = next;
    // No letter and no argument left: done. No letter but an argument left: the previous command
    // repeats, which is how `L 0 0 1 1 2 2` draws three segments.
    else if (!cmd || !cursor.hasNumber()) break;
    const executed = cmd;

    switch (executed) {
      case "M":
      case "m": {
        const x = cursor.number();
        const y = cursor.number();
        cx = executed === "m" ? cx + x : x;
        cy = executed === "m" ? cy + y : y;
        sx = cx;
        sy = cy;
        current = [new THREE.Vector2(cx, cy)];
        contours.push(current);
        // Further coordinate pairs after a moveto are linetos, per the spec.
        cmd = executed === "m" ? "l" : "L";
        break;
      }
      case "L":
      case "l": {
        const x = cursor.number();
        const y = cursor.number();
        lineTo(executed === "l" ? cx + x : x, executed === "l" ? cy + y : y);
        break;
      }
      case "H":
      case "h": {
        const x = cursor.number();
        lineTo(executed === "h" ? cx + x : x, cy);
        break;
      }
      case "V":
      case "v": {
        const y = cursor.number();
        lineTo(cx, executed === "v" ? cy + y : y);
        break;
      }
      case "C":
      case "c": {
        const rel = executed === "c";
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        cubicTo(
          ox + cursor.number(),
          oy + cursor.number(),
          ox + cursor.number(),
          oy + cursor.number(),
          ox + cursor.number(),
          oy + cursor.number(),
        );
        break;
      }
      case "S":
      case "s": {
        const rel = executed === "s";
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        // The first control point is the reflection of the last one — but only if the previous
        // command was itself a cubic. Otherwise it coincides with the current point, which is
        // what makes an `S` opening a subpath draw a quadratic-looking curve rather than a loop.
        const smooth = previous === "C" || previous === "c" || previous === "S" || previous === "s";
        cubicTo(
          smooth ? 2 * cx - kx : cx,
          smooth ? 2 * cy - ky : cy,
          ox + cursor.number(),
          oy + cursor.number(),
          ox + cursor.number(),
          oy + cursor.number(),
        );
        break;
      }
      case "Q":
      case "q": {
        const rel = executed === "q";
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        quadTo(
          ox + cursor.number(),
          oy + cursor.number(),
          ox + cursor.number(),
          oy + cursor.number(),
        );
        break;
      }
      case "T":
      case "t": {
        const rel = executed === "t";
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const smooth = previous === "Q" || previous === "q" || previous === "T" || previous === "t";
        quadTo(
          smooth ? 2 * cx - kx : cx,
          smooth ? 2 * cy - ky : cy,
          ox + cursor.number(),
          oy + cursor.number(),
        );
        break;
      }
      case "A":
      case "a": {
        const rel = executed === "a";
        const rx = cursor.number();
        const ry = cursor.number();
        const rot = cursor.number();
        const large = cursor.flag();
        const sweep = cursor.flag();
        const x = cursor.number();
        const y = cursor.number();
        arcTo(rx, ry, rot, large, sweep, rel ? cx + x : x, rel ? cy + y : y);
        break;
      }
      case "Z":
      case "z": {
        // The contour is closed by construction — a repeated start point would leave a
        // zero-length edge whose normal is undefined, the same defect `cone` avoids at its tip.
        cx = sx;
        cy = sy;
        current = null;
        // Closepath takes no arguments, so it has no implicit repeat — and leaving it as the
        // current command would re-run it against a stray number without consuming one.
        cmd = "";
        break;
      }
      default:
        // An unknown letter cannot be skipped safely: its argument count is unknown, so every
        // number after it would be read as coordinates for whatever command came before.
        return finish(contours);
    }
    previous = executed;
  }

  return finish(contours);
}

/**
 * Drop what cannot bound an area.
 *
 * A subpath of one or two points is a dot or a stroke; extruded it produces coincident walls that
 * the triangulator reports as zero-area faces, and those render as the black seam the cut
 * normalizer warns about. A NaN anywhere means the data was malformed partway through, and one
 * bad coordinate poisons every vertex that shares a triangle with it.
 */
function finish(contours: THREE.Vector2[][]): THREE.Vector2[][] {
  return contours.filter(
    (c) => c.length >= 3 && c.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
  );
}

/**
 * Parse `d` and place it in scene units: Y up, centred, sized to `r`.
 *
 * Split out from the shape builder because the BEAM tracer needs the same outline the mesh has —
 * a cross-section derived from anything else refracts light through a solid that is not on screen,
 * which is precisely the failure `BeamConfig.targets` exists to make impossible.
 *
 * Two normalizations, and both are what make a paste WORK rather than merely parse:
 *
 *   Y is flipped. SVG's grows downward and three's grows up, so an unflipped paste renders upside
 *   down — and reads as a bug in the shape rather than in the convention.
 *
 *   The drawing is scaled about its bounding-box centre until its longer half-extent is `r`. A
 *   path is authored against whatever viewBox its tool happened to use, so an unfitted paste is
 *   either a speck or a thousand units across, and neither can be found in the viewport to fix.
 *   Fitting also gives `r` the meaning it has everywhere else — the handle that resizes the
 *   shape — on a kind with no radius of its own.
 *
 * Empty when nothing drawable came back, so the caller decides what to fall back to.
 */
export function fitOutline(d: string, r: number): THREE.Vector2[][] {
  const contours = parseSvgPath(d);
  if (contours.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const p of contour) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  // A path drawn as a single horizontal or vertical run has no area on one axis; the floor keeps
  // the scale finite so the caller gets a degenerate outline rather than a NaN one.
  const scale = (r * 2) / Math.max(maxX - minX, maxY - minY, 1e-6);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return contours.map((contour) =>
    // The Y negation is the SVG→three flip; it also reverses winding, which `ExtrudeGeometry`
    // normalizes on its own for both the outline and its holes.
    contour.map((p) => new THREE.Vector2((p.x - cx) * scale, -(p.y - cy) * scale)),
  );
}

/** Points a feature-width estimate samples. See {@link narrowestFeature}. */
const FEATURE_SAMPLES = 192;

/**
 * Roughly how narrow this contour gets — the width of its thinnest limb, not of its bounding box.
 *
 * The bevel has to be clamped to something, and the bounding box is the wrong something: an
 * outline's features can be far finer than its overall size. The temple arm of a pair of glasses
 * next to the width of its lenses is the case that motivates this — a bevel scaled off the box
 * comes out wider than the arm, and the arm renders as a fat glowing stripe with no flat left in
 * the middle of it.
 *
 * Measured as the smallest distance between two points that are FAR APART ALONG THE CONTOUR. The
 * qualifier is the whole trick: neighbouring points are close by construction on any shape, so an
 * unqualified nearest-pair distance reports the tessellation step and nothing else. Points far
 * apart in index but close in space are the two sides of a narrow limb, which is exactly what is
 * being looked for.
 *
 * An estimate, and deliberately a cheap one. The contour is decimated to a fixed sample count
 * first, so the cost is a constant few thousand distance tests rather than quadratic in a pasted
 * outline's vertex count, and a limb narrow over a very short run can slip between samples. It
 * feeds a default that is then clamped again by the box and the depth — this only ever makes the
 * bevel smaller, so an underestimate costs a little roundness and never breaks the mesh.
 */
export function narrowestFeature(contour: readonly THREE.Vector2[]): number {
  const n = contour.length;
  if (n < 8) return Infinity;
  const step = Math.max(1, Math.floor(n / FEATURE_SAMPLES));
  const sampled: THREE.Vector2[] = [];
  for (let i = 0; i < n; i += step) sampled.push(contour[i]);
  const m = sampled.length;
  // An eighth of the way around is far enough that the two sides of a limb qualify and the run of
  // points along one straight edge does not.
  const apart = Math.max(2, Math.floor(m / 8));
  let best = Infinity;
  for (let i = 0; i < m; i++) {
    for (let j = i + apart; j < m; j++) {
      // Separation on a CLOSED contour is the shorter way round, so a `j` near the end is a
      // neighbour of a `i` near the start however far apart their indices look. Once that
      // happens it stays true for every larger `j`, hence break rather than continue.
      if (m - (j - i) < apart) break;
      const dx = sampled[i].x - sampled[j].x;
      const dy = sampled[i].y - sampled[j].y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
  }
  return best === Infinity ? Infinity : Math.sqrt(best);
}

/**
 * Whether a contour turns the same way at every vertex.
 *
 * Not a gate any more — the tracer handles a re-entrant outline — but still worth knowing, because
 * a convex polygon is the intersection of its edges' half-planes and can therefore be clipped by
 * Cyrus-Beck in one pass, which is markedly cheaper than the general scan. See `clipEntry`.
 *
 * Normalized to the SINE of the turn, not left as a raw cross product. The raw value scales with
 * the square of the edge length, so a fixed epsilon means one thing on a 4-point square and
 * something else on a 600-point traced circle — where coordinates rounded to a few decimals in the
 * source file wobble the turn direction from vertex to vertex and a raw test calls a circle
 * re-entrant. A sine tolerance is scale-free, and at 1e-4 it admits rounding noise (a thousandth
 * of a degree) while a genuinely concave vertex is nowhere near.
 */
export function isConvex(contour: readonly THREE.Vector2[]): boolean {
  const n = contour.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % n];
    const c = contour[(i + 2) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const turn = cross / (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y) || 1);
    // Collinear runs are not a verdict either way — a tessellated straight edge is full of them.
    if (Math.abs(turn) < 1e-4) continue;
    const s = turn > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0; // every vertex collinear: a line, not a polygon
}

/** Which side of `p→q` the point `r` falls on. */
function side(p: THREE.Vector2, q: THREE.Vector2, r: THREE.Vector2): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

/** Whether two segments properly cross. Shared endpoints do not count — consecutive edges of any
 *  closed contour meet, and that is not an intersection. */
function segmentsCross(
  a: THREE.Vector2,
  b: THREE.Vector2,
  c: THREE.Vector2,
  d: THREE.Vector2,
): boolean {
  const cross = side;
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return (
    (d1 > 0 !== d2 > 0 || d1 === 0 || d2 === 0) &&
    (d3 > 0 !== d4 > 0 || d3 === 0 || d4 === 0) &&
    d1 !== d2 &&
    d3 !== d4
  );
}

/**
 * Whether a contour is SIMPLE — no edge crossing any other.
 *
 * This is the gate the convexity test used to be, and it is the honest one: a re-entrant outline
 * is a perfectly good solid and the tracer now follows one, but a self-crossing outline is not a
 * solid at all. "Inside" is undefined for a figure-of-eight, so the tracer's entering-and-leaving
 * bookkeeping has nothing to be right about — it would not look approximate, it would look random.
 *
 * O(n^2), and deliberately run AFTER simplification: a few hundred points is tens of thousands of
 * compares once per beam retrace, which is nothing beside the thousands of rays that follow.
 */
export function isSimple(contour: readonly THREE.Vector2[]): boolean {
  const n = contour.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % n];
    // Skip this edge's own neighbours, which share an endpoint with it by construction.
    for (let j = i + 2; j < n - (i === 0 ? 1 : 0); j++) {
      if (segmentsCross(a, b, contour[j], contour[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * Drop the points a shape's silhouette does not depend on — Douglas-Peucker.
 *
 * The tracer walks every edge of a cross-section for every ray, and a pasted outline can carry
 * thousands, so something has to come off. Uniform index sampling — which is what a convex-only
 * gate could get away with, since it preserves convexity — is exactly wrong here: it thins a
 * straight run and a narrow notch at the same rate, and the notch is the whole reason the outline
 * is interesting. Douglas-Peucker spends its points where the shape bends, so a long flat edge
 * costs two and a slot keeps its walls.
 *
 * `tolerance` is in the outline's own units, so it is passed as a fraction of the fitted radius by
 * the caller rather than guessed here.
 */
export function simplifyOutline(
  contour: readonly THREE.Vector2[],
  tolerance: number,
): THREE.Vector2[] {
  const n = contour.length;
  if (n <= 4) return contour.slice();
  // A closed contour has no natural endpoints, so it is split at the two points furthest apart and
  // simplified as two open chains. Simplifying it as one chain from an arbitrary start would pin
  // that start point and let the vertex beside it go, which shows as a nick in the silhouette.
  let a = 0;
  let b = 1;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (contour[i].x - contour[0].x) ** 2 + (contour[i].y - contour[0].y) ** 2;
    if (d > best) {
      best = d;
      b = i;
    }
  }
  const first = contour.slice(a, b + 1);
  const second = [...contour.slice(b), contour[0]];
  const kept = [...douglasPeucker(first, tolerance), ...douglasPeucker(second, tolerance).slice(1)];
  kept.pop(); // the duplicated wrap point
  return kept;
}

function douglasPeucker(chain: THREE.Vector2[], tolerance: number): THREE.Vector2[] {
  if (chain.length < 3) return chain.slice();
  const first = chain[0];
  const last = chain[chain.length - 1];
  const ex = last.x - first.x;
  const ey = last.y - first.y;
  const lengthSq = ex * ex + ey * ey;
  let worst = -1;
  let index = 0;
  for (let i = 1; i < chain.length - 1; i++) {
    const px = chain[i].x - first.x;
    const py = chain[i].y - first.y;
    // Distance to the SEGMENT, not the infinite line: a chain that doubles back has points whose
    // nearest approach is an endpoint, and the line distance would keep them for no reason.
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, (px * ex + py * ey) / lengthSq)) : 0;
    const d = (px - ex * t) ** 2 + (py - ey * t) ** 2;
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance * tolerance) return [first, last];
  return [
    ...douglasPeucker(chain.slice(0, index + 1), tolerance),
    ...douglasPeucker(chain.slice(index), tolerance).slice(1),
  ];
}

/**
 * A drawn outline as something the beam tracer can follow, or undefined if it cannot be one.
 *
 * Simplify first, then test: simplification can only remove crossings that rounding put there, and
 * testing the dense contour would reject outlines that trace perfectly well. What survives is a
 * simple polygon, convex or not — `preparePolygon` decides which clipper it gets.
 */
export function traceableOutline(
  contour: readonly THREE.Vector2[],
  radius: number,
): THREE.Vector2[] | undefined {
  if (contour.length < 3) return undefined;
  const simplified = simplifyOutline(contour, radius * 0.004);
  if (simplified.length < 3 || !isSimple(simplified)) return undefined;
  return simplified;
}
