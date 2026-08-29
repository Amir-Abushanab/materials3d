/**
 * Lamp-field randomizer.
 *
 * The palette is not invented: it comes from a hue histogram of the saturated pixels in the
 * reference frame. That measurement is the whole reason a cosine palette sweeping full hue was
 * rejected — the real distribution is warm, magenta and blue-violet with essentially no green and
 * NO CYAN AT ALL, which no evenly-swept palette will ever produce.
 *
 *   20–40°   19.3%     320–340°  13.2%     220–280°  ~21%
 *    0–20°   10.0%     340–360°   8.7%      60–80°    1.8%
 *   40–60°    9.9%     300–320°   7.3%
 */

import type { SceneConfig, LampConfig } from "@materials3d/core";
import { hslToHex } from "./util/color";

/** [hueStart, hueEnd, share] — shares are the measured percentages, normalized on use. */
const HUE_BANDS: readonly [number, number, number][] = [
  [0, 20, 10.0],
  [20, 40, 19.3],
  [40, 60, 9.9],
  [60, 80, 1.8],
  [220, 280, 21.0],
  [300, 320, 7.3],
  [320, 340, 13.2],
  [340, 360, 8.7],
];

const TOTAL = HUE_BANDS.reduce((sum, band) => sum + band[2], 0);

/** Draw a hue from the measured distribution. */
function sampleHue(rand: () => number): number {
  let roll = rand() * TOTAL;
  for (const [lo, hi, share] of HUE_BANDS) {
    roll -= share;
    if (roll <= 0) return lo + rand() * (hi - lo);
  }
  return HUE_BANDS[HUE_BANDS.length - 1][1];
}

export interface RandomizeOptions {
  count?: number;
  rand?: () => number;
}

/**
 * A fresh lamp field: lamps clustered in the lower-middle of plate space (where the reference
 * puts its light), each drawn from the measured hue distribution.
 *
 * Positions are jittered on a loose grid rather than uniformly random — pure uniform sampling
 * clumps, and two overlapping lamps read as one big one, which loses the empty space between
 * them that makes clear glass clear.
 */
export function randomLamps({
  count = 10,
  rand = Math.random,
}: RandomizeOptions = {}): LampConfig[] {
  const lamps: LampConfig[] = [];
  const columns = Math.ceil(Math.sqrt(count * 1.8));
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const rows = Math.max(1, Math.ceil(count / columns));
    lamps.push({
      x: (col + 0.5 + (rand() - 0.5) * 0.7) / columns,
      // Kept in the lower half: the reference lights from behind and below, and lamps drifting
      // to the top of the plate light the haze instead of the glass.
      y: 0.1 + ((row + 0.5 + (rand() - 0.5) * 0.6) / rows) * 0.42,
      r: 0.07 + rand() * 0.07,
      color: hslToHex(sampleHue(rand), 0.62 + rand() * 0.24, 0.55 + rand() * 0.12),
      intensity: 0.8 + rand() * 0.4,
    });
  }
  return lamps;
}

/** Re-roll the lamps in place, leaving geometry, camera and post exactly as authored. */
export function randomizeLamps(config: SceneConfig): void {
  config.lamps = randomLamps({ count: config.lamps.length || 10 });
}

// ---------------------------------------------------------------------------------------------
// Tasteful randomize — the whole scene, not just the lamps.
//
// Every range below brackets the SHIPPED DEFAULT rather than spanning what the field technically
// accepts. The reference look is a narrow band of each knob (a long lens, a deep haze, absorption
// that stops short of plastic), so sampling uniformly across the legal range mostly produces
// scenes nobody would keep. Tints and backdrop blobs draw from the same measured hue distribution
// the lamps do, so a randomized scene stays in the family.
// ---------------------------------------------------------------------------------------------

/** Uniform in [min, max). */
function between(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.min(values.length - 1, Math.floor(rand() * values.length))];
}

/**
 * Re-roll the whole scene within tasteful bounds.
 *
 * Geometry KIND is left alone: the shape set is the composition's identity, and swapping rods for
 * cones is a different scene rather than a variation on this one. What moves is the light, the
 * optics, the framing and the arrangement.
 */
