/**
 * Where a plane cuts a mesh: the contours the beam tracer needs before a `.glb` can stand in the
 * light's way.
 *
 * The tracer is two-dimensional. It walks a polygon in the sheet's plane, refracting at each edge
 * it crosses, which is why `crossSectionFor` can answer for a lathe out of `r` and `sides` and for
 * a `path` out of the outline someone drew. A mesh has neither: its cross-section is not a
 * parameter of the shape, it is a fact about the geometry that has to be computed, and it changes
 * with where the sheet sits and how the item is turned.
 *
 * SO THE EDGES ARE THE KEY, NOT THE POINTS. The obvious way to build contours from a plane cut is
 * to emit a segment per triangle and then stitch segments whose endpoints coincide. That works
 * until floating point stops cooperating: two triangles sharing an edge compute the same crossing
 * from opposite ends, `a + t(b - a)` against `b + (1 - t)(a - b)`, which agree to about fifteen
 * digits and not to the bit, so the stitch needs a tolerance, and a tolerance that closes a small
 * feature also welds two contours that merely pass close. Keying each crossing by the MESH EDGE it
 * lies on removes the arithmetic from the question: two triangles share an edge or they do not,
 * and that is an integer comparison.
 *
 * Which leaves one problem, and it is the reason for the welding pass. An exporter splits vertices
 * wherever the surface creases, because a normal is per-vertex, so the two triangles either side
 * of a hard edge carry different indices for the same corner and the integer test says they are
 * unrelated. Welding by position first puts them back together. It is the one place a tolerance
 * survives, and it is the right place for it: two vertices at the same coordinates ARE the same
 * corner, whatever the exporter had to do to give them different normals.
 */

import * as THREE from "three";

/**
 * How coarse the vertex weld is, as a fraction of the mesh's largest dimension.
 *
 * Generous by the standards of exact arithmetic and tiny by the standards of geometry: a millionth
 * of the bounding box is far below any feature a beam could refract through, and far above the
 * error an exporter's own float round-trip introduces at a crease.
 */
const WELD = 1e-6;

/** A crossing point, identified by the welded mesh edge it lies on rather than by its coordinates. */
type EdgeKey = number;

/** Pack an unordered pair of welded vertex indices into one number, so a Map can key on it. */
function edgeKey(a: number, b: number): EdgeKey {
  return a < b ? a * 0x1000000 + b : b * 0x1000000 + a;
}

/** Signed area, twice over. Positive is counter-clockwise; the magnitude ranks contours by size. */
export function contourArea(contour: readonly THREE.Vector2[]): number {
  let sum = 0;
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    sum += (contour[j].x - contour[i].x) * (contour[j].y + contour[i].y);
  }
  return sum / 2;
}

/**
 * The closed contours where the plane `z` cuts `geometry` posed by `matrix`, in world XY.
 *
 * Returns them largest first, by absolute area, so a caller wanting the silhouette takes the head
 * of the list and one wanting the openings takes the tail. Empty when the plane misses.
 *
 * OPEN CHAINS ARE DROPPED. A watertight mesh cut by a plane yields closed loops and nothing else;
 * a chain that runs out of segments means the surface had a hole in it, and a contour that does
 * not close has no inside for the tracer's entering-and-leaving bookkeeping to be right about.
 * Silently closing it would invent a wall the mesh does not draw.
 */
