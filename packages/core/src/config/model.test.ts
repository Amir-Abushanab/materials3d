import { describe, expect, it } from "vitest";
import {
  cleanBindings,
  createBeam,
  createDefaultConfig,
  createDust,
  createItem,
  createLamp,
  createShape,
  ensureSceneConfig,
  isTransmissive,
  ITEM_TARGET_NAMES,
  MAX_LAMPS,
  MAX_MESH_POINTS,
  MAX_STOPS,
  mergeSceneConfig,
  normalizeMaterial,
  normalizeMotion,
  normalizeSceneInteraction,
  normalizeShape,
  resolveMaterial,
  type SceneConfig,
  type SceneConfigInput,
} from "./model";
import { parseHex, rgbToHsl, toHex } from "../util/color";

describe("ensureSceneConfig", () => {
  it("fills an empty object out to a complete config", () => {
    const config = ensureSceneConfig({});
    expect(config.lamps.length).toBeGreaterThan(0);
    expect(config.camera.fov).toBe(12);
    expect(config.scatter?.count).toBe(16);
  });

  it("is idempotent", () => {
    const once = ensureSceneConfig({});
    const twice = ensureSceneConfig(structuredClone(once));
    expect(twice).toEqual(once);
  });

  it("caps the lamp list at the uniform-array size", () => {
    const lamps = Array.from({ length: MAX_LAMPS + 6 }, (_, i) => ({
      x: i / 20,
      y: 0.3,
      r: 0.1,
      color: "#ffffff",
      intensity: 1,
    }));
    expect(ensureSceneConfig({ lamps }).lamps).toHaveLength(MAX_LAMPS);
  });

  it("keeps the coverage gate's hi above its lo", () => {
    // An inverted smoothstep turns every clear region opaque, which looks like a renderer bug
    // rather than a bad config, so the config layer refuses to produce one.
    const config = ensureSceneConfig({ lampGate: { lo: 0.9, hi: 0.1 } });
    expect(config.lampGate.hi).toBeGreaterThan(config.lampGate.lo);
  });

  it("rejects a non-finite number rather than propagating NaN into a uniform", () => {
    const config = ensureSceneConfig({ lampGain: Number.NaN } as Partial<SceneConfig>);
    expect(config.lampGain).toBe(createDefaultConfig().lampGain);
  });

  it("drops an unknown motion kind to none", () => {
    const config = ensureSceneConfig({
      items: [{ motion: { kind: "orbit", axis: "q", rate: 1, amount: 0 } }],
    } as unknown as Partial<SceneConfig>);
    expect(config.items[0].motion.kind).toBe("none");
    expect(config.items[0].motion.axis).toBe("x");
  });

  it('accepts background: "transparent" as sugar for the flag', () => {
    const config = ensureSceneConfig({ background: "transparent" });
    expect(config.transparentBackground).toBe(true);
    // The colour still has to be a real one: the post pass blurs a non-premultiplied buffer, so
    // it is what blurred edges fade into.
    expect(config.background).toBe(createDefaultConfig().background);
  });

  it("keeps the backdrop colour when transparency is toggled through the flag", () => {
    const config = ensureSceneConfig({ background: "#101018", transparentBackground: true });
    expect(config.transparentBackground).toBe(true);
    expect(config.background).toBe("#101018");
    // Toggling back restores the authored colour rather than a default.
    expect(ensureSceneConfig({ ...config, transparentBackground: false }).background).toBe(
      "#101018",
    );
  });

  it("treats an empty background string as transparent rather than as black", () => {
    expect(ensureSceneConfig({ background: "" }).transparentBackground).toBe(true);
  });

  it("round-trips a transparent config through JSON", () => {
    const config = ensureSceneConfig({ background: "transparent" });
    expect(ensureSceneConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });

  it("round-trips through JSON unchanged", () => {
    const config = ensureSceneConfig({});
    expect(ensureSceneConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });
});

describe("normalizeShape", () => {
  it("defaults an unknown kind to a rod", () => {
    expect(normalizeShape({ kind: "torus" } as never).kind).toBe("rod");
  });

  it("keeps a blob's seed an integer and its lumpiness in range", () => {
    const blob = normalizeShape({ kind: "blob", seed: 7.6, bump: 3 });
    expect(blob.seed).toBe(8);
    expect(blob.bump).toBe(1);
  });

  it("keeps a ring's hole inside its outer radius", () => {
    const ring = normalizeShape({ kind: "ring", r: 2, hole: 5 });
    expect(ring.hole).toBeLessThan(ring.r);
  });

  it("clamps the lathe segment count to something buildable", () => {
    expect(normalizeShape({ kind: "rod", sides: 1 }).sides).toBe(3);
    expect(normalizeShape({ kind: "rod", sides: 4000 }).sides).toBe(256);
  });
});

describe("resolveMaterial", () => {
  it("refuses an IOR below 1, which flips the refraction inside out", () => {
    expect(resolveMaterial({ ior: 0.2 }).ior).toBeGreaterThan(1);
  });

  it("refuses a negative density, which would invert Beer-Lambert into emission", () => {
    expect(resolveMaterial({ density: -3 }).density).toBe(0);
  });

  it("treats an empty tint as 'borrow the lamps behind'", () => {
    expect(resolveMaterial({}).tint).toBe("");
  });

  it("accepts the liquid kind as transmissive", () => {
    expect(resolveMaterial({ kind: "liquid" }).kind).toBe("liquid");
    expect(isTransmissive("liquid")).toBe(true);
    expect(isTransmissive("metal")).toBe(false);
  });

  it("clamps the ripple and film parameters to renderable ranges", () => {
    const m = resolveMaterial({ ripple: 4, rippleScale: 0, flow: -2, iridescence: 9, filmNm: 5 });
    expect(m.ripple).toBe(1);
    expect(m.rippleScale).toBeGreaterThan(0);
    expect(m.flow).toBe(0);
    expect(m.iridescence).toBe(1);
    expect(m.filmNm).toBeGreaterThanOrEqual(50);
  });
});

describe("colour", () => {
  it("parses both hex forms to the same value", () => {
    expect(parseHex("#fff")).toEqual(parseHex("#ffffff"));
    expect(parseHex(0xf8c852)).toEqual(parseHex("#f8c852"));
  });

  it("round-trips through toHex", () => {
    expect(toHex(parseHex("#f8c852"))).toBe("#f8c852");
  });

  it("falls back to white instead of throwing on junk", () => {
    expect(parseHex("not a colour")).toEqual([1, 1, 1]);
  });

  it("reports hue in degrees", () => {
    const [h, s] = rgbToHsl(parseHex("#ff0000"));
    expect(h).toBeCloseTo(0);
    expect(s).toBeCloseTo(1);
  });
});

describe("createShape", () => {
  it("starts every kind from the same field set, so the studio can flip kinds freely", () => {
    expect(Object.keys(createShape("disc"))).toEqual(Object.keys(createShape("arrow")));
  });
});

describe("background transparency", () => {
  it("treats an omitted background as the default, not as transparent", () => {
    // A share link strips default-valued fields, so `background` is routinely absent. Reading
    // that as the empty-string "transparent" keyword opened every such link with no backdrop.
    const config = ensureSceneConfig({ quality: 1 });
    expect(config.transparentBackground).toBe(false);
    expect(config.background).toBe(createDefaultConfig().background);
  });

  it("still accepts the explicit spellings", () => {
    for (const keyword of ["transparent", "none", ""]) {
      expect(ensureSceneConfig({ background: keyword }).transparentBackground).toBe(true);
    }
    expect(ensureSceneConfig({ transparentBackground: true }).transparentBackground).toBe(true);
  });

  it("keeps the authored colour when transparency is on, so toggling it back restores it", () => {
    const config = ensureSceneConfig({ background: "#123456", transparentBackground: true });
    expect(config.transparentBackground).toBe(true);
    expect(config.background).toBe("#123456");
  });
});

describe("per-channel absorption", () => {
  /**
   * Absent has to stay absent. Zero absorption is a real material, perfectly clear glass, so a
   * normalizer that filled in a default would make "clear" and "not asked for" the same thing, and
   * every existing preset would silently lose its lamp-derived tint.
   */
  it("leaves absorption absent when a material does not ask for it", () => {
    expect(resolveMaterial({ density: 2 }).absorption).toBeUndefined();
  });

  it("keeps a zero absorption, which is clear glass rather than no answer", () => {
    expect(resolveMaterial({ absorption: { x: 0, y: 0, z: 0 } }).absorption).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
  });

  it("clamps negatives, which would otherwise amplify light through the glass", () => {
    expect(resolveMaterial({ absorption: { x: -3, y: 1, z: 0.54 } }).absorption).toEqual({
      x: 0,
      y: 1,
      z: 0.54,
    });
  });
});

describe("material normalization", () => {
  it("bounds an authored material the way resolveMaterial would, at import time", () => {
    const config = ensureSceneConfig({
      items: [{ material: { ior: 0.2, density: -3, path: Number.NaN } }],
    } as unknown as SceneConfigInput);
    const material = config.items[0].material;
    expect(material.ior).toBe(resolveMaterial({ ior: 0.2 }).ior);
    expect(material.density).toBe(0);
    // NaN is dropped rather than stored, so the default applies at build time.
    expect("path" in material).toBe(false);
  });

  it("keeps a minimal material minimal: only the keys that were present come back", () => {
    expect(normalizeMaterial({ density: 2 })).toEqual({ density: 2 });
    expect(normalizeMaterial(undefined)).toEqual({});
  });

  it("drops values of the wrong type and unknown kinds", () => {
    const material = normalizeMaterial({
      ior: "1.5",
      tint: 4,
      kind: "wood",
      albedo: "#ffffff",
    } as unknown as Partial<import("./model").MaterialConfig>);
    expect(material).toEqual({ albedo: "#ffffff" });
  });

  it("clamps per-channel absorption but leaves it absent when it was absent", () => {
    expect(normalizeMaterial({ absorption: { x: -1, y: 1, z: 0.5 } }).absorption).toEqual({
      x: 0,
      y: 1,
      z: 0.5,
    });
    expect(normalizeMaterial({ density: 1 }).absorption).toBeUndefined();
  });

  it("normalizes the scatter template's material too", () => {
    const config = ensureSceneConfig({ scatter: { material: { ior: 0.5, density: 2 } } } as never);
    expect(config.scatter?.material).toEqual({
      ior: resolveMaterial({ ior: 0.5 }).ior,
      density: 2,
    });
  });

  it("agrees with resolveMaterial on every key, so import and build cannot drift", () => {
    const wild = {
      path: -1,
      density: -1,
      ior: 9,
      dispersion: 2,
      lens: -1,
      bend: 3,
      magnify: 3,
      rim: 3,
      specular: -1,
      saturation: -1,
      hueShift: 5,
      emission: -1,
      ripple: 3,
      rippleScale: 0,
      flow: 99,
      iridescence: 3,
      filmNm: 1,
      roughness: 3,
      sparkle: 3,
      sparkleScale: 0,
    };
    const resolved = resolveMaterial(wild);
    for (const [key, value] of Object.entries(normalizeMaterial(wild))) {
      expect(value, key).toBe(resolved[key as keyof typeof resolved]);
    }
  });

  it("is idempotent through ensureSceneConfig", () => {
    const config = ensureSceneConfig({
      items: [{ ...createItem(), material: { ior: 0.2, kind: "metal", albedo: "#ffdb98" } }],
    });
    expect(ensureSceneConfig(structuredClone(config))).toEqual(config);
  });
});

describe("factory defaults", () => {
  it("fills every partial block from its factory, so the defaults live in one place", () => {
    const config = ensureSceneConfig({
      lamps: [{}],
      beam: {},
      dust: {},
      items: [{}],
    } as unknown as SceneConfigInput);
    expect(config.lamps[0]).toEqual(createLamp());
    expect(config.beam).toEqual(createBeam());
    expect(config.dust).toEqual(createDust());
    expect(config.items[0]).toEqual(createItem());
  });

  it("gives an unspecified lamp the warm reference colour, not white", () => {
    expect(ensureSceneConfig({ lamps: [{ x: 0.2 }] } as never).lamps[0].color).toBe("#f8c852");
  });
});

describe("boolean coercion", () => {
  it('only believes real booleans, since JSON off the wire can say "false"', () => {
    expect(ensureSceneConfig({ paused: "false" } as never).paused).toBe(false);
    expect(ensureSceneConfig({ paused: true }).paused).toBe(true);
    // A default-true flag falls back to its default rather than to the truthiness of a string.
    expect(ensureSceneConfig({ orbit: "false" } as never).orbit).toBe(true);
    expect(ensureSceneConfig({ orbit: false }).orbit).toBe(false);
    expect(ensureSceneConfig({ measuredThickness: 1 } as never).measuredThickness).toBe(false);
  });
});

describe("normalizeBeam", () => {
  it("refuses a two-sided polygon and keeps the entry point on the face", () => {
    const beam = ensureSceneConfig({ beam: { sides: 2, entry: 3 } }).beam;
    expect(beam?.sides).toBe(3);
    expect(beam?.entry).toBe(1);
  });

  it("keeps only real item names as targets, and an entry angle of zero", () => {
    const beam = ensureSceneConfig({
      beam: { targets: ["prism", 3, ""], entryAngle: 0 },
    } as never).beam;
    expect(beam?.targets).toEqual(["prism"]);
    expect(beam?.entryAngle).toBe(0);
    expect(ensureSceneConfig({ beam: { targets: [] } }).beam?.targets).toBeUndefined();
  });

  it("stays absent when no beam was asked for", () => {
    expect(ensureSceneConfig({}).beam).toBeUndefined();
  });
});

describe("normalizeDust", () => {
  it("keeps the grain count and seed integral and in range", () => {
    const dust = ensureSceneConfig({
      dust: { count: -5, seed: 7.9, extent: { x: 1 } },
    } as never).dust;
    expect(dust?.count).toBe(0);
    expect(dust?.seed).toBe(7);
    expect(dust?.extent).toEqual({ x: 1, y: createDust().extent.y, z: createDust().extent.z });
  });
});

describe("backdrop", () => {
  it("sorts and caps the gradient palette, and falls back when it is empty", () => {
    const stops = Array.from({ length: MAX_STOPS + 3 }, (_, i) => ({
      color: "#000000",
      position: 1 - i / 10,
    }));
    const palette = ensureSceneConfig({ backgroundPalette: stops }).backgroundPalette;
    expect(palette).toHaveLength(MAX_STOPS);
    for (let i = 1; i < palette.length; i++) {
      expect(palette[i].position).toBeGreaterThanOrEqual(palette[i - 1].position);
    }
    expect(ensureSceneConfig({ backgroundPalette: [] }).backgroundPalette).toEqual(
      createDefaultConfig().backgroundPalette,
    );
  });

  it("caps the mesh points and fills a missing coordinate", () => {
    const points = Array.from({ length: MAX_MESH_POINTS + 2 }, () => ({ color: "#123456" }));
    const mesh = ensureSceneConfig({ backgroundMeshPoints: points } as never).backgroundMeshPoints;
    expect(mesh).toHaveLength(MAX_MESH_POINTS);
    expect(mesh[0]).toEqual({ x: 0.5, y: 0.5, color: "#123456" });
  });
});

describe("post", () => {
  it("drops an unknown tone map and bloom mode to the defaults, and keeps known ones", () => {
    const bad = ensureSceneConfig({ post: { toneMap: "filmic", bloomMode: "cube" } } as never).post;
    expect(bad.toneMap).toBe("none");
    expect(bad.bloomMode).toBe("gather");
    const good = ensureSceneConfig({ post: { toneMap: "aces", bloomMode: "pyramid" } } as never);
    expect(good.post.toneMap).toBe("aces");
    expect(good.post.bloomMode).toBe("pyramid");
  });
});

describe("camera", () => {
  it("validates the fit and bounds the field of view and the width floor", () => {
    const camera = ensureSceneConfig({
      camera: { fit: "squish", fov: 900, minVisibleWidth: 4 },
    } as never).camera;
    expect(camera.fit).toBe("cover");
    expect(camera.fov).toBe(120);
    expect(camera.minVisibleWidth).toBe(1);
    expect(ensureSceneConfig({ camera: { fit: "contain" } } as never).camera.fit).toBe("contain");
  });
});

describe("interaction", () => {
  it("cleanBindings keeps only valid sources and targets with a finite `to`", () => {
    const bindings = cleanBindings(
      [
        { source: "hover", target: "ior", to: 1.6, from: 1.2, smoothing: 9 },
        { source: "custom:beat", target: "rim", to: 1 },
        { source: "custom:", target: "rim", to: 1 },
        { source: "hover", target: "nope", to: 1 },
        { source: "hover", target: "ior", to: "loud" },
        null,
      ],
      ITEM_TARGET_NAMES,
    );
    expect(bindings).toEqual([
      { source: "hover", target: "ior", to: 1.6, from: 1.2, smoothing: 2 },
      { source: "custom:beat", target: "rim", to: 1 },
    ]);
  });

  it("normalizeSceneInteraction keeps the block present-only", () => {
    expect(normalizeSceneInteraction({})).toEqual({});
    expect(normalizeSceneInteraction({ enabled: false, touch: true })).toEqual({
      enabled: false,
      touch: true,
    });
    expect(normalizeSceneInteraction({ bindings: "no" } as never)).toEqual({ bindings: [] });
  });
});

describe("normalizeMotion", () => {
  it("falls back field by field", () => {
    expect(normalizeMotion({ kind: "spin", axis: "z", rate: Number.NaN })).toEqual({
      kind: "spin",
      axis: "z",
      rate: 0.34,
      amount: 0.16,
    });
    expect(normalizeMotion({ kind: "orbit", axis: "w" } as never).kind).toBe("none");
  });
});

describe("mergeSceneConfig", () => {
  it("merges an object block one level deep and replaces arrays wholesale", () => {
    const base = ensureSceneConfig({});
    const merged = mergeSceneConfig(base, { post: { bloom: 1 } as never, lamps: [createLamp()] });
    expect(merged.post?.bloom).toBe(1);
    expect(merged.post?.toneMap).toBe(base.post.toneMap);
    expect(merged.lamps).toHaveLength(1);
    // A patch that changed one knob must not reset its siblings once normalized.
    expect(ensureSceneConfig(merged).post).toEqual({ ...base.post, bloom: 1 });
  });

  it("lets an explicit undefined through, which is how scatter is opted out of", () => {
    const merged = mergeSceneConfig(ensureSceneConfig({}), { scatter: undefined });
    expect("scatter" in merged).toBe(true);
    expect(ensureSceneConfig(merged).scatter).toBeUndefined();
  });

  it("mutates neither argument", () => {
    const base = ensureSceneConfig({});
    const snapshot = structuredClone(base);
    const patch = { post: { bloom: 1 } } as never;
    mergeSceneConfig(base, patch);
    expect(base).toEqual(snapshot);
    expect(patch).toEqual({ post: { bloom: 1 } });
  });
});
