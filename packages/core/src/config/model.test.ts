import { describe, expect, it } from "vitest";
import {
  createDefaultConfig,
  createShape,
  ensureSceneConfig,
  isTransmissive,
  MAX_LAMPS,
  normalizeShape,
  resolveMaterial,
  type SceneConfig,
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
    // rather than a bad config — so the config layer refuses to produce one.
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
   * Absent has to stay absent. Zero absorption is a real material — perfectly clear glass — so a
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
