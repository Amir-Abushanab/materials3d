/**
 * What both engines share: constants, pure derivations and the scatter expansion.
 *
 * The WebGL and WebGPU renderers are separate three builds and must not import each other, or a
 * bundler pulls both into every consumer. Anything that has to be one derivation on both sides
 * lives here. This module imports nothing from three, so it is safe from either build.
 */
import {
  FRAME_ASPECT,
  type CameraFit,
  type ItemConfig,
  type PostConfig,
  type ScatterConfig,
  type SceneConfig,
} from "../config/model";
import { parseHex } from "../util/color";
import { makeRng } from "../util/math";

/** Bloom pyramid: each level's divisor of the colour target, and the blur taps at that level.
 *  Wide kernels cost almost nothing once the target is small, which is where the broad wash comes
 *  from. The fourth level is built but not composited; it exists to light dust. */
export const BLOOM_DIVISORS = [2, 4, 8, 16] as const;
export const BLOOM_TAPS = [6, 10, 14, 18] as const;

/** Level 0 of the baked room, in texels. The height is half this: an equirect map is 2:1. */
export const ENV_WIDTH = 512;
/** Mips in the chain; the widest cone a material can ask for is the last one. */
export const ENV_LEVELS = 8;
/** Radians per texel across the equator at level 0, which is what a cone width is compared
 *  against when a material picks a mip. */
export const ENV_TEXEL = (Math.PI * 2) / ENV_WIDTH;

/** The baked room is a pure function of these, so a scene that never touches them bakes once. */
export function environmentKey(c: Pick<SceneConfig, "studio" | "studioGain">): string {
  return `${c.studio}|${c.studioGain}`;
}

/** The wall overshoots the frustum by this factor, or it ends in a hard edge partway across the
 *  picture. The reference's WALL_SAFETY, plus room for the orbit to swing the frustum. */
const WALL_SAFETY = 1.08;

/** Gather counts for the post pass, from `quality`. Fewer taps below full quality: the frame is
 *  already soft there, and 24 gathers across two textures is the most expensive thing in the pass.
 *  Both engines bake these into the pass at build time, so `quality` is a structural change. */
export function postTaps(quality: number): { dofTaps: number; causticTaps: number } {
  return {
    dofTaps: quality >= 0.85 ? 24 : quality >= 0.6 ? 16 : 10,
    causticTaps: quality >= 0.6 ? 10 : 6,
  };
}

/** Whether any finish-pass effect is on. When none is, the post pass draws straight out. */
export function needsFinish(post: PostConfig): boolean {
  return (
    post.innerLight > 0.001 ||
    post.dither > 0.001 ||
    post.halftone > 0.001 ||
    post.halftoneCmyk > 0.001 ||
    post.paperTexture > 0.001
  );
}

/**
 * Half-extents of the wall a beam terminates on, walked from the frustum at the wall's depth.
 *
 * Derived rather than authored: the exposure that balances the picture is a function of how far
 * the light travels before it stops, so a scene that changes its lens or distance must not also
 * have to remember to resize the wall. Everything the wall shades from world position reads this
 * (the relief at both scales, the light falloff, the contact shadows), so the two engines have to
 * agree on it to the last digit or the backdrop picks up a faint diagonal weave.
 *
 * The distance walks from the ORBIT distance and the look-at, not from the camera's z, so a scene
 * that has been orbited still measures the wall it is looking at.
 */
export function wallExtent(
  orbitDistance: number,
  lookAtZ: number,
  wallZ: number,
  fovDeg: number,
  aspect: number,
): { x: number; y: number } {
  const dist = Math.abs(orbitDistance) + Math.abs(lookAtZ - wallZ);
  const halfHeight = dist * Math.tan((fovDeg * DEG2RAD) / 2);
  return { x: halfHeight * Math.max(aspect, 1) * WALL_SAFETY, y: halfHeight * WALL_SAFETY };
}

/** The backdrop plane hangs this far behind the plate, so a refracted ray cast at the plate lands
 *  on painted colour rather than on the plane's edge. */
export const BACKDROP_BEHIND_PLATE = 14;
/** The authored backdrop span. The vertical ramp is calibrated against it, so the plane never
 *  shrinks below it: a smaller plane pulls the whole ramp into view and reads as a much stronger
 *  gradient. */
