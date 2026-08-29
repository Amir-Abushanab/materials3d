import type * as THREE from "three";
import type { ItemConfig, MotionConfig } from "../config/model";

/** One glass shape in the scene, as the renderer and the frame callbacks see it. */
export interface MaterialItem {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** The config this item was built from (null for items added imperatively with `add()`). */
  readonly config: ItemConfig | null;
  /** This shape's own motion — resolved, so it is always present even for items added in code. */
  motion: MotionConfig;
  /** Where this shape sits in its motion's cycle, in radians. */
  phase: number;
  /** The authored pose. Motions read from here rather than accumulating onto the live transform,
   *  so pausing, scrubbing and capturing a fixed frame all land in the same place. */
  readonly home: THREE.Vector3;
  readonly homeRotation: THREE.Euler;
  /** The authored scale — what `wobble` squashes relative to. */
  readonly homeScale: THREE.Vector3;
  /** Free space for a caller's own per-item state. */
  data: Record<string, unknown>;
}

/** Called once per frame with the elapsed animation time, the frame delta, and every item. */
export type FrameCallback = (time: number, delta: number, items: readonly MaterialItem[]) => void;