export function randomizeConfig(config: SceneConfig, rand: () => number = Math.random): void {
  config.lamps = randomLamps({ count: config.lamps.length || 10, rand });
  config.lampGain = between(rand, 1.2, 2.3);

  const camera = config.camera;
  camera.fov = Math.round(between(rand, 10, 18));
  camera.distance = Math.round(between(rand, 36, 52));
  camera.height = Number(between(rand, -4, 1).toFixed(2));

  const post = config.post;
  // Focus tracks the camera, or the whole frame lands outside the sharp band.
  post.focus = camera.distance + between(rand, -2, 2);
  // Aperture and range move TOGETHER. Rolled independently, a wide aperture on a narrow range
  // blurs everything that isn't exactly on the focal plane, which is most of the scene — the
  // reference look keeps a readable band of sharp glass and lets only the far rods go soft.
  const softness = rand();
  post.range = Number((4 + softness * 4).toFixed(2));
  post.aperture = Math.round(11 + softness * 8);
  post.bloom = Number(between(rand, 0.01, 0.08).toFixed(3));
  post.caustics = Number(between(rand, 0.2, 0.9).toFixed(2));
  post.haze = Number(between(rand, 0.5, 0.95).toFixed(2));
  post.hazeTop = Number(between(rand, 0.2, 0.5).toFixed(2));
  post.vignette = Number(between(rand, 0.05, 0.3).toFixed(2));

  // One optical character for the whole scene: mixed IORs across shapes read as an accident
  // rather than as a material.
  const density = Number(between(rand, 2, 5).toFixed(2));
  const ior = Number(between(rand, 1.4, 1.6).toFixed(3));
  const dispersion = Number(between(rand, 0.01, 0.08).toFixed(3));
  const kind = pick(rand, ["skewer", "spin", "drift", "none"] as const);
  const axis = pick(rand, ["x", "y", "z"] as const);
  const rate = Number(between(rand, 0.12, 0.5).toFixed(3));

  // The AUTHORED items, not the resolved ones: a scatter's expanded copies are rebuilt from the
  // template below, so writing to them would be thrown away on the next regeneration.
  for (const item of config.items) {
    item.material = { ...item.material, density, ior, dispersion };
    item.motion = { ...item.motion, kind, axis, rate };
  }

  const scatter = config.scatter;
  if (scatter) {
    scatter.seed = Math.floor(rand() * 10_000);
    // Count follows the span rather than being rolled against it. Independently, a high count on a
    // short span packs the rods into a solid wall and the composition stops reading as separate
    // pieces of glass at all — which is the whole subject.
    scatter.spanX = Number(between(rand, 14, 19).toFixed(2));
    scatter.count = Math.round(scatter.spanX * between(rand, 0.75, 1.0));
    scatter.spread = Number(between(rand, 2.6, 4.2).toFixed(2));
    scatter.lengthVariance = Number(between(rand, 0.15, 0.55).toFixed(2));
    scatter.radiusVariance = Number(between(rand, 0.05, 0.3).toFixed(2));
    scatter.stagger = Number(between(rand, 0.15, 0.8).toFixed(3));
    scatter.material = { ...scatter.material, density, ior, dispersion };
    scatter.motion = { ...scatter.motion, kind, axis, rate };
  }

  // A backdrop worth refracting, a third of the time. The rest stay on the plain colour, which is
  // what the reference look uses and what keeps the glass itself the subject.
  if (rand() < 0.34) {
    config.backgroundMode = "gradient";
    config.backgroundGradientType = pick(rand, ["linear", "radial", "mesh"] as const);
    config.backgroundGradientAngle = between(rand, 0, Math.PI * 2);
    config.backgroundMeshSoftness = Number(between(rand, 0.35, 0.8).toFixed(2));
    // Pale and desaturated: the backdrop is a light source for the glass, not a picture competing
    // with it, and a vivid one bleaches every shape in front of it.
    const tint = (): string =>
      hslToHex(sampleHue(rand), between(rand, 0.25, 0.5), between(rand, 0.82, 0.93));
    config.backgroundPalette = [
      { color: tint(), position: 0 },
      { color: tint(), position: 1 },
    ];
    config.backgroundMeshPoints = Array.from({ length: 3 }, () => ({
      x: between(rand, 0.15, 0.85),
      y: between(rand, 0.15, 0.85),
      color: tint(),
    }));
  } else {
    config.backgroundMode = "color";
  }
}
