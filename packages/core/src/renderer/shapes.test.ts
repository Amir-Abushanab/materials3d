import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  createItem,
  createMotion,
  createShape,
  DEFAULT_OUTLINE,
  FRAME_ASPECT,
  MAX_OUTLINE,
  normalizeShape,
} from "../config/model";
import { bakeScatter, expandScatter, frameFov, resolveItems } from "./MaterialRenderer";
import { applyMotion, loopFrequency } from "./motions";
import type { MaterialItem } from "./item";
import {
  arrow,
  blob,
  buildShape,
  defaultPath,
  disc,
  droplet,
  hex,
  pathShape,
  ring,
  rod,
  slab,
  sphere,
} from "./shapes";
import { createDefaultConfig } from "../config/model";

function bounds(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox as THREE.Box3;
}

function isFinitePositions(geometry: THREE.BufferGeometry): boolean {
  const array = geometry.getAttribute("position").array;
  for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) return false;
  return true;
}

describe("shape builders", () => {
  it("lathes a rod to the requested radius and length", () => {
    const box = bounds(rod({ r: 0.5, len: 8 }));
    expect(box.max.y - box.min.y).toBeCloseTo(8, 3);
    expect(box.max.x).toBeCloseTo(0.5, 2);
  });

  it("builds a hexagonal prism as a six-sided lathe", () => {
    // Six sides means six distinct radial directions — the whole point of the lathe observation.
    const geometry = hex({ r: 2, len: 0.9 });
    const box = bounds(geometry);
    expect(box.max.y - box.min.y).toBeCloseTo(0.9, 3);
    expect(isFinitePositions(geometry)).toBe(true);
  });

  it("keeps a cone's tip off the axis so its normals stay defined", () => {
    const geometry = buildShape({ ...createShape("cone"), r: 1.5, len: 3 });
    expect(isFinitePositions(geometry)).toBe(true);
    const normals = geometry.getAttribute("normal").array;
    for (let i = 0; i < normals.length; i++) expect(Number.isFinite(normals[i])).toBe(true);
  });

  it("builds a ring even when the hole is asked to swallow the outer radius", () => {
    expect(isFinitePositions(ring({ r: 2, hole: 9, thickness: 0.5 }))).toBe(true);
  });

  it("centres an extruded arrow on its own bounds", () => {
    const box = bounds(arrow({ len: 6, shaft: 0.4, head: 1.4, depth: 0.5 }));
    expect(box.max.x + box.min.x).toBeCloseTo(0, 5);
    expect(box.max.z + box.min.z).toBeCloseTo(0, 5);
  });

  it("dispatches every kind without throwing", () => {
    for (const kind of [
      "rod",
      "disc",
      "prism",
      "hex",
      "cone",
      "sphere",
      "ring",
      "arrow",
      "droplet",
      "blob",
    ] as const) {
      expect(isFinitePositions(buildShape(normalizeShape({ kind })))).toBe(true);
    }
  });

  it("normalizes a droplet so r is the radius at the widest point", () => {
    const box = bounds(droplet({ r: 1.5, len: 3.6 }));
    expect(box.max.x).toBeCloseTo(1.5, 3);
    expect(box.max.y - box.min.y).toBeCloseTo(3.6, 3);
  });

  it("keeps a droplet's tip off the axis so its normals stay defined", () => {
    const geometry = droplet({ r: 1, len: 2.5 });
    const normals = geometry.getAttribute("normal").array;
    for (let i = 0; i < normals.length; i++) expect(Number.isFinite(normals[i])).toBe(true);
  });

  it("builds the same blob for the same seed, and a different one for another", () => {
    const a = blob({ r: 1.4, seed: 7 }).getAttribute("position").array;
    const b = blob({ r: 1.4, seed: 7 }).getAttribute("position").array;
    const c = blob({ r: 1.4, seed: 8 }).getAttribute("position").array;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it("keeps a blob's lumps within the advertised departure from the sphere", () => {
    const geometry = blob({ r: 1, seed: 3, bump: 1 });
    const positions = geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) {
      const length = Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i));
      expect(length).toBeGreaterThan(0.7);
      expect(length).toBeLessThan(1.3);
    }
    const normals = geometry.getAttribute("normal").array;
    for (let i = 0; i < normals.length; i++) expect(Number.isFinite(normals[i])).toBe(true);
  });
});

