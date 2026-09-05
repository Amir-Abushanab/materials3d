import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { contourArea, sliceGeometry } from "./meshSlice";
import { buildShape } from "./shapes";
import { prismCrossSection } from "./lightSheet";
import { createShape } from "../config/model";
import { traceableOutline } from "./svgPath";

const IDENTITY = new THREE.Matrix4();

/** Vertices where the outline actually turns, ignoring collinear points a simplifier left behind. */
function corners(poly: readonly THREE.Vector2[]): number {
  return poly.filter((p, i) => {
    const before = poly[(i - 1 + poly.length) % poly.length];
    const after = poly[(i + 1) % poly.length];
    const cross = (p.x - before.x) * (after.y - p.y) - (p.y - before.y) * (after.x - p.x);
    return Math.abs(cross) > 1e-6;
  }).length;
}

function extent(contour: readonly THREE.Vector2[]): { w: number; h: number } {
  const xs = contour.map((p) => p.x);
  const ys = contour.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

describe("sliceGeometry", () => {
  it("cuts a box into its rectangle", () => {
    // Also the welding test, and the reason it comes first: three gives a box 24 vertices, four
    // per face, because the normals differ across every edge. Keyed on raw indices the segments
    // would never chain and this returns nothing.
    const box = new THREE.BoxGeometry(3, 2, 1);
    const [contour, ...rest] = sliceGeometry(box, IDENTITY, 0);
    expect(rest).toHaveLength(0);
    expect(extent(contour)).toEqual({ w: 3, h: 2 });
    expect(Math.abs(contourArea(contour))).toBeCloseTo(6, 5);
  });

  it("cuts a sphere into a circle of the right radius", () => {
    // Off-centre on purpose: at z = 0.4 through a unit sphere the circle is sqrt(1 - 0.16).
    const sphere = new THREE.SphereGeometry(1, 64, 32);
    const [contour] = sliceGeometry(sphere, IDENTITY, 0.4);
    const expected = Math.sqrt(1 - 0.16);
    expect(extent(contour).w).toBeCloseTo(expected * 2, 2);
    expect(Math.abs(contourArea(contour))).toBeCloseTo(Math.PI * expected * expected, 1);
  });

  it("returns both contours when the plane cuts a torus, largest first", () => {
    // The case a lathe's `r` and `sides` cannot express and a drawn outline gets only half of:
    // an annulus, whose inner wall the light crosses as surely as its outer one.
    const torus = new THREE.TorusGeometry(2, 0.5, 24, 96);
    const contours = sliceGeometry(torus, IDENTITY, 0);
    expect(contours).toHaveLength(2);
    expect(extent(contours[0]).w).toBeCloseTo(5, 1);
    expect(extent(contours[1]).w).toBeCloseTo(3, 1);
  });

  it("misses cleanly when the plane is off the mesh", () => {
    expect(sliceGeometry(new THREE.BoxGeometry(1, 1, 1), IDENTITY, 4)).toEqual([]);
  });

  it("follows the pose, not just the geometry", () => {
    // The whole reason a mesh needs the item's full transform where a lathe needed only its roll:
    // turn a box about X and the plane cuts a different rectangle out of it.
    const box = new THREE.BoxGeometry(2, 2, 6);
    const flat = sliceGeometry(box, IDENTITY, 0)[0];
    expect(extent(flat)).toEqual({ w: 2, h: 2 });

    const turned = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    const [rolled] = sliceGeometry(box, turned, 0);
    expect(extent(rolled).w).toBeCloseTo(2, 5);
    expect(extent(rolled).h).toBeCloseTo(6, 5);
  });

  it("moves with a translation", () => {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const moved = new THREE.Matrix4().makeTranslation(5, -3, 0);
    const [contour] = sliceGeometry(box, moved, 0);
    const xs = contour.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(4, 5);
    expect(Math.max(...xs)).toBeCloseTo(6, 5);
  });

  it("scales with the pose", () => {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const bigger = new THREE.Matrix4().makeScale(3, 1, 1);
    expect(extent(sliceGeometry(box, bigger, 0)[0])).toEqual({ w: 6, h: 2 });
  });

  it("drops an open chain rather than inventing a wall to close it", () => {
    // A plane is not a solid: cutting it gives a line with two loose ends, and a contour that does
    // not close has no inside for the tracer to be right about.
    const plane = new THREE.PlaneGeometry(4, 4).rotateX(Math.PI / 2);
    expect(sliceGeometry(plane, IDENTITY, 0)).toEqual([]);
  });

  it("handles a mesh that grazes the plane at one vertex", () => {
    // The box's own top face sits exactly on the sheet. Whatever it returns, it must not hang or
    // produce a contour with fewer than three points.
    const box = new THREE.BoxGeometry(2, 2, 2);
    for (const contour of sliceGeometry(box, IDENTITY, 1)) {
      expect(contour.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("cuts a lathe into the polygon the tracer derives analytically", () => {
    // The load-bearing test. `crossSectionFor` has always answered for a prism out of `r` and
    // `sides`; the slicer has to reach the same triangle by cutting the mesh, or a solid traced
    // as a model refracts light along a path its own geometry does not support.
    const r = 1.4;
    const prism = buildShape({ ...createShape("prism"), r, len: 4, sides: 3 });
    // The lathe sweeps about Y, so it is stood up into the sheet's plane the way the `prism`
    // preset stands its item up: -90 degrees about X.
    const upright = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const [cut] = sliceGeometry(prism, upright, 0);
    const analytic = prismCrossSection(r, 3, 0);

    // The raw cut carries more points than the triangle has corners: a lathe subdivides its side
    // walls, so the plane crosses rings of vertices partway along each edge and every crossing is
    // returned. They are collinear, which is why the area already agrees, and `traceableOutline`
    // drops them on the way to the tracer. Asserting after it is asserting what the tracer sees.
    expect(cut.length).toBeGreaterThan(3);
    expect(Math.abs(contourArea(cut))).toBeCloseTo(Math.abs(contourArea(analytic)), 4);

    // CORNERS, not points. The simplifier anchors on the contour's first vertex and keeps it
    // whether or not it turns, so one collinear point can survive; it costs the tracer an edge
    // that bends light by zero degrees, which is why the count is not the thing to assert. What
    // has to be true is that the polygon IS the triangle: three corners, same size, same area.
    const traceable = traceableOutline(cut, r)!;
    expect(corners(traceable)).toBe(3);
    expect(Math.max(...traceable.map((p) => Math.hypot(p.x, p.y)))).toBeCloseTo(r, 3);
    expect(Math.abs(contourArea(traceable))).toBeCloseTo(Math.abs(contourArea(analytic)), 3);
  });
});