const BACKDROP_MIN_WIDTH = 160;
const BACKDROP_MIN_HEIGHT = 110;
/** Overscan on the frustum at the backdrop's depth, so an orbit never reveals its edge. */
const BACKDROP_OVERSCAN = 1.35;

/**
 * Size and place the backdrop plane: the frustum at its depth with overscan, never below the
 * authored span, plus the fraction of that oversized plane the camera actually sees, which is the
 * rectangle gradients and images are authored against.
 *
 * Walked from the ORBIT distance like {@link wallExtent}, so both engines measure the same plane.
 */
export function backdropLayout(
  orbitDistance: number,
  lookAtZ: number,
  plateZ: number,
  fovDeg: number,
  aspect: number,
): { z: number; width: number; height: number; frameX: number; frameY: number } {
  const z = plateZ - BACKDROP_BEHIND_PLATE;
  const dist = Math.abs(orbitDistance) + Math.abs(lookAtZ - z);
  const need = 2 * dist * Math.tan((fovDeg * DEG2RAD) / 2) * BACKDROP_OVERSCAN;
  const height = Math.max(BACKDROP_MIN_HEIGHT, need);
  const width = Math.max(BACKDROP_MIN_WIDTH, need * aspect);
  const visibleH = need / BACKDROP_OVERSCAN;
  return {
    z,
    width,
    height,
    frameX: Math.min(1, (visibleH * aspect) / width),
    frameY: Math.min(1, visibleH / height),
  };
}

/** The backdrop's vertical ramp around `background`: a touch darker at the top, a touch warmer at
 *  the bottom, so `background` stays a single knob. Raw display-space channels, like every other
 *  colour in the pass chain. */
export function backdropRamp(background: string): {
  top: [number, number, number];
  bot: [number, number, number];
} {
  const [r, g, b] = parseHex(background);
  return {
    top: [r * 0.958, g * 0.958, b * 0.96],
    bot: [Math.min(1, r * 1.005), Math.min(1, g * 1.002), Math.min(1, b * 0.995)],
  };
}

/** The backdrop media a config asks for: a video takes precedence over a still, and neither is
 *  wanted outside image mode. Both engines key their loads on this URL, so a slider drag never
 *  re-requests the same file. */
export function backgroundMediaUrl(
  c: Pick<SceneConfig, "backgroundMode" | "backgroundImageUrl" | "backgroundVideoUrl">,
): { url: string | undefined; video: boolean } {
  const url =
    c.backgroundMode === "image" ? (c.backgroundVideoUrl ?? c.backgroundImageUrl) : undefined;
  return { url, video: Boolean(c.backgroundVideoUrl) && url === c.backgroundVideoUrl };
}

/** The part of an item the contact-shadow footprint reads. */
export interface GroundedItem {
  readonly mesh: { position: { x: number; y: number }; rotation: { z: number } };
  readonly config: ItemConfig | null | undefined;
}

/**
 * Where each solid meets the wall, for the contact shadow.
 *
 * The footprint is the shape's own cross-section (a regular polygon for a prism or hex, a circle
 * for every other lathe) at the item's world position. `apothem` rather than the circumradius: the
 * shadow's edge follows the FACES, and the corner distance inflates a triangle's footprint by a
 * factor of two. Returns how many slots were written.
 */
export function fillGroundSlots(
  items: readonly GroundedItem[],
  maxSlots: number,
  write: (
    slot: number,
    x: number,
    y: number,
    apothem: number,
    sides: number,
    phase: number,
  ) => void,
): number {
  let count = 0;
  for (const item of items) {
    if (count >= maxSlots) break;
    const shape = item.config?.shape;
    if (!shape) continue;
    const faceted = shape.kind === "prism" || shape.kind === "hex";
    const sides = shape.kind === "hex" ? 6 : faceted ? Math.max(3, shape.sides) : 0;
    const apothem = faceted ? shape.r * Math.cos(Math.PI / sides) : shape.r;
    write(
      count,
      item.mesh.position.x,
      item.mesh.position.y,
      apothem,
      sides,
      Math.PI / 2 + item.mesh.rotation.z,
    );
    count++;
  }
  return count;
}

/** Expand a {@link ScatterConfig} into concrete items, deterministically, so the same config
 *  produces the same scene in the browser, in an export and in a captured poster. */
