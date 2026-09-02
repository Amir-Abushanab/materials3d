/**
 * Shape builders. Almost every primitive here is a lathe — a 2D profile swept about Y. Change the
 * profile and you get rods, discs, cones, spheres and rings; change the *segment count* and you
 * get prisms, since a hexagon is a lathe with `sides: 6`. That one observation covers most of the
 * geometry in this visual language. `arrow`/`extrude` are the exceptions: swept 2D paths.
 */

import * as THREE from "three";
import { fbmSimplex3d } from "../util/noise";
import { DEFAULT_OUTLINE, type CutConfig, type ShapeConfig } from "../config/model";
import { fitOutline, narrowestFeature } from "./svgPath";

export interface RodOptions {
  r?: number;
  len?: number;
  fillet?: number;
  sides?: number;
}

export interface DiscOptions {
  r?: number;
  thickness?: number;
  fillet?: number;
  sides?: number;
}

export interface PrismOptions {
  r?: number;
  len?: number;
  sides?: number;
  fillet?: number;
}

export interface ConeOptions {
  r?: number;
  len?: number;
  sides?: number;
}

export interface SphereOptions {
  r?: number;
  sides?: number;
}

export interface RingOptions {
  r?: number;
  hole?: number;
  thickness?: number;
  sides?: number;
}

export interface DropletOptions {
  r?: number;
  len?: number;
  sides?: number;
}

export interface BlobOptions {
  r?: number;
  sides?: number;
  seed?: number;
  bump?: number;
}

export interface ExtrudeOptions {
  shape: THREE.Shape;
  depth?: number;
  bevel?: number;
}

export interface SlabOptions {
  /** Width (X) and height (Y) of the plate; `depth` runs along Z, toward the lens. */
  w?: number;
  h?: number;
  depth?: number;
  /** Corner radius. */
  r?: number;
  fillet?: number;
  cuts?: readonly CutConfig[];
}

export interface PathOptions {
  /** SVG path data — or a whole `<svg>` document; see {@link ShapeConfig.outline}. */
  outline?: string;
  /** Half-extent the outline is fitted to, on its LONGER axis. */
  r?: number;
  depth?: number;
  /** Positive is a literal bevel radius, `0` picks one from the outline's narrowest limb, and
   *  NEGATIVE turns the bevel off — the one kind here that can refuse one. */
  fillet?: number;
  cuts?: readonly CutConfig[];
}

export interface ArrowOptions {
  len?: number;
  shaft?: number;
  head?: number;
  depth?: number;
  cuts?: readonly CutConfig[];
}

/**
 * A rounded-rectangle contour, counter-clockwise.
 *
 * This is the only cut primitive there is. A circle is a rect whose corner radius has eaten it
 * (`w === h === 2r`), and a slot is one whose radius has reached half its short side — so
 * `normalizeCuts` can express every {@link CutConfig} by choosing `w`, `h` and `r`, and this
 * function never has to know which of them it is drawing.
 */
function roundedRectPoints(w: number, h: number, radius: number): THREE.Vector2[] {
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r < 1e-6) {
    return [
      new THREE.Vector2(hw, -hh),
      new THREE.Vector2(hw, hh),
      new THREE.Vector2(-hw, hh),
      new THREE.Vector2(-hw, -hh),
    ];
  }
  // Segments scale with the arc, so a pinhole does not carry 20 vertices and a stadium slot does
  // not go faceted. Extrude's `curveSegments` cannot help here: these are line segments already.
  const seg = Math.max(3, Math.min(20, Math.ceil(r * 16)));
  const pts: THREE.Vector2[] = [];
  const corners: [number, number, number][] = [
    [hw - r, -hh + r, -Math.PI / 2],
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = start + (Math.PI / 2) * (i / seg);
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  }
  return pts;
}

/** One carve-out as a hole path, posed in the profile plane and grown to survive the bevel. */
function cutPath(cut: CutConfig, grow: number): THREE.Path {
  const cos = Math.cos(cut.rotation);
  const sin = Math.sin(cut.rotation);
  const pts = roundedRectPoints(cut.w + grow * 2, cut.h + grow * 2, cut.r + grow);
  return new THREE.Path(
    pts.map((p) => new THREE.Vector2(cut.x + p.x * cos - p.y * sin, cut.y + p.x * sin + p.y * cos)),
  );
}

