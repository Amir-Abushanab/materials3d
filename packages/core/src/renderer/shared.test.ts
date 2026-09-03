import { describe, expect, it } from "vitest";
import {
  createDefaultConfig,
  createItem,
  createMotion,
  createShape,
  FRAME_ASPECT,
} from "../config/model";
import { bakeScatter, expandScatter, frameFov, resolveItems } from "./shared";
import { defaultPath } from "./shapes";

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
    // Mutate in place too, since that is what the control panel actually does.
    Object.assign(config.items[1].material, { density: 9 });

    expect(config.items[0].material.ior).toBe(1.9);
    expect(config.items[1].material.ior).not.toBe(1.9);
    expect(config.items[1].material.density).toBe(9);
    expect(config.items[2].material.density).not.toBe(9);
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
    // Narrower than 16:9: the authored height survives and the sides are lost.
    expect(frameFov(FOV, SQUARE, "cover")).toBeCloseTo(FOV, 10);
    // Wider than 16:9: the WIDTH would overflow instead, so the height tightens.
    const fov = frameFov(FOV, WIDE, "cover");
    expect(fov).toBeLessThan(FOV);
    expect(width(fov, WIDE)).toBeCloseTo(width(FOV, FRAME_ASPECT), 10);
  });

  it("contain keeps the whole authored frame visible in a square crop", () => {
    const fov = frameFov(FOV, SQUARE, "contain");
    expect(fov).toBeGreaterThan(FOV);
    // The authored width is exactly preserved, which is the point of the fit.
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