describe("defaultPath", () => {
  it("uses HALF THE THICKNESS for a disc, not its radius", () => {
    // The pitfall this function exists to remove: a 3.4-unit radius where 0.375 was meant
    // saturates Beer-Lambert and the disc renders as opaque plastic.
    const shape = { ...createShape("disc"), r: 3.4, thickness: 0.75 };
    expect(defaultPath(shape)).toBeCloseTo(0.375, 5);
    expect(defaultPath(shape)).toBeLessThan(shape.r);
  });

  it("uses the tube radius for a rod", () => {
    expect(defaultPath({ ...createShape("rod"), r: 0.42 })).toBeCloseTo(0.42, 5);
  });

  it("takes the shorter axis of a prism, so a squat hex behaves like a disc", () => {
    expect(defaultPath({ ...createShape("hex"), r: 2.7, len: 0.9 })).toBeCloseTo(0.45, 5);
    expect(defaultPath({ ...createShape("hex"), r: 0.3, len: 9 })).toBeCloseTo(0.3, 5);
  });
});

describe("scatter", () => {
  it("is deterministic for a given seed", () => {
    const scatter = createDefaultConfig().scatter!;
    expect(expandScatter(scatter)).toEqual(expandScatter(scatter));
  });

  it("changes with the seed", () => {
    const scatter = createDefaultConfig().scatter!;
    expect(expandScatter({ ...scatter, seed: 12 })).not.toEqual(expandScatter(scatter));
  });

  it("spreads items across the requested span", () => {
    const scatter = createDefaultConfig().scatter!;
    const items = expandScatter(scatter);
    const xs = items.map((i) => i.position.x);
    expect(Math.min(...xs)).toBeCloseTo(scatter.position.x - scatter.spanX / 2, 5);
    expect(Math.max(...xs)).toBeCloseTo(scatter.position.x + scatter.spanX / 2, 5);
  });

  it("gives each generated rod its own optical path", () => {
    const items = expandScatter(createDefaultConfig().scatter!);
    const paths = new Set(items.map((i) => defaultPath(i.shape)));
    expect(paths.size).toBeGreaterThan(1);
  });

  it("hands each generated shape its own copy of the shared reactions", () => {
    const scatter = createDefaultConfig().scatter!;
    scatter.interaction = { bindings: [{ source: "hoverSelf", target: "hueShift", to: 0.4 }] };
    const items = expandScatter(scatter);
    const first = items[0].interaction?.bindings?.[0];
    const second = items[1].interaction?.bindings?.[0];
    expect(first).toEqual(second);
    // Distinct objects, not one shared reference: binding smoothing is keyed by binding identity,
    // so shared objects would make every generated shape ease as one instead of the hovered rod
    // answering alone.
    expect(first).not.toBe(second);
    expect(first).not.toBe(scatter.interaction.bindings![0]);
  });

  it("takes precedence over an explicit item list", () => {
    const config = createDefaultConfig();
    config.items = [
      {
        shape: createShape("disc"),
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        material: {},
        motion: createMotion(),
        phase: 0,
      },
    ];
    expect(resolveItems(config)).toHaveLength(config.scatter!.count);
    expect(resolveItems({ ...config, scatter: undefined })).toHaveLength(1);
  });
});

describe("geometry sanity", () => {
  it("produces no NaN vertices for degenerate-looking inputs", () => {
    expect(isFinitePositions(disc({ r: 0.01, thickness: 5 }))).toBe(true);
    expect(isFinitePositions(rod({ r: 5, len: 0.01 }))).toBe(true);
    expect(isFinitePositions(sphere({ r: 0.0001 }))).toBe(true);
  });
});