/**
 * Extrude a profile so the FINISHED solid has the dimensions that were asked for.
 *
 * Three's bevel does not inset. It grows the outer contour by `bevelSize`, grows the depth by
 * twice `bevelThickness`, and SHRINKS every hole by `bevelSize` — three offsets in three
 * directions. A lathe's fillet does the opposite: it rounds within the radius you gave it. Left
 * uncompensated, every plate here comes out a little too wide, a little too thick and slotted a
 * little too narrow; small enough to miss by eye, and exactly the drift that would stop a carved
 * plate sitting where its lathe twin did.
 *
 * `outline` is a function rather than a contour so each shape can inset itself correctly — a
 * rounded rect loses the bevel off each side, a regular polygon loses it off each EDGE, which is
 * a bigger bite out of the circumradius the fewer sides it has.
 */
function bevelledExtrude(
  outline: (inset: number) => THREE.Vector2[],
  cuts: readonly CutConfig[],
  depth: number,
  bevel: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline(bevel));
  for (const cut of cuts) shape.holes.push(cutPath(cut, bevel));
  return extrude({ shape, depth: Math.max(0.01, depth - bevel * 2), bevel });
}

/**
 * The largest bevel that will not eat a carve-out.
 *
 * Extrude offsets every hole contour OUTWARD by `bevelSize` to form its lip, so a bevel wider than
 * half a cut's short side turns that cut inside out — the walls cross and the shape renders with a
 * black knot where the slot should be. Clamping is better than refusing: the fillet is a look, the
 * slot is the point.
 */
function bevelFor(fillet: number, cuts: readonly CutConfig[], ...spans: number[]): number {
  let limit = Math.min(...spans) * 0.45;
  for (const cut of cuts) limit = Math.min(limit, (Math.min(cut.w, cut.h) / 2) * 0.45);
  return Math.max(0, Math.min(fillet, limit));
}

/** `0` in a config means "pick a proportional fillet"; anything positive is taken literally. */
function resolveFillet(fillet: number | undefined, proportional: number): number {
  return fillet !== undefined && fillet > 0 ? fillet : proportional;
}

/**
 * The profile for a flat-ended barrel with a corner fillet. Flat ends, not hemispheres: the
 * fillet catches the rim highlight and the flat face reads as an ellipse when tilted — a strong
 * glass cue that a capsule loses entirely.
 */
function barrelProfile(r: number, len: number, fillet: number): THREE.Vector2[] {
  const f = Math.min(fillet, r * 0.98, (len / 2) * 0.98);
  const half = len / 2;
  const seg = 8;
  const pts: THREE.Vector2[] = [];
  pts.push(new THREE.Vector2(0, -half));
  pts.push(new THREE.Vector2(r - f, -half));
  for (let i = 1; i <= seg; i++) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / seg);
    pts.push(new THREE.Vector2(r - f + Math.cos(a) * f, -half + f + Math.sin(a) * f));
  }
  for (let i = 0; i <= seg; i++) {
    const a = (Math.PI / 2) * (i / seg);
    pts.push(new THREE.Vector2(r - f + Math.cos(a) * f, half - f + Math.sin(a) * f));
  }
  pts.push(new THREE.Vector2(0, half));
  return pts;
}

/** A long flat-ended cylinder — the tube from the reference scene. */
export function rod({
  r = 0.4,
  len = 8,
  fillet,
  sides = 72,
}: RodOptions = {}): THREE.LatheGeometry {
  return new THREE.LatheGeometry(barrelProfile(r, len, resolveFillet(fillet, r * 0.3)), sides);
}

/** The same primitive, squat: a puck / coin. */
export function disc({
  r = 2,
  thickness = 0.5,
  fillet,
  sides = 72,
}: DiscOptions = {}): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    barrelProfile(r, thickness, resolveFillet(fillet, thickness * 0.3)),
    sides,
  );
}

/** The same primitive at a low segment count. Prisms are lathes with few sides. */
export function prism({
  r = 2,
  len = 0.6,
  sides = 6,
  fillet,
}: PrismOptions = {}): THREE.LatheGeometry {
  return new THREE.LatheGeometry(barrelProfile(r, len, resolveFillet(fillet, 0.06)), sides);
}

