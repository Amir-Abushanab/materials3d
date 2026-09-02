import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  fitOutline,
  isConvex,
  isSimple,
  narrowestFeature,
  parseSvgPath,
  simplifyOutline,
  traceableOutline,
} from "./svgPath";

/** Bounding box of every contour together, which is what `pathShape` fits to. */
function bounds(contours: { x: number; y: number }[][]) {
  const pts = contours.flat();
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

describe("parseSvgPath", () => {
  it("draws a closed polygon from absolute linetos", () => {
    // Four corners, not five: `Z` closes by construction rather than by repeating the start,
    // which would leave a zero-length edge with an undefined normal.
    const [square] = parseSvgPath("M0 0 L10 0 L10 10 L0 10 Z");
    expect(square).toHaveLength(4);
    expect(square[2]).toMatchObject({ x: 10, y: 10 });
  });

  it("reads relative commands against the current point", () => {
    const [a] = parseSvgPath("M0 0 L10 0 L10 10 L0 10 Z");
    const [b] = parseSvgPath("m0 0 l10 0 l0 10 l-10 0 z");
    expect(b.map((p) => [p.x, p.y])).toEqual(a.map((p) => [p.x, p.y]));
  });

  it("treats further pairs after a moveto as linetos", () => {
    // The spec's rule, and the form every optimizer emits: `M0 0 10 0 10 10` is three points.
    const [contour] = parseSvgPath("M0 0 10 0 10 10 Z");
    expect(contour).toHaveLength(3);
    expect(contour[1]).toMatchObject({ x: 10, y: 0 });
  });

  it("reads H and V against the axis they do not move", () => {
    const [contour] = parseSvgPath("M0 0 H10 V10 H0 Z");
    expect(contour[1]).toMatchObject({ x: 10, y: 0 });
    expect(contour[2]).toMatchObject({ x: 10, y: 10 });
  });

  it("separates numbers with no separator between them", () => {
    // `10-5` is two numbers and `.5.5` is two more. Splitting on whitespace reads either as one.
    const [contour] = parseSvgPath("M0 0L10-5L.5.5Z");
    expect(contour[1]).toMatchObject({ x: 10, y: -5 });
    expect(contour[2]).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it("reflects a smooth cubic's control point off the previous curve", () => {
    // S after C mirrors the previous control point; S opening a subpath has nothing to mirror and
    // takes the current point instead. The two must not draw the same curve.
    const smooth = parseSvgPath("M0 0 C0 10 10 10 10 0 S20 -10 20 0 Z")[0];
    const cold = parseSvgPath("M0 0 L10 0 S20 -10 20 0 Z")[0];
    const midSmooth = smooth[Math.floor(smooth.length * 0.75)];
    const midCold = cold[Math.floor(cold.length * 0.75)];
    expect(midSmooth.y).not.toBeCloseTo(midCold.y, 2);
  });

  it("reflects a smooth quadratic the same way", () => {
    const [contour] = parseSvgPath("M0 0 Q5 10 10 0 T20 0 Z");
    // T mirrors (5,10) about (10,0) to (15,-10), so the second arch goes the other way.
    expect(Math.min(...contour.map((p) => p.y))).toBeLessThan(-1);
    expect(Math.max(...contour.map((p) => p.y))).toBeGreaterThan(1);
  });

  it("traces an elliptical arc through its far side", () => {
    // A half-circle of radius 5 from (0,0) to (10,0), and the bulge is what distinguishes a real
    // arc from the chord a lazy parser draws. It goes to y = -5, not +5: a positive sweep is the
    // direction of increasing angle in SVG's y-DOWN frame, so it leaves the axis on the side that
    // is up on screen — and `pathShape`'s flip is what puts it back up in the scene.
    const [contour] = parseSvgPath("M0 0 A5 5 0 0 1 10 0 Z");
    expect(Math.min(...contour.map((p) => p.y))).toBeCloseTo(-5, 1);
    expect(Math.max(...contour.map((p) => p.y))).toBeCloseTo(0, 1);
  });

  it("mirrors an arc when the sweep flag flips", () => {
    const up = parseSvgPath("M0 0 A5 5 0 0 1 10 0 Z")[0];
    const down = parseSvgPath("M0 0 A5 5 0 0 0 10 0 Z")[0];
    expect(Math.max(...down.map((p) => p.y))).toBeCloseTo(-Math.min(...up.map((p) => p.y)), 3);
  });

  it("reads arc flags packed against the coordinates that follow", () => {
    // `0 1 1 10 0` written as `0110 0`, which is what an optimizer emits. A generic number scanner
    // reads the flags as one hundred and ten and the arc lands somewhere else entirely — the whole
    // reason the cursor has a single-character flag reader. Equality with the spaced form is the
    // assertion; anything weaker passes on a parser that quietly draws a chord.
    const packed = parseSvgPath("M0 0A5 5 0 0110 0Z")[0];
    const spaced = parseSvgPath("M0 0 A5 5 0 0 1 10 0 Z")[0];
    expect(packed.map((p) => [p.x, p.y])).toEqual(spaced.map((p) => [p.x, p.y]));
  });

  it("straightens an arc whose radius collapsed", () => {
    // The spec's own rule: a zero radius is a line, not an error. One point, not a fan of them.
    const [contour] = parseSvgPath("M0 0 A0 0 0 0 1 10 0 L10 10 Z");
    expect(contour).toHaveLength(3);
  });

  it("grows radii too small to reach the endpoints", () => {
    // Also the spec's correction, and what keeps a hand-edited `d` drawing something sane: the
    // ellipse is scaled up until it exactly spans the chord, giving a half-circle of radius 5.
    const [contour] = parseSvgPath("M0 0 A1 1 0 0 1 10 0 Z");
    expect(Math.min(...contour.map((p) => p.y))).toBeCloseTo(-5, 1);
  });

  it("keeps later subpaths as separate contours", () => {
    const contours = parseSvgPath("M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z");
    expect(contours).toHaveLength(2);
    expect(contours[1][0]).toMatchObject({ x: 2, y: 2 });
  });

  it("drops subpaths that cannot bound an area", () => {
    // A dot and a single stroke have no inside; extruded they are coincident walls.
    expect(parseSvgPath("M0 0 Z M5 5 L6 6 Z M0 0 H10 V10 H0 Z")).toHaveLength(1);
  });

  it("drops a contour poisoned by malformed data instead of hanging", () => {
    // `L-x` looks like an argument and is not one. The guarantee under test is that this returns
    // at all — one non-number that never advanced the cursor would spin forever.
    expect(parseSvgPath("M0 0 L-x 4 L9 9 Z")).toHaveLength(0);
  });

  it("stops at a command it cannot know the argument count of", () => {
    // A stroke instruction's arguments would otherwise be read as coordinates for the last
    // drawing command, silently bending the shape.
    const contours = parseSvgPath("M0 0 H10 V10 H0 Z W3 4 5 M20 20 H30 V30 Z");
    expect(contours).toHaveLength(1);
  });

  it("ignores a stray number after a closepath", () => {
    expect(parseSvgPath("M0 0 H10 V10 H0 Z 5")).toHaveLength(1);
  });

  it("spreads a fixed sample budget across the curves in a path", () => {
    // One curve gets full resolution; a path of many shares the same total, so a traced outline
    // cannot hand the extruder tens of thousands of vertices.
    const one = parseSvgPath("M0 0 C0 10 10 10 10 0 Z")[0].length;
    const many = parseSvgPath(`M0 0 ${"C0 10 10 10 10 0 ".repeat(400)}Z`)[0].length;
    expect(one).toBe(25);
    expect(many).toBeLessThan(4600);
  });

  it("reads y as SVG does, pointing down", () => {
    // The flip belongs to `pathShape`, not here: this stage reports the source's own coordinates
    // so the fit has something stable to measure.
    const box = bounds(parseSvgPath("M0 0 L10 0 L5 10 Z"));
    expect(box.maxY).toBeCloseTo(10);
  });
});

describe("fitOutline", () => {
  it("flips y and sizes the longer axis to the radius", () => {
    // A triangle whose apex is DOWN in SVG has to stay down once y is flipped, or every paste
    // arrives mirrored — which reads as a bug in the shape rather than in the convention.
    const [contour] = fitOutline("M0 0 L10 0 L5 10 Z", 2);
    expect(Math.max(...contour.map((p) => p.x))).toBeCloseTo(2, 4);
    expect(Math.min(...contour.map((p) => p.y))).toBeCloseTo(-2, 4);
    // The apex is the lone vertex at the bottom.
    expect(contour.filter((p) => p.y < 0)).toHaveLength(1);
  });

  it("gives two viewBox scales the same result", () => {
    const small = fitOutline("M0 0 H1 V1 H0 Z", 2)[0];
    const large = fitOutline("M0 0 H1000 V1000 H0 Z", 2)[0];
    expect(small.map((p) => [p.x, p.y])).toEqual(large.map((p) => [p.x, p.y]));
  });

  it("centres on the bounding box, not the origin", () => {
    const [contour] = fitOutline("M100 100 H120 V120 H100 Z", 1);
    expect(Math.min(...contour.map((p) => p.x))).toBeCloseTo(-1, 4);
    expect(Math.max(...contour.map((p) => p.x))).toBeCloseTo(1, 4);
  });

  it("is empty when nothing drawable came back", () => {
    expect(fitOutline("not a path", 2)).toHaveLength(0);
  });
});

describe("narrowestFeature", () => {
  it("measures a limb's width, not the bounding box", () => {
    // A 100-wide body with a 1.5-wide spike hanging off it. The bounding box says 90; what a
    // bevel actually has to fit inside is 1.5.
    const [contour] = fitOutline("M0 0 H100 V40 H51 V90 H49.5 V40 H0 Z", 50);
    // Fitted so the 100-wide axis spans 100, i.e. source units survive.
    expect(narrowestFeature(contour)).toBeLessThan(4);
  });

  it("reports the across-shape distance on a shape with no thin limb", () => {
    // Not the tessellation step: neighbouring points are close on ANY contour, so an unqualified
    // nearest-pair distance would report the sampling rate and nothing about the shape.
    const [square] = fitOutline(`M0 0 ${"L100 0 L100 100 L0 100 "}Z`, 50);
    expect(narrowestFeature(square)).toBeGreaterThan(10);
  });

  it("declines to guess on a contour with too few points", () => {
    expect(narrowestFeature([])).toBe(Infinity);
  });
});

/** One vertex of a 600-gon inscribed in a radius-50 circle, at an exported file's precision. */
function circlePoint(i: number): string {
  const a = (i / 600) * Math.PI * 2;
  return `${(Math.cos(a) * 50 + 50).toFixed(3)} ${(Math.sin(a) * 50 + 50).toFixed(3)}`;
}

describe("outlines the tracer can follow", () => {
  const STAR =
    "M50 0 L61.8 33.8 L97.6 34.5 L69 56.2 L79.4 90.5 L50 70 L20.6 90.5 L31 56.2 L2.4 34.5 L38.2 33.8 Z";

  it("knows a convex drawing from a re-entrant one", () => {
    // Not a gate any more — it decides which CLIPPER the outline gets. Cyrus-Beck answers a convex
    // polygon in one pass; a re-entrant one has to be scanned edge by edge.
    expect(isConvex(fitOutline("M0 0 H10 V10 H0 Z", 1)[0])).toBe(true);
    expect(isConvex(fitOutline(STAR, 1)[0])).toBe(false);
  });

  it("survives collinear runs, which a tessellated edge is full of", () => {
    expect(isConvex(fitOutline("M0 0 L5 0 L10 0 L10 10 L5 10 L0 10 Z", 1)[0])).toBe(true);
  });

  it("calls a dense traced circle convex despite its rounding", () => {
    // Coordinates rounded to three decimals on purpose: that is what a real exported file carries,
    // and it is what an un-normalized turn test trips over.
    const dense = `M${circlePoint(0)} ${Array.from({ length: 599 }, (_, i) => `L${circlePoint(i + 1)}`).join(" ")} Z`;
    expect(isConvex(fitOutline(dense, 1)[0])).toBe(true);
  });

  it("accepts a re-entrant outline as a beam target", () => {
    // The whole point of the change: a star is a perfectly good solid, and the tracer follows one.
    expect(traceableOutline(fitOutline(STAR, 2)[0], 2)).toBeDefined();
  });

  it("refuses a self-crossing one", () => {
    // A figure-of-eight has no inside, so the tracer's entering-and-leaving bookkeeping has
    // nothing to be right about.
    const bowtie = fitOutline("M0 0 L10 10 L10 0 L0 10 Z", 2)[0];
    expect(isSimple(bowtie)).toBe(false);
    expect(traceableOutline(bowtie, 2)).toBeUndefined();
  });

  it("calls an ordinary outline simple", () => {
    expect(isSimple(fitOutline(STAR, 2)[0])).toBe(true);
    expect(isSimple(fitOutline("M0 0 H10 V10 H0 Z", 2)[0])).toBe(true);
  });

  it("spends its points where the shape bends", () => {
    // Uniform sampling thins a straight run and a narrow notch at the same rate, and the notch is
    // the reason the outline is interesting. A long flat edge should cost almost nothing.
    const flat = fitOutline(
      `M0 0 ${Array.from({ length: 200 }, (_, i) => `L${i / 2} 0`).join(" ")} L100 50 Z`,
      2,
    )[0];
    expect(simplifyOutline(flat, 0.01).length).toBeLessThan(10);
  });

  it("keeps a notch's walls while decimating a traced outline", () => {
    // A traced file carries the same shape as hundreds of points along its edges. Uniform sampling
    // would thin the 1.5-wide spike at the same rate as the 100-wide base and eventually lose it.
    const corners = fitOutline("M0 0 H100 V40 H51 V90 H49.5 V40 H0 Z", 50)[0];
    const traced: THREE.Vector2[] = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      for (let k = 0; k < 40; k++) {
        traced.push(new THREE.Vector2(a.x + (b.x - a.x) * (k / 40), a.y + (b.y - a.y) * (k / 40)));
      }
    }
    const simple = simplifyOutline(traced, 0.2);
    expect(traced).toHaveLength(320);
    // Back to its corners, and every one of them: eight is the shape, not an approximation of it.
    expect(simple.length).toBeLessThan(16);
    expect(Math.max(...simple.map((p) => p.y)) - Math.min(...simple.map((p) => p.y))).toBeCloseTo(
      Math.max(...traced.map((p) => p.y)) - Math.min(...traced.map((p) => p.y)),
      2,
    );
    // And the spike still has two walls a millimetre apart, not one.
    const bottom = simple.filter((p) => p.y < Math.min(...simple.map((q) => q.y)) + 1);
    expect(bottom.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves an outline that is already only corners alone", () => {
    const corners = fitOutline("M0 0 H100 V40 H51 V90 H49.5 V40 H0 Z", 50)[0];
    expect(simplifyOutline(corners, 0.2)).toHaveLength(corners.length);
  });

  it("caps a dense outline's edge count", () => {
    const dense = `M${circlePoint(0)} ${Array.from({ length: 599 }, (_, i) => `L${circlePoint(i + 1)}`).join(" ")} Z`;
    const traced = traceableOutline(fitOutline(dense, 2)[0], 2)!;
    expect(traced.length).toBeLessThan(200);
    expect(traced.length).toBeGreaterThan(8);
  });
});
