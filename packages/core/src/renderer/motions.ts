/**
 * Motion, applied per shape.
 *
 * Each shape carries its own {@link MotionConfig} and its own `phase`, so a composition can have a
 * row of rods rolling on one axis while a disc beside them drifts — which a single scene-wide
 * driver could never express. The studio's "apply to all shapes" is how you get uniformity back
 * when you want it.
 *
 * Motions read from the shape's authored pose (`home` / `homeRotation`) rather than accumulating
 * onto the live transform, so pausing, scrubbing and capturing a fixed frame all land in the same
 * place, and dragging a shape mid-animation takes effect immediately.
 */

import type { MotionConfig } from "../config/model";
import type { FrameCallback, MaterialItem } from "./item";

/**
 * Snap a frequency so it completes a WHOLE number of cycles in `loopSeconds`.
 *
 * This is what makes a clip loop. Every motion here is a sine or a rotation, so it returns to its
 * starting pose exactly when its argument has advanced a multiple of 2π — which only happens if the
 * rate divides evenly into the loop. Snapping to the nearest whole cycle is the smallest change
 * that guarantees it.
 *
 * The floor of one cycle is deliberate: a rate slow enough to round to zero would otherwise freeze
 * the shape, which loops perfectly and is not what anyone means by it. That does mean a slow motion
 * against a short loop speeds up noticeably — the honest fix there is a longer loop, and the studio
 * shows the effective rate so the jump is visible rather than mysterious.
 *
 * A constant phase offset (per-item `phase`, or a scatter's stagger) never affects periodicity, so
 * those are left alone.
 */
export function loopFrequency(frequency: number, loopSeconds: number): number {
  if (loopSeconds <= 0 || frequency === 0) return frequency;
  const cycles = Math.max(1, Math.round((Math.abs(frequency) * loopSeconds) / (Math.PI * 2)));
  return Math.sign(frequency) * ((cycles * Math.PI * 2) / loopSeconds);
}

/**
 * Advance one shape to `time`.
 *
 * A lathed shape spun about its own axis of symmetry is *literally* invisible — the same normal
 * distribution every frame — which is why `skewer` defaults to rolling about X while the profile
 * is swept about Y.
 */
export function applyMotion(item: MaterialItem, time: number, loopSeconds = 0): void {
  const motion = item.motion;
  const rate = loopFrequency(motion.rate, loopSeconds);
  const phase = time * rate + item.phase;
  switch (motion.kind) {
    case "skewer":
    case "spin":
      item.mesh.rotation[motion.axis] = item.homeRotation[motion.axis] + phase;
      break;
    case "drift": {
      item.mesh.position.y = item.home.y + Math.sin(phase) * motion.amount;
      // The roll rides a second, slower frequency. It has to be snapped INDEPENDENTLY: quantising
      // only the base rate leaves this one at 0.7× of it, which closes over the loop just when
      // that ratio happens to land on a whole cycle — i.e. almost never.
      const roll = loopFrequency(motion.rate * 0.7, loopSeconds);
      item.mesh.rotation.z = item.homeRotation.z + Math.sin(time * roll + item.phase * 0.7) * 0.05;
      break;
    }
    case "wobble": {
      // Volume-preserving squash-stretch along `axis`. A single sine reads as breathing, not
      // jelly — the 2× and 3× harmonics are what make it jiggle. They are INTEGER multiples of
      // the snapped base rate, so a loop that closes for the fundamental closes for them too.
      const jiggle =
        Math.sin(phase) * 0.62 +
        Math.sin(phase * 2 + 1.1) * 0.26 +
        Math.sin(phase * 3 + 2.4) * 0.12;
      const squash = Math.max(1 + jiggle * motion.amount, 0.05);
      // The other two axes swell by 1/√s, so the volume stays constant — squash that thins the
      // shape overall reads as inflating and deflating instead of jelly.
      const swell = 1 / Math.sqrt(squash);
      const { homeScale } = item;
      item.mesh.scale.set(
        homeScale.x * (motion.axis === "x" ? squash : swell),
        homeScale.y * (motion.axis === "y" ? squash : swell),
        homeScale.z * (motion.axis === "z" ? squash : swell),
      );
      break;
    }
    case "none":
    default:
      break;
  }
}