export function hex(options: Omit<PrismOptions, "sides"> = {}): THREE.LatheGeometry {
  return prism({ ...options, sides: 6 });
}

export function cone({ r = 1.5, len = 3, sides = 72 }: ConeOptions = {}): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    [
      new THREE.Vector2(0, -len / 2),
      new THREE.Vector2(r, -len / 2),
      // Not exactly 0: a lathe profile that touches the axis produces degenerate tip triangles
      // whose normals are undefined, which shows up as a black speck through the refraction.
      new THREE.Vector2(0.001, len / 2),
    ],
    sides,
  );
}

export function sphere({ r = 1, sides = 64 }: SphereOptions = {}): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = -Math.PI / 2 + Math.PI * (i / 24);
    pts.push(new THREE.Vector2(Math.max(Math.cos(a) * r, 0.0001), Math.sin(a) * r));
  }
  return new THREE.LatheGeometry(pts, sides);
}

/** An annulus / washer — a disc with a hole, so the profile is a closed rectangle. */
export function ring({
  r = 2,
  hole = 1,
  thickness = 0.5,
  sides = 72,
}: RingOptions = {}): THREE.LatheGeometry {
  const h = thickness / 2;
  const inner = Math.min(hole, r * 0.98);
  return new THREE.LatheGeometry(
    [
      new THREE.Vector2(inner, -h),
      new THREE.Vector2(r, -h),
      new THREE.Vector2(r, h),
      new THREE.Vector2(inner, h),
      new THREE.Vector2(inner, -h),
    ],
    sides,
  );
}

/**
 * A teardrop: still a lathe. The profile is `sin(a)·sin^1.5(a/2)` — a hemispherical bottom easing
 * into a soft point at the top — normalized so `r` is the radius at the widest point, matching
 * what `r` means on every other shape. The tip is held just off the axis for the same reason the
 * cone's is: a profile touching the axis makes degenerate triangles with undefined normals.
 */
export function droplet({
  r = 1.2,
  len = 3,
  sides = 64,
}: DropletOptions = {}): THREE.LatheGeometry {
  const steps = 32;
  const profile: { x: number; y: number }[] = [];
  let widest = 0;
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI * (1 - i / steps); // bottom pole → top pole
    const x = Math.sin(a) * Math.pow(Math.sin(a / 2), 1.5);
    widest = Math.max(widest, x);
    profile.push({ x, y: Math.cos(a) });
  }
  return new THREE.LatheGeometry(
    profile.map((p) => new THREE.Vector2(Math.max((p.x / widest) * r, 0.0001), (p.y * len) / 2)),
    sides,
  );
}

/**
 * The blob's seeded lump field.
 *
 * Simplex rather than the product of sines this used to be, because a product of sines puts its
 * zeros on a regular lattice: the lumps landed on a grid aligned to the axes, which is precisely
 * the artefact a shape meant to read as organic cannot have. Stacking octaves did not help, since
 * every octave shared the alignment.
 *
 * The seed is a translation of the sample point rather than a parameter of the field, which is
 * what a lattice noise wants — two seeds are two different regions of one infinite field, so they
 * cannot rhyme the way two phase offsets of the same sine can.
 */
function lumpField(x: number, y: number, z: number, seed: number): number {
  const offset = seed * 37.19;
  // Sampled at 0.45x, which is the reference's own migration note: simplex is a markedly
  // higher-frequency field than the smooth trig octaves this replaced (~2.5x the slope), so the
  // same coordinates give a crumpled surface where the shape wants one or two broad lumps. Two
  // octaves rather than three for the same reason — the third only adds the fine detail the
  // comment above deliberately avoids.
  const f = 0.45;
  return fbmSimplex3d(x * f + offset, y * f - offset * 0.61, z * f + offset * 0.29, 2, 2.05, 0.5);
}

/**
 * NOT a lathe: a sphere with seeded low-frequency lumps baked into its vertices — the organic
 * counterpart to `sphere`, for anything gooey. The sphere's seam and pole vertices are welded by
 * position first, so the recomputed normals are smooth everywhere; without the weld the UV seam
 * splits the normals and draws a hard line straight through the refraction.
 */