describe("item config identity", () => {
  it("hands each MaterialItem the SAME config object the scene holds", () => {
    // The contract direct manipulation depends on: dragging a shape writes to `item.config`, so
    // if the renderer built items from copies the move would show in the viewport and then
    // vanish on save, undo or reload.
    const config = createDefaultConfig();
    config.scatter = undefined;
    config.items = [createItem(createShape("disc")), createItem(createShape("rod"))];
    const resolved = resolveItems(config);
    expect(resolved[0]).toBe(config.items[0]);
    expect(resolved[1]).toBe(config.items[1]);
  });

  it("bakes a scatter into items that are pixel-identical to what it generated", () => {
    const config = createDefaultConfig();
    const generated = resolveItems(config);
    expect(config.scatter).toBeDefined();
    expect(bakeScatter(config)).toBe(true);
    expect(config.scatter).toBeUndefined();
    expect(config.items).toEqual(generated);
    // Idempotent: an already-authored scene has nothing to bake.
    expect(bakeScatter(config)).toBe(false);
  });
});

/** Visible world height at the focal plane, in units of the focal distance. */
function height(fov: number): number {
  return 2 * Math.tan((fov * Math.PI) / 360);
}

/** Visible world width, same units. */
function width(fov: number, aspect: number): number {
  return height(fov) * aspect;
}

describe("frameFov", () => {
  const FOV = 12;
  const SQUARE = 1;
  const WIDE = 21 / 9;

  it("is inert at the authored aspect, whatever the fit", () => {
    for (const fit of ["cover", "contain", "width", "height"] as const) {
      expect(frameFov(FOV, FRAME_ASPECT, fit)).toBeCloseTo(FOV, 10);
    }
  });

  it("cover crops rather than revealing world beyond the frame", () => {
    // Narrower than 16:9 — the authored height survives and the sides are lost.
    expect(frameFov(FOV, SQUARE, "cover")).toBeCloseTo(FOV, 10);
    // Wider than 16:9 — now the WIDTH would overflow, so the height tightens instead.
    const fov = frameFov(FOV, WIDE, "cover");
    expect(fov).toBeLessThan(FOV);
    expect(width(fov, WIDE)).toBeCloseTo(width(FOV, FRAME_ASPECT), 10);
  });

  it("contain keeps the whole authored frame visible in a square crop", () => {
    const fov = frameFov(FOV, SQUARE, "contain");
    expect(fov).toBeGreaterThan(FOV);
    // The authored width is exactly preserved — this is the point of the fit.
    expect(width(fov, SQUARE)).toBeCloseTo(width(FOV, FRAME_ASPECT), 10);
    // ...and it never crops vertically to get there.
    expect(height(fov)).toBeGreaterThanOrEqual(height(FOV));
  });

  it("width holds the horizontal composition at every aspect", () => {
    for (const aspect of [SQUARE, FRAME_ASPECT, WIDE, 4 / 5, 9 / 16]) {
      const fov = frameFov(FOV, aspect, "width");
      expect(width(fov, aspect)).toBeCloseTo(width(FOV, FRAME_ASPECT), 10);
    }
  });

  it("height reproduces three's own fixed-vertical-fov behaviour", () => {
    for (const aspect of [SQUARE, WIDE, 9 / 16]) {
      expect(frameFov(FOV, aspect, "height")).toBeCloseTo(FOV, 10);
    }
  });

  it("minVisibleWidth only ever widens the view", () => {
    // It bites on `cover` in a square crop, holding 80% of the authored width.
    const clamped = frameFov(FOV, SQUARE, "cover", 0.8);
    expect(width(clamped, SQUARE)).toBeCloseTo(width(FOV, FRAME_ASPECT) * 0.8, 10);
    // ...and is inert for `contain`, which already shows more than that.
    expect(frameFov(FOV, SQUARE, "contain", 0.8)).toBeCloseTo(frameFov(FOV, SQUARE, "contain"), 10);
  });
});