/** Advance every shape. Called once per frame by the renderer. */
export function applyMotions(items: readonly MaterialItem[], time: number, loopSeconds = 0): void {
  for (const item of items) applyMotion(item, time, loopSeconds);
}

// ---------------------------------------------------------------------------
// The code-first path. A scene built with `renderer.add(...)` can set each shape's motion through
// `AddOptions.motion`; these factories are for driving items from the outside instead, through
// `onFrame`, where you want a rule that spans the whole set.
// ---------------------------------------------------------------------------

export interface SweepOptions {
  axis?: "x" | "y" | "z";
  rate?: number;
  /** Phase step between successive items — spread it across a full turn. */
  stagger?: number;
}

/**
 * `skewer` and `spin` are ONE behaviour — rotate every item about a shared axis, a beat apart —
 * with different defaults: skewer rolls about X with the reference stagger, spin turns about Y in
 * unison. They keep separate names because they read as different motions in a config.
 */
function sweep(axis: "x" | "y" | "z", rate: number, stagger: number): FrameCallback {
  return (time, _delta, items) => {
    for (const [index, item] of items.entries()) {
      item.mesh.rotation[axis] =
        item.homeRotation[axis] + time * rate + index * stagger + item.phase;
    }
  };
}

/** Roll every item about ONE shared axis, a beat apart — the reference motion, as a callback. */
export function skewer({
  axis = "x",
  rate = 0.34,
  stagger = 0.393,
}: SweepOptions = {}): FrameCallback {
  return sweep(axis, rate, stagger);
}

export function spin({ axis = "y", rate = 0.2, stagger = 0 }: SweepOptions = {}): FrameCallback {
  return sweep(axis, rate, stagger);
}

export interface DriftOptions {
  amount?: number;
  rate?: number;
}

/** A slow vertical bob with a little roll — for compositions that shouldn't read as spinning. */
export function drift({ amount = 0.12, rate = 0.5 }: DriftOptions = {}): FrameCallback {
  return (time, _delta, items) => {
    for (const [index, item] of items.entries()) {
      const phase = time * rate + index * 1.7 + item.phase;
      item.mesh.position.y = item.home.y + Math.sin(phase) * amount;
      item.mesh.rotation.z = item.homeRotation.z + Math.sin(phase * 0.7) * 0.05;
    }
  };
}

export interface WobbleOptions {
  axis?: "x" | "y" | "z";
  rate?: number;
  /** Squash amplitude — 0.1–0.2 is jelly, beyond that is cartoon. */
  amount?: number;
}

/** Volume-preserving squash-stretch, a beat apart — gelatinous, as a callback. */
export function wobble({
  axis = "y",
  rate = 1.1,
  amount = 0.14,
}: WobbleOptions = {}): FrameCallback {
  return (time, _delta, items) => {
    for (const [index, item] of items.entries()) {
      const phase = time * rate + index * 1.9 + item.phase;
      const jiggle =
        Math.sin(phase) * 0.62 +
        Math.sin(phase * 2 + 1.1) * 0.26 +
        Math.sin(phase * 3 + 2.4) * 0.12;
      const squash = Math.max(1 + jiggle * amount, 0.05);
      const swell = 1 / Math.sqrt(squash);
      item.mesh.scale.set(
        item.homeScale.x * (axis === "x" ? squash : swell),
        item.homeScale.y * (axis === "y" ? squash : swell),
        item.homeScale.z * (axis === "z" ? squash : swell),
      );
    }
  };
}

/** Whether a motion actually moves anything — used to skip per-frame work on a static scene. */
export function isAnimated(motion: MotionConfig): boolean {
  return motion.kind !== "none" && motion.rate !== 0;
}