export function blob({
  r = 1.4,
  sides = 64,
  seed = 1,
  bump = 0.5,
}: BlobOptions = {}): THREE.BufferGeometry {
  const source = new THREE.SphereGeometry(r, sides, Math.max(8, Math.round(sides * 0.75)));

  // Weld duplicated vertices (seam column, pole fans) by quantized position. Only position
  // survives — uv/normal differ across the seam and would defeat the merge; the glass shader
  // reads neither, and normals are recomputed below.
  const pos = source.getAttribute("position");
  const index = source.getIndex();
  const keyToVertex = new Map<string, number>();
  const remap: number[] = [];
  const welded: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let v = keyToVertex.get(key);
    if (v === undefined) {
      v = welded.length / 3;
      keyToVertex.set(key, v);
      welded.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    remap[i] = v;
  }
  const indices: number[] = [];
  const src = index ? index.array : null;
  const triCount = (src ? src.length : pos.count) / 3;
  for (let t = 0; t < triCount; t++) {
    const a = remap[src ? src[t * 3] : t * 3];
    const b = remap[src ? src[t * 3 + 1] : t * 3 + 1];
    const c = remap[src ? src[t * 3 + 2] : t * 3 + 2];
    if (a !== b && b !== c && c !== a) indices.push(a, b, c); // drop the poles' degenerate quads
  }
  source.dispose();

  // Radial displacement by the seeded field. Low frequency on purpose: fine noise reads as
  // damage, one or two broad lumps read as a bead of something viscous.
  const array = new Float32Array(welded);
  const amount = bump * 0.22 * r;
  for (let i = 0; i < array.length; i += 3) {
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];
    const push = 1 + (lumpField((x / r) * 1.25, (y / r) * 1.25, (z / r) * 1.25, seed) * amount) / r;
    array[i] = x * push;
    array[i + 1] = y * push;
    array[i + 2] = z * push;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(array, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** NOT a lathe: a 2D path swept along Z, for arrows and blades. */
export function extrude({
  shape,
  depth = 0.5,
  bevel = 0.06,
}: ExtrudeOptions): THREE.BufferGeometry {
  return new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 3,
    curveSegments: 24,
  }).center();
}

export function arrow({
  len = 4,
  shaft = 0.35,
  head = 1,
  depth = 0.5,
  cuts = [],
}: ArrowOptions = {}): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const b = shaft / 2;
  const hx = len / 2 - head;
  s.moveTo(-len / 2, -b);
  s.lineTo(hx, -b);
  s.lineTo(hx, -head / 2);
  s.lineTo(len / 2, 0);
  s.lineTo(hx, head / 2);
  s.lineTo(hx, b);
  s.lineTo(-len / 2, b);
  s.closePath();
  // Only the holes are compensated. An arrow's outline is a swept path, not a plate, and every
  // scene that already has one was authored against its uncompensated size — so it keeps it.
  const bevel = bevelFor(0.06, cuts, shaft, depth);
  for (const cut of cuts) s.holes.push(cutPath(cut, bevel));
  return extrude({ shape: s, depth, bevel });
}

/**
 * A rounded-rectangular plate, extruded toward the lens — the primitive the lathes cannot make.
 *
 * A four-sided lathe already gives a square plate, and `assembly` used one for years, but its
 * fillet rounds the flat ENDS of the sweep, never the four vertical corners: the silhouette stays
 * hard. A slab rounds the silhouette, which is the whole difference between a plate and a tile.
 *
 * Authored in XY and swept along Z, like `arrow` — so it is already flat to the camera and is
 * posed by rotating it away, rather than by `facing()` aiming a sweep axis at the lens.
 */
export function slab({
  w = 4,
  h = 5,
  depth = 0.6,
  r = 0.9,
  fillet,
  cuts = [],
}: SlabOptions = {}): THREE.BufferGeometry {
  const bevel = bevelFor(resolveFillet(fillet, Math.min(w, h) * 0.03), cuts, w, h, depth);
  return bevelledExtrude(
    (inset) => roundedRectPoints(w - inset * 2, h - inset * 2, r - inset),
    cuts,
    depth,
    bevel,
  );
}

/** The smaller side of a contour's bounding box — the widest bevel that contour can survive. */
function minSpan(contour: readonly THREE.Vector2[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of contour) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return Math.min(maxX - minX, maxY - minY);
}