export function expandScatter(scatter: ScatterConfig): ItemConfig[] {
  const rng = makeRng(scatter.seed);
  const out: ItemConfig[] = [];
  const startX = scatter.position.x - scatter.spanX / 2;
  for (let index = 0; index < scatter.count; index++) {
    const u = scatter.count > 1 ? index / (scatter.count - 1) : 0.5;
    const len = scatter.shape.len * (1 - rng() * scatter.lengthVariance);
    const r = scatter.shape.r + rng() * scatter.radiusVariance;
    const z = scatter.position.z + (rng() - 0.5) * scatter.spread;
    const jitter = (rng() - 0.5) * scatter.phaseJitter;
    out.push({
      shape: { ...scatter.shape, r, len },
      position: { x: startX + u * scatter.spanX, y: scatter.position.y, z },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      // Cloned, not shared. A BAKED scatter otherwise hands every item the same material object,
      // so editing one shape's IOR in the panel silently edits all of them.
      material: { ...scatter.material },
      motion: { ...scatter.motion },
      // The arrangement's stagger is baked into each shape's own phase, so a baked scene animates
      // identically to the generated one it came from.
      phase: index * scatter.stagger + jitter,
      // Cloned per shape for the same reason as the material, and because binding smoothing is
      // keyed by binding-object identity: shared objects would make every generated shape ease as
      // one instead of the hovered rod answering alone.
      ...(scatter.interaction ? { interaction: structuredClone(scatter.interaction) } : {}),
    });
  }
  return out;
}

/** The items a config describes: scatter when present, the explicit list otherwise. */
export function resolveItems(config: {
  scatter?: ScatterConfig;
  items: ItemConfig[];
}): ItemConfig[] {
  return config.scatter ? expandScatter(config.scatter) : config.items;
}

/**
 * Turn a generated scene into an authored one: expand `scatter` into a concrete `items` list and
 * drop the scatter block. The frame is pixel-identical afterwards, since the same generator
 * produced the list, but every shape now has a config of its own to select, move and edit.
 *
 * Mutates in place and returns whether anything changed, so an editor can call it unconditionally
 * before a per-shape edit. A no-op on a scene that is already authored.
 */
export function bakeScatter(config: { scatter?: ScatterConfig; items: ItemConfig[] }): boolean {
  if (!config.scatter) return false;
  config.items = expandScatter(config.scatter);
  config.scatter = undefined;
  return true;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * The effective vertical FOV for a canvas of aspect `aspect`, given the fov authored at
 * {@link FRAME_ASPECT}.
 *
 * A perspective camera has no `zoom` that means "show more world" without also moving the lens,
 * so the framing policy is expressed as a FOV instead: scale the visible HEIGHT at the focal plane
 * by `k`, and since height = 2·d·tan(fov/2), that is `fovEff = 2·atan(k·tan(fov/2))`. Exact at
 * every depth, so nothing about the perspective or the depth of field shifts.
 *
 * `k` is the visible height relative to the authored frame:
 *   cover   k = min(1, A₀/A)   crop the overflow; never reveal world beyond the frame
 *   contain k = max(1, A₀/A)   reveal beyond the frame; never crop it
 *   width   k = A₀/A           hold the horizontal composition
 *   height  k = 1              hold the vertical composition (three's own behaviour)
 *
 * At `aspect === FRAME_ASPECT` every branch gives k = 1, which is what makes this inert for the
 * 16:9 framing every preset is authored against.
 */
export function frameFov(
  fov: number,
  aspect: number,
  fit: CameraFit = "cover",
  minVisibleWidth = 0,
): number {
  const byFrame = FRAME_ASPECT / aspect;
  let k: number;
  switch (fit) {
    case "contain":
      k = Math.max(1, byFrame);
      break;
    case "width":
      k = byFrame;
      break;
    case "height":
      k = 1;
      break;
    default:
      k = Math.min(1, byFrame);
  }
  // A floor on k only ever widens the view, so it cannot tighten a fit that already shows enough.
  if (minVisibleWidth > 0) k = Math.max(k, byFrame * minVisibleWidth);
  return RAD2DEG * (2 * Math.atan(k * Math.tan((fov * DEG2RAD) / 2)));
}