export function sliceGeometry(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  z: number,
): THREE.Vector2[][] {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const count = position.count;
  if (count === 0) return [];

  // Posed once, not per triangle: an indexed mesh shares each vertex between about six of them.
  const world = new Float32Array(count * 3);
  const point = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    point.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(matrix);
    world[i * 3] = point.x;
    world[i * 3 + 1] = point.y;
    world[i * 3 + 2] = point.z;
  }

  // Weld by position, so a crease the exporter split reads as one corner again. The grid is sized
  // from the posed mesh, which is what makes WELD a proportion rather than a world distance.
  let span = 0;
  for (let i = 0; i < count; i++) {
    span = Math.max(
      span,
      Math.abs(world[i * 3]),
      Math.abs(world[i * 3 + 1]),
      Math.abs(world[i * 3 + 2]),
    );
  }
  const grid = Math.max(span, 1) * WELD;
  const welded = new Int32Array(count);
  const seen = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key =
      `${Math.round(world[i * 3] / grid)},` +
      `${Math.round(world[i * 3 + 1] / grid)},` +
      `${Math.round(world[i * 3 + 2] / grid)}`;
    const hit = seen.get(key);
    if (hit === undefined) {
      seen.set(key, i);
      welded[i] = i;
    } else welded[i] = hit;
  }

  /** Crossings by edge, interpolated once however many triangles meet there. */
  const crossings = new Map<EdgeKey, THREE.Vector2>();
  /** Each triangle's segment, as the pair of edges it enters and leaves by. */
  const segments: [EdgeKey, EdgeKey][] = [];

  const triangles = index ? index.count / 3 : count / 3;
  const corner = [0, 0, 0];
  const height = [0, 0, 0];
  for (let t = 0; t < triangles; t++) {
    for (let c = 0; c < 3; c++) {
      const raw = index ? index.getX(t * 3 + c) : t * 3 + c;
      corner[c] = welded[raw];
      const h = world[raw * 3 + 2] - z;
      // A vertex ON the plane is lifted a hair above it, which is the same thing as sliding the
      // sheet a hair down and cheaper than deciding where to slide it to. The coincidence is not
      // rare: a lathe or a torus puts a whole ring of vertices at one height, and a sheet through
      // the middle of a shape is exactly where anyone aims one. Left at zero those vertices make
      // every crossing on their edges land on top of each other, the contour picks up a run of
      // duplicate points, and two contours that meet at such a ring chain into one.
      height[c] = Math.abs(h) < grid ? grid : h;
    }
    const above = (height[0] >= 0 ? 1 : 0) + (height[1] >= 0 ? 1 : 0) + (height[2] >= 0 ? 1 : 0);
    if (above === 0 || above === 3) continue;

    const ends: EdgeKey[] = [];
    for (let c = 0; c < 3; c++) {
      const d = c === 2 ? 0 : c + 1;
      if (height[c] >= 0 === height[d] >= 0) continue;
      const key = edgeKey(corner[c], corner[d]);
      if (!crossings.has(key)) {
        const t01 = height[c] / (height[c] - height[d]);
        const from = index ? index.getX(t * 3 + c) : t * 3 + c;
        const to = index ? index.getX(t * 3 + d) : t * 3 + d;
        crossings.set(
          key,
          new THREE.Vector2(
            world[from * 3] + t01 * (world[to * 3] - world[from * 3]),
            world[from * 3 + 1] + t01 * (world[to * 3 + 1] - world[from * 3 + 1]),
          ),
        );
      }
      ends.push(key);
    }
    // Two, unless the triangle grazed the plane along one edge, which contributes nothing.
    if (ends.length === 2 && ends[0] !== ends[1]) segments.push([ends[0], ends[1]]);
  }
  if (segments.length === 0) return [];

  // Adjacency, then walk it. A closed contour visits each of its segments exactly once.
  const at = new Map<EdgeKey, number[]>();
  for (let i = 0; i < segments.length; i++) {
    for (const end of segments[i]) {
      const list = at.get(end);
      if (list) list.push(i);
      else at.set(end, [i]);
    }
  }

  const used: boolean[] = Array.from({ length: segments.length }, () => false);
  const contours: THREE.Vector2[][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const first = segments[start][0];
    let end = segments[start][1];
    const loop: EdgeKey[] = [first, end];
    let closed = false;
    for (;;) {
      if (end === first) {
        loop.pop(); // The closing point is the opening one; the contour is implicitly closed.
        closed = true;
        break;
      }
      const next = (at.get(end) ?? []).find((i) => !used[i]);
      if (next === undefined) break; // An open chain: see the note above.
      used[next] = true;
      end = segments[next][0] === end ? segments[next][1] : segments[next][0];
      loop.push(end);
    }
    if (!closed || loop.length < 3) continue;
    contours.push(loop.map((key) => crossings.get(key) as THREE.Vector2));
  }

  // Not `.toSorted()`: that is ES2023, above the es2022 floor the package tsconfig's `lib`
  // enforces. `contours` was built here and is being returned, so sorting it in place mutates
  // nothing a caller owns.
  // oxlint-disable-next-line unicorn/no-array-sort
  return contours.sort((a, b) => Math.abs(contourArea(b)) - Math.abs(contourArea(a)));
}