/**
 * An arbitrary silhouette, given as SVG path data and extruded toward the lens.
 *
 * The escape hatch, and the only builder here that takes a string. Everything else in this module
 * describes a solid with numbers because the solids it describes CAN be — a rod has a radius — and
 * the shapes this is for cannot: a pair of spectacles has no radius, only an outline. Authored in
 * XY and swept along Z like `slab` and `arrow`, so it is already flat to the camera.
 *
 * `fitOutline` does the reorienting and refitting that make a pasted `d` land in scene units; see
 * there for why each half of it is necessary.
 *
 * The DEPTH is compensated for the bevel and the outline is not, which is not an oversight either
 * way. Depth is a number the config asked for and `defaultPath` hands straight to Beer-Lambert, so
 * a solid a bevel's width thicker than it claims absorbs visibly more light than the scene was
 * authored for. The outline cannot be compensated on the same terms: correctly insetting an
 * arbitrary contour is a polygon-offset problem whose answer for a non-convex one is not even a
 * single contour. So the drawing comes out as drawn, plus the bevel's own lip — the trade `arrow`
 * makes, for the same reason. What keeps that lip from swamping fine detail is the default bevel
 * being measured against the outline's NARROWEST limb rather than its bounding box, and a negative
 * `fillet` turning it off outright.
 */
export function pathShape({
  outline,
  r = 2,
  depth = 0.6,
  fillet,
  cuts = [],
}: PathOptions = {}): THREE.BufferGeometry {
  // An unparseable outline falls back rather than throwing: `buildShape` has to return geometry
  // for every config, and a shape that vanished would look like a renderer fault rather than like
  // the typo it is.
  let placed = fitOutline(outline ?? DEFAULT_OUTLINE, r);
  if (placed.length === 0) placed = fitOutline(DEFAULT_OUTLINE, r);

  const [outer, ...holes] = placed;
  // A drawn silhouette is the one shape here whose detail a bevel can visibly fatten, so it is
  // also the one that can refuse a bevel outright — see ShapeConfig.fillet.
  const bevel =
    fillet !== undefined && fillet < 0 ? 0 : pathBevel(outer, holes, cuts, depth, r, fillet);

  const shape = new THREE.Shape(outer);
  for (const hole of holes) shape.holes.push(new THREE.Path(hole));
  for (const cut of cuts) shape.holes.push(cutPath(cut, bevel));
  return extrude({ shape, depth: Math.max(0.01, depth - bevel * 2), bevel });
}

/**
 * The bevel a drawn outline can carry.
 *
 * Four clamps, and they exist for different reasons. The proportional DEFAULT is the narrowest
 * limb rather than the bounding box, because that is what a bevel on a hand-drawn shape actually
 * has to fit inside. `bevelFor` then applies the box, the depth and the carve-outs. And each
 * subpath hole gets the protection `bevelFor` gives a cut, because extrude offsets a hole's
 * contour OUTWARD to form its lip: one wider than half the hole's short side turns it inside out
 * and the shape renders with a black knot where the opening should be.
 *
 * One bevel serves the WHOLE outline — `ExtrudeGeometry` has a single `bevelSize` — so a shape
 * with one fine limb comes out less rounded everywhere, not just along the limb. That is the right
 * way round: a uniform slightly-crisper edge reads as a design choice, a limb swallowed by its own
 * fillet reads as a broken mesh.
 */
function pathBevel(
  outer: readonly THREE.Vector2[],
  holes: readonly THREE.Vector2[][],
  cuts: readonly CutConfig[],
  depth: number,
  r: number,
  fillet: number | undefined,
): number {
  const feature = narrowestFeature(outer);
  const proportional = Math.min(
    Number.isFinite(feature) ? feature * 0.22 : Infinity,
    r * 0.04,
    depth * 0.25,
  );
  let bevel = bevelFor(resolveFillet(fillet, proportional), cuts, minSpan(outer), depth);
  for (const hole of holes) bevel = Math.min(bevel, (minSpan(hole) / 2) * 0.45);
  return Math.max(0, bevel);
}