describe("loopFrequency", () => {
  const TAU = Math.PI * 2;

  it("is inert when looping is off, or the motion is still", () => {
    expect(loopFrequency(0.34, 0)).toBe(0.34);
    expect(loopFrequency(0, 6)).toBe(0);
  });

  it("snaps to a whole number of cycles across the loop", () => {
    for (const rate of [0.12, 0.34, 1.1, 2.7, 5]) {
      for (const loop of [4, 6, 12]) {
        const cycles = (loopFrequency(rate, loop) * loop) / TAU;
        expect(cycles).toBeCloseTo(Math.round(cycles), 10);
        expect(cycles).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("keeps direction, so a reversed motion stays reversed", () => {
    expect(loopFrequency(-0.34, 6)).toBeLessThan(0);
    expect(loopFrequency(-0.34, 6)).toBeCloseTo(-loopFrequency(0.34, 6), 10);
  });

  it("never rounds a slow motion down to frozen", () => {
    // 0.01 rad/s over 4s is 0.006 of a cycle — rounding to nearest would stop the shape dead.
    expect(loopFrequency(0.01, 4)).toBeCloseTo(TAU / 4, 10);
  });
});

/** Wrap an angle into one turn — coming back around IS returning to the same pose. */
function turn(v: number): number {
  return ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

function movingItem(
  kind: "skewer" | "spin" | "drift" | "wobble",
  rate: number,
  phase: number,
): MaterialItem {
  return {
    mesh: new THREE.Mesh(),
    home: new THREE.Vector3(0, 1.5, 0),
    homeRotation: new THREE.Euler(0.1, 0.2, 0.3),
    homeScale: new THREE.Vector3(1, 1.2, 1),
    motion: { kind, axis: "x", rate, amount: 0.16 },
    phase,
    config: undefined,
  } as unknown as MaterialItem;
}

/** Pose after advancing to `time`, as a comparable tuple. */
function poseAt(shape: MaterialItem, time: number, loop: number): number[] {
  applyMotion(shape, time, loop);
  const { position: p, rotation: r, scale: s } = shape.mesh;
  return [p.x, p.y, p.z, turn(r.x), turn(r.y), turn(r.z), s.x, s.y, s.z];
}

describe("a looped scene returns to its first frame", () => {
  it("holds for every motion kind, at a phase offset", () => {
    const loop = 6;
    for (const kind of ["skewer", "spin", "drift", "wobble"] as const) {
      const shape = movingItem(kind, 0.34, 1.7);
      const first = poseAt(shape, 0, loop);
      const wrapped = poseAt(shape, loop, loop);
      for (const [i, v] of first.entries()) expect(wrapped[i]).toBeCloseTo(v, 8);
    }
  });

  it("does NOT hold without a loop length — which is the bug it fixes", () => {
    const shape = movingItem("skewer", 0.34, 0);
    const first = poseAt(shape, 0, 0);
    const wrapped = poseAt(shape, 6, 0);
    expect(wrapped[3]).not.toBeCloseTo(first[3], 2);
  });
});

describe("wobble", () => {
  it("preserves volume and squashes relative to the authored scale", () => {
    const shape = movingItem("wobble", 1.1, 0.7);
    for (const time of [0, 0.37, 1.9, 4.2]) {
      applyMotion(shape, time, 0);
      const { scale } = shape.mesh;
      // homeScale is (1, 1.2, 1), so the preserved volume is 1.2.
      expect(scale.x * scale.y * scale.z).toBeCloseTo(1.2, 6);
    }
  });

  it("leaves the pose alone — squash is all it owns", () => {
    const shape = movingItem("wobble", 1.1, 0.7);
    applyMotion(shape, 2.3, 0);
    expect(shape.mesh.position.x).toBe(0);
    expect(shape.mesh.rotation.x).toBe(0);
  });
});

describe("a baked scatter gives every shape its own material", () => {
  it("does not share one object across the items", () => {
    const config = createDefaultConfig();
    expect(config.scatter).toBeDefined();
    bakeScatter(config);
    expect(config.items.length).toBeGreaterThan(2);

    // Reference identity is the actual bug: the panel binds item.material and mutates it in
    // place, so a shared object means editing one shape edits every shape.
    const first = config.items[0].material;
    for (const item of config.items.slice(1)) expect(item.material).not.toBe(first);
  });

  it("keeps an edit to one shape local to it", () => {
    const config = createDefaultConfig();
    bakeScatter(config);
    config.items[0].material = { ...config.items[0].material, ior: 1.9 };
    // Mutate in place too — that is what the control panel actually does.
    Object.assign(config.items[1].material, { density: 9 });

    expect(config.items[0].material.ior).toBe(1.9);
    expect(config.items[1].material.ior).not.toBe(1.9);
    expect(config.items[1].material.density).toBe(9);
    expect(config.items[2].material.density).not.toBe(9);
  });
});

/** Every vertex coordinate, flat — a local `positions` is already taken above. */
function vertexCoords(geometry: THREE.BufferGeometry): number[] {
  return Array.from(geometry.getAttribute("position").array as Float32Array);
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return index ? index.count / 3 : geometry.getAttribute("position").count / 3;
}

const SLOT = { kind: "rect" as const, x: 0, y: 0, w: 0.5, h: 2, r: 0.25, rotation: 0 };

describe("cuts", () => {
  it("slabs are rounded plates flat to the lens", () => {
    const box = bounds(slab({ w: 4, h: 5, depth: 0.6, r: 0.9 }));
    expect(box.max.x).toBeCloseTo(2, 1);
    expect(box.max.y).toBeCloseTo(2.5, 1);
    // Depth is the SHORT axis: a slab faces the camera, unlike a lathe plate which faces +Y.
    expect(box.max.z - box.min.z).toBeLessThan(box.max.x - box.min.x);
  });

  it("carving adds surface without changing the silhouette", () => {
    const solid = slab({ w: 4, h: 5, depth: 0.6, r: 0.9 });
    const carved = slab({ w: 4, h: 5, depth: 0.6, r: 0.9, cuts: [SLOT] });
    expect(triangleCount(carved)).toBeGreaterThan(triangleCount(solid));
    expect(bounds(carved).max.x).toBeCloseTo(bounds(solid).max.x, 5);
    expect(bounds(carved).max.y).toBeCloseTo(bounds(solid).max.y, 5);
  });

  it("produces no degenerate vertices", () => {
    for (const value of vertexCoords(slab({ w: 3, h: 3, depth: 0.5, r: 0.6, cuts: [SLOT] }))) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  /**
   * The one that matters: a plate swaps its lathe for an extrusion the moment it carries a cut,
   * and if that swap moved or spun it, adding a slot would appear to knock the shape out of place.
   */
  it("leaves a carved plate exactly where its lathe stood", () => {
    const lathe = bounds(buildShape({ ...createShape("disc"), r: 3, thickness: 0.5 }));
    const carved = bounds(
      buildShape({ ...createShape("disc"), r: 3, thickness: 0.5, cuts: [SLOT] }),
    );
    // Face normal still along Y — the thin axis has not migrated to Z.
    expect(carved.max.y - carved.min.y).toBeCloseTo(lathe.max.y - lathe.min.y, 1);
    expect(carved.max.x).toBeCloseTo(lathe.max.x, 1);
    expect(carved.max.z).toBeCloseTo(lathe.max.z, 1);
  });

  it("keeps a hexagon on its lathe's facets", () => {
    const solid = bounds(buildShape({ ...createShape("hex"), r: 2, len: 0.5 }));
    const carved = bounds(buildShape({ ...createShape("hex"), r: 2, len: 0.5, cuts: [SLOT] }));
    // A lathed hexagon puts vertex 0 on +Z and its flats on ±X, so the two extents differ by
    // sin 60°. Both numbers have to survive the swap, or the facets have rotated.
    expect(carved.max.z).toBeCloseTo(solid.max.z, 1);
    expect(carved.max.x).toBeCloseTo(solid.max.x, 1);
    expect(carved.max.x / carved.max.z).toBeCloseTo(Math.sin(Math.PI / 3), 1);
  });

  it("ignores cuts on shapes whose profile sweeps", () => {
    const plain = buildShape({ ...createShape("rod"), r: 0.5, len: 4 });
    const cut = buildShape({ ...createShape("rod"), r: 0.5, len: 4, cuts: [SLOT] });
    expect(triangleCount(cut)).toBe(triangleCount(plain));
  });

  it("a circle cut is a rect whose radius ate it", () => {
    const round = normalizeShape({ kind: "slab", cuts: [{ kind: "circle", w: 1.2, h: 9, r: 9 }] });
    expect(round.cuts?.[0]).toMatchObject({ kind: "circle", w: 1.2, h: 1.2, r: 0.6 });
  });

  it("clamps a corner radius that would invert the fillet", () => {
    const wide = normalizeShape({ kind: "slab", cuts: [{ kind: "rect", w: 1, h: 4, r: 99 }] });
    expect(wide.cuts?.[0].r).toBeCloseTo(0.5);
  });

  it("leaves solid shapes without a cuts field at all", () => {
    expect(normalizeShape({ kind: "slab" }).cuts).toBeUndefined();
    expect(normalizeShape({ kind: "slab", cuts: [] }).cuts).toBeUndefined();
  });

  it("a slab's optical path is its depth, not its width", () => {
    expect(defaultPath({ ...createShape("slab"), len: 9, depth: 0.6 })).toBeCloseTo(0.3);
  });
});

/**
 * The `path` kind: an arbitrary silhouette, given as SVG path data.
 *
 * The parser has its own suite next door. What is tested here is the part that turns a pasted `d`
 * into a solid in THIS scene's units — the flip, the fit and the holes — because those are the
 * three places where a shape can come out mirrored, invisible or filled in, and all three look
 * like a broken renderer rather than a convention.
 */
describe("path outlines", () => {
  /** A 10x10 square, drawn in SVG's y-down coordinates. */
  const SQUARE = "M0 0 H10 V10 H0 Z";

  /** A fillet small enough to isolate the fit from the bevel's lip, which is measured on its own
   *  below. Zero is not available: `0` means "pick a proportional one" everywhere in this module. */
  const HAIRLINE = { fillet: 0.001 };

  it("fits an outline so its longer half-extent is the radius", () => {
    // The whole point of the fit: the same drawing at two viewBox scales renders identically, so
    // a path pasted from any tool arrives at a size that can be found in the viewport.
    const small = bounds(pathShape({ outline: "M0 0 H1 V1 H0 Z", r: 2, depth: 0.4, ...HAIRLINE }));
    const large = bounds(
      pathShape({ outline: "M0 0 H1000 V1000 H0 Z", r: 2, depth: 0.4, ...HAIRLINE }),
    );
    expect(small.max.x).toBeCloseTo(large.max.x, 3);
    expect(small.max.x).toBeCloseTo(2, 2);
  });

  it("fits the longer axis and lets the shorter one follow", () => {
    // Aspect is the drawing's own property; scaling each axis to `r` would stretch every paste
    // into a square.
    const box = bounds(pathShape({ outline: "M0 0 H40 V10 H0 Z", r: 2, depth: 0.4, ...HAIRLINE }));
    expect(box.max.x - box.min.x).toBeCloseTo(4, 2);
    expect(box.max.y - box.min.y).toBeCloseTo(1, 2);
  });

  it("grows the drawing by the bevel's lip rather than insetting it", () => {
    // The documented trade: depth is compensated because a config asked for it, the outline is
    // not because correctly insetting an arbitrary contour is a polygon-offset problem. Asserted
    // rather than tolerated, so the day someone does inset it, this says so.
    const box = bounds(pathShape({ outline: SQUARE, r: 2, depth: 0.6, fillet: 0.1 }));
    expect(box.max.x).toBeCloseTo(2.1, 2);
  });

  it("flips y, so a shape drawn pointing down renders pointing down", () => {
    // SVG's y grows downward and three's grows up. Unflipped, every paste renders upside down —
    // which reads as a bug in the shape rather than in the convention.
    const box = bounds(pathShape({ outline: "M0 0 L10 0 L5 10 Z", r: 2, depth: 0.4 }));
    // The apex is the lone vertex on its side, so the triangle's centroid sits away from it: the
    // half holding the two base corners is the wider one.
    const geometry = pathShape({ outline: "M0 0 L10 0 L5 10 Z", r: 2, depth: 0.4 });
    const ys = Array.from({ length: geometry.getAttribute("position").count }, (_, i) =>
      geometry.getAttribute("position").getY(i),
    );
    const below = ys.filter((y) => y < 0).length;
    const above = ys.filter((y) => y > 0).length;
    expect(box.min.y).toBeLessThan(0);
    // Fewer vertices at the bottom than the top: the apex is down there, where SVG put it.
    expect(below).toBeLessThan(above);
  });

  it("comes out the depth it was asked for, bevel included", () => {
    // `defaultPath` hands this straight to Beer-Lambert, so a solid thicker than it claims
    // absorbs more light than the scene was authored for.
    const box = bounds(pathShape({ outline: SQUARE, r: 2, depth: 0.6 }));
    expect(box.max.z - box.min.z).toBeCloseTo(0.6, 2);
  });

  it("treats every subpath after the first as a hole", () => {
    const solid = pathShape({ outline: SQUARE, r: 2, depth: 0.4 });
    const holed = pathShape({ outline: `${SQUARE} M3 3 H7 V7 H3 Z`, r: 2, depth: 0.4 });
    expect(triangleCount(holed)).toBeGreaterThan(triangleCount(solid));
    // A hole, not a second body: the silhouette has not grown.
    expect(bounds(holed).max.x).toBeCloseTo(bounds(solid).max.x, 2);
  });

  it("honours cuts on top of the outline's own holes", () => {
    const plain = pathShape({ outline: SQUARE, r: 2, depth: 0.4 });
    const carved = pathShape({ outline: SQUARE, r: 2, depth: 0.4, cuts: [SLOT] });
    expect(triangleCount(carved)).toBeGreaterThan(triangleCount(plain));
  });

  it("clamps the bevel to a hole too narrow to survive it", () => {
    // Extrude offsets a hole's contour outward to form its lip, so a bevel wider than half the
    // hole's short side turns it inside out and the shape renders with a black knot.
    const geometry = pathShape({ outline: `${SQUARE} M4.9 2 H5.1 V8 H4.9 Z`, r: 4, depth: 0.6 });
    expect(isFinitePositions(geometry)).toBe(true);
    // The clamp is visible from outside: a narrower hole leaves a narrower lip on the outline.
    const wide = bounds(pathShape({ outline: `${SQUARE} M3 3 H7 V7 H3 Z`, r: 4, depth: 0.6 }));
    expect(bounds(geometry).max.x).toBeLessThan(wide.max.x);
  });

  it("falls back to the default outline rather than vanishing", () => {
    // `buildShape` has to return geometry for every config. A shape that disappeared on a typo
    // would look like a renderer fault instead of the typo it is.
    const garbage = pathShape({ outline: "not a path at all", r: 2, depth: 0.4, ...HAIRLINE });
    expect(isFinitePositions(garbage)).toBe(true);
    expect(bounds(garbage).max.x).toBeCloseTo(2, 2);
  });

  it("survives an outline with no area on one axis", () => {
    const line = pathShape({ outline: "M0 0 H10 H20 H30 Z", r: 2, depth: 0.4 });
    expect(isFinitePositions(line)).toBe(true);
  });

  it("routes the path kind through buildShape", () => {
    const geometry = buildShape(normalizeShape({ kind: "path", r: 2, depth: 0.5, fillet: 0.001 }));
    expect(isFinitePositions(geometry)).toBe(true);
    expect(bounds(geometry).max.x).toBeCloseTo(2, 2);
  });

  it("a path's optical path is its depth, like the other extrusions", () => {
    expect(defaultPath({ ...createShape("path"), depth: 0.5 })).toBeCloseTo(0.25);
  });

  it("gives a path shape a default outline and no other kind one", () => {
    expect(normalizeShape({ kind: "path" }).outline).toBe(DEFAULT_OUTLINE);
    expect(normalizeShape({ kind: "rod" }).outline).toBeUndefined();
  });

  it("keeps an authored outline across a change of kind", () => {
    // The studio edits one shape object and lets the kind decide what it reads. Dropping this on
    // a switch away would destroy the only field here a user types rather than drags.
    expect(normalizeShape({ kind: "rod", outline: SQUARE }).outline).toBe(SQUARE);
  });

  it("turns the bevel off for a negative fillet", () => {
    // A drawn silhouette is the one shape here whose fine detail a bevel visibly fattens, so it is
    // the one that can refuse one. `0` cannot mean this: it already means "pick a proportional one".
    const box = bounds(pathShape({ outline: SQUARE, r: 2, depth: 0.6, fillet: -1 }));
    expect(box.max.x).toBeCloseTo(2, 4);
    expect(box.max.z - box.min.z).toBeCloseTo(0.6, 4);
  });

  it("leaves a negative fillet inert on the kinds that cannot honour it", () => {
    // A lathe with no fillet collapses its corner arc onto a point and hands the mesh a fan of
    // degenerate triangles. `resolveFillet` tests `> 0`, so a negative reads as "proportional".
    const plain = bounds(buildShape({ ...createShape("rod"), r: 0.5, len: 4 }));
    const negative = bounds(buildShape({ ...createShape("rod"), r: 0.5, len: 4, fillet: -1 }));
    expect(negative.max.x).toBeCloseTo(plain.max.x, 4);
    expect(isFinitePositions(buildShape({ ...createShape("rod"), fillet: -1 }))).toBe(true);
  });

  it("scales the default bevel off the narrowest limb, not the bounding box", () => {
    // The case that motivates it: a 1.5-wide spike on a 100-wide body. A bevel sized off the box
    // comes out wider than the spike, and the spike renders as a fat stripe with no flat left.
    const spike = "M0 0 H100 V40 H51 V90 H49.5 V40 H0 Z";
    const thin = bounds(pathShape({ outline: spike, r: 4, depth: 0.5 }));
    const solid = bounds(pathShape({ outline: SQUARE, r: 4, depth: 0.5 }));
    // Both are fitted to the same radius, so what differs is the lip the bevel adds.
    expect(thin.max.x - 4).toBeLessThan((solid.max.x - 4) / 2);
  });

  it("keeps a fine-featured outline finite", () => {
    const spike = "M0 0 H100 V40 H51 V90 H49.5 V40 H0 Z";
    expect(isFinitePositions(pathShape({ outline: spike, r: 4, depth: 0.5 }))).toBe(true);
  });

  it("reads a whole svg document as well as a bare d", () => {
    const svg = `<svg viewBox="0 0 10 10"><path d="M0 0 H10 V10 H0 Z"/></svg>`;
    expect(normalizeShape({ kind: "path", outline: svg }).outline).toBe("M0 0 H10 V10 H0 Z");
  });

  it("cuts an over-long outline between commands, not inside a number", () => {
    // A blind slice can halve a coordinate; the contour then goes NaN, gets dropped, and the shape
    // silently becomes the default star with nothing to say why.
    const long = `M0 0 ${"L12.5 12.5 ".repeat(500)}Z`;
    const capped = normalizeShape({ kind: "path", outline: long }).outline!;
    expect(capped.length).toBeLessThanOrEqual(MAX_OUTLINE);
    expect(capped.endsWith("L12.5 12.5")).toBe(true);
    // And what survives still draws.
    expect(isFinitePositions(pathShape({ outline: capped, r: 2 }))).toBe(true);
  });

  it("caps an outline at a length a share link can carry", () => {
    const huge = `M0 0 ${"L1 1 ".repeat(2000)}Z`;
    expect(huge.length).toBeGreaterThan(MAX_OUTLINE);
    expect(normalizeShape({ kind: "path", outline: huge }).outline!.length).toBeLessThanOrEqual(
      MAX_OUTLINE,
    );
  });
});