/**
 * A plate's outline as a polygon, at the SAME vertex angles its lathe would use.
 *
 * This is what lets `disc`, `prism` and `hex` swap representation the moment they carry a cut
 * without appearing to move. Lathe places vertex `i` at `(r·sin φ, y, r·cos φ)` for `φ = 2πi/n`;
 * extruding in XY and rotating by +90° about X sends `(x, y, z)` to `(x, −z, y)`, so the two agree
 * when the polygon angle is `π/2 + 2πi/n`. Get that offset wrong and adding a slot to a hexagon
 * silently spins it half a facet.
 */
function plateOutline(r: number, sides: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = Math.PI / 2 + (Math.PI * 2 * i) / sides;
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return pts;
}

/**
 * The carved twin of a lathed plate: same outline, same orientation, holes through the face.
 *
 * Only reached when a shape actually carries cuts, so nothing that has ever rendered changes.
 * The bevel stands in for the lathe's corner fillet — close enough at plate thicknesses that the
 * two are hard to tell apart, and the alternative is a boolean solver.
 */
function carvedPlate(
  r: number,
  thickness: number,
  sides: number,
  fillet: number,
  cuts: readonly CutConfig[],
): THREE.BufferGeometry {
  const bevel = bevelFor(resolveFillet(fillet, thickness * 0.3), cuts, r * 2, thickness);
  // A polygon insets off its EDGES, so the circumradius loses bevel / cos(π/n) — for a square
  // that is 1.41× the bevel, and ignoring it would leave a slotted plate visibly fatter than the
  // lathe it replaced.
  const geometry = bevelledExtrude(
    (inset) => plateOutline(Math.max(0.01, r - inset / Math.cos(Math.PI / sides)), sides),
    cuts,
    thickness,
    bevel,
  );
  // Stand it up the way the lathe leaves it: face normal along Y, not Z.
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** Build the geometry a {@link ShapeConfig} describes. */
export function buildShape(shape: ShapeConfig): THREE.BufferGeometry {
  const { kind, r, len, thickness, fillet, bevel, sides, hole, shaft, head, depth, seed, bump } =
    shape;
  const cuts = shape.cuts ?? [];
  // The plates are lathes until you carve one, then they are extrusions. Same outline either way
  // (see plateOutline) — this is a change of representation, not of shape.
  if (cuts.length > 0 && (kind === "disc" || kind === "prism" || kind === "hex")) {
    return carvedPlate(
      r,
      kind === "disc" ? thickness : len,
      kind === "hex" ? 6 : sides,
      fillet,
      cuts,
    );
  }
  switch (kind) {
    case "slab":
      return slab({ w: len, h: thickness, depth, r, fillet, cuts });
    case "path":
      return pathShape({ outline: shape.outline, r, depth, fillet, cuts });
    case "droplet":
      return droplet({ r, len, sides });
    case "blob":
      return blob({ r, sides, seed, bump });
    case "disc":
      return disc({ r, thickness, fillet, sides });
    case "prism":
      // A bevel means every edge is rounded, which a lathe cannot do — see beveledPrism().
      return bevel > 0 ? beveledPrism({ r, len, sides, bevel }) : prism({ r, len, sides, fillet });
    case "hex":
      return bevel > 0
        ? beveledPrism({ r, len, sides: 6, bevel })
        : prism({ r, len, sides: 6, fillet });
    case "cone":
      return cone({ r, len, sides });
    case "sphere":
      return sphere({ r, sides });
    case "ring":
      return ring({ r, hole, thickness, sides });
    case "arrow":
      return arrow({ len, shaft, head, depth, cuts });
    case "rod":
    default:
      return rod({ r, len, fillet, sides });
  }
}

/**
 * Half the optical path through a shape at normal incidence — the default for `material.path`.
 *
 * This exists because getting it wrong is the single easiest way to ruin a scene: `path` feeds
 * the Beer–Lambert chord, and for a flat disc the optical path is its *thickness*, not its
 * radius. Passing a 3.4-unit radius where 0.38 was meant saturates absorption and the shape
 * renders as opaque plastic. Deriving it from the geometry makes the mistake impossible unless
 * you deliberately override it.
 */
export function defaultPath(shape: ShapeConfig): number {
  switch (shape.kind) {
    case "disc":
    case "ring":
      return shape.thickness / 2;
    case "prism":
    case "hex":
      // A squat prism is a disc; a long one is a rod. Whichever axis is shorter is the path.
      return Math.min(shape.r, shape.len / 2);
    case "cone":
      // Averaged over the height, a cone's chord is about half a cylinder's.
      return shape.r / 2;
    case "arrow":
    case "slab":
    case "path":
      return shape.depth / 2;
    case "droplet":
      // Spherical through the belly, thin at the tip — the same over-absorption trade the
      // sphere makes, softened for the taper.
      return shape.r * 0.8;
    case "blob":
      return shape.r;
    case "sphere":
    case "rod":
    default:
      return shape.r;
  }
}

/** Bevel radius as a fraction of the circumradius, arc/ring/edge subdivision. Ported from the
 *  reference's prism-mesh.ts, whose values are an 0.8mm fillet on a 57mm solid. */
const BEVEL_CORNER_SEGMENTS = 4;
const BEVEL_RING_SEGMENTS = 4;
const BEVEL_EDGE_SEGMENTS = 16;

interface ContourPoint {
  /** In the lathe's cross-section plane: (x, z). */
  p: [number, number];
  n: [number, number];
}

/**
 * The cross-section outline with every corner replaced by a tangent arc.
 *
 * Each corner's arc is the circle of `radius` inscribed against both adjacent edges, so the
 * outline stays tangent-continuous — no crease where the arc meets the straight run, which is the
 * whole point: a crease catches the environment as a hard line and reads as a modelling error.
 */
function norm2(v: [number, number]): [number, number] {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Outward normal of one edge of a counter-clockwise outline. */
function edgeNormal2(a: [number, number], b: [number, number]): [number, number] {
  const e: [number, number] = [b[0] - a[0], b[1] - a[1]];
  const l = Math.hypot(e[0], e[1]) || 1;
  return [e[1] / l, -e[0] / l];
}

function roundedContour(corners: [number, number][], radius: number): ContourPoint[] {
  const arcs = corners.map((corner, i) => {
    const prev = corners[(i + corners.length - 1) % corners.length];
    const next = corners[(i + 1) % corners.length];
    const toPrev = norm2([prev[0] - corner[0], prev[1] - corner[1]]);
    const toNext = norm2([next[0] - corner[0], next[1] - corner[1]]);
    const half =
      Math.acos(Math.min(1, Math.max(-1, toPrev[0] * toNext[0] + toPrev[1] * toNext[1]))) / 2;
    const tangent = radius / Math.max(Math.tan(half), 1e-6);
    const centreDist = radius / Math.max(Math.sin(half), 1e-6);
    const bisector = norm2([toPrev[0] + toNext[0], toPrev[1] + toNext[1]]);
    const centre: [number, number] = [
      corner[0] + bisector[0] * centreDist,
      corner[1] + bisector[1] * centreDist,
    ];
    const start: [number, number] = [
      corner[0] + toPrev[0] * tangent,
      corner[1] + toPrev[1] * tangent,
    ];
    const end: [number, number] = [
      corner[0] + toNext[0] * tangent,
      corner[1] + toNext[1] * tangent,
    ];
    const a0 = Math.atan2(start[1] - centre[1], start[0] - centre[0]);
    let a1 = Math.atan2(end[1] - centre[1], end[0] - centre[0]);
    while (a1 <= a0) a1 += Math.PI * 2;
    return Array.from({ length: BEVEL_CORNER_SEGMENTS + 1 }, (_, step): ContourPoint => {
      const a = a0 + ((a1 - a0) * step) / BEVEL_CORNER_SEGMENTS;
      const n: [number, number] = [Math.cos(a), Math.sin(a)];
      return { p: [centre[0] + n[0] * radius, centre[1] + n[1] * radius], n };
    });
  });

  // The straight runs are subdivided too. A single long quad per side would span the whole face,
  // and any per-vertex lighting variation across it would then interpolate as a visible gradient.
  return arcs.flatMap((arc, i) => {
    const end = arc[arc.length - 1];
    const nextStart = arcs[(i + 1) % arcs.length][0];
    const n = edgeNormal2(corners[i], corners[(i + 1) % corners.length]);
    const straight = Array.from({ length: BEVEL_EDGE_SEGMENTS - 1 }, (_, step): ContourPoint => {
      const t = (step + 1) / BEVEL_EDGE_SEGMENTS;
      return {
        p: [end.p[0] + (nextStart.p[0] - end.p[0]) * t, end.p[1] + (nextStart.p[1] - end.p[1]) * t],
        n,
      };
    });
    return [...arc, ...straight];
  });
}

/**
 * A prism with a fillet on ALL its edges, not just the two cap rings a lathe can round.
 *
 * `prism()` builds a lathe, whose `fillet` rounds where the side faces meet the caps and leaves
 * the vertical corners geometrically sharp. This rounds those too: the cross-section's corners
 * become tangent arcs, and quarter-round rings blend the sides into inset caps. What that buys is
 * a narrow bevel strip all the way around the solid, sitting at an angle to both surfaces it
 * joins — so it catches the environment differently from either and reads as a faceted block of
 * glass rather than a flat silhouette.
 *
 * Ported from the reference's prism-mesh.ts. Built in the same local frame `prism()` uses — the
 * cross-section in XZ, the depth along Y — so an item can swap between the two without moving,
 * and the analytic planes the beam and the refraction tracer use stay valid.
 */
export function beveledPrism({
  r = 2,
  len = 0.6,
  sides = 3,
  bevel = 0.008,
}: { r?: number; len?: number; sides?: number; bevel?: number } = {}): THREE.BufferGeometry {
  const half = len / 2;
  const radius = Math.min(bevel, len * 0.45, r * 0.45);
  const corners: [number, number][] = Array.from(
    { length: Math.max(3, Math.floor(sides)) },
    (_, i) => {
      const a = (Math.PI * 2 * i) / Math.max(3, Math.floor(sides));
      return [Math.sin(a) * r, Math.cos(a) * r];
    },
  );
  const contour = roundedContour(corners, radius);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const rings: number[][] = [];

  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    return index;
  };

  const addRing = (theta: number, y: number, yNormal: number): void => {
    const inset = radius * (1 - Math.cos(theta));
    const weight = Math.cos(theta);
    rings.push(
      contour.map(({ p, n }) =>
        push(p[0] - n[0] * inset, y, p[1] - n[1] * inset, n[0] * weight, yNormal, n[1] * weight),
      ),
    );
  };

  // Stop a little short of a right angle: at exactly pi/2 every sample around a corner arc
  // collapses onto the same point and the cap's corner triangles lose their area.
  const maxTheta = Math.PI / 2 - 0.06;
  const maxSine = Math.sin(maxTheta);
  for (let step = BEVEL_RING_SEGMENTS; step >= 0; step--) {
    const theta = (maxTheta * step) / BEVEL_RING_SEGMENTS;
    addRing(theta, -half + radius - (radius * Math.sin(theta)) / maxSine, -Math.sin(theta));
  }
  for (let step = 0; step <= BEVEL_RING_SEGMENTS; step++) {
    const theta = (maxTheta * step) / BEVEL_RING_SEGMENTS;
    addRing(theta, half - radius + (radius * Math.sin(theta)) / maxSine, Math.sin(theta));
  }

  for (let band = 0; band < rings.length - 1; band++) {
    const a = rings[band];
    const b = rings[band + 1];
    for (let i = 0; i < contour.length; i++) {
      const j = (i + 1) % contour.length;
      indices.push(a[i], a[j], b[j], a[i], b[j], b[i]);
    }
  }

  const addCap = (source0: number[], ny: number, reverse: boolean): void => {
    const cap = source0.map((source) =>
      push(positions[source * 3], positions[source * 3 + 1], positions[source * 3 + 2], 0, ny, 0),
    );
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const index of cap) {
      cx += positions[index * 3];
      cy += positions[index * 3 + 1];
      cz += positions[index * 3 + 2];
    }
    const centre = push(cx / cap.length, cy / cap.length, cz / cap.length, 0, ny, 0);
    for (let i = 0; i < cap.length; i++) {
      const j = (i + 1) % cap.length;
      if (reverse) indices.push(centre, cap[j], cap[i]);
      else indices.push(centre, cap[i], cap[j]);
    }
  };
  addCap(rings[0], -1, true);
  addCap(rings[rings.length - 1], 1, false);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}
