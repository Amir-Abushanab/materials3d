/**
 * The contract the shell needs from an engine, and the reason it is written down.
 *
 * There are two engines, the WebGL/GLSL {@link MaterialRenderer} and the WebGPU/TSL
 * {@link NodeMaterialRenderer}, reached through sibling dynamic imports so a bundler can ship
 * only the one a consumer asked for. Typing the shell against one of them directly would make the
 * other's loader unassignable, and widening to a union would leak engine choice into every call
 * site. Naming the surface instead keeps the two interchangeable and states exactly what a new
 * engine would have to provide.
 */
import type * as THREE from "three";
import type { ItemConfig, LampConfig, MotionConfig, PostConfig, SceneConfig } from "./config/model";

/**
 * The renderer-agnostic part of an item.
 *
 * Deliberately WITHOUT the material: the two engines hold different material classes from
 * different three builds, and naming either here would pull that build into the other's bundle and
 * defeat the code split. Everything the shell and the studio actually reach for, the mesh, the
 * config it came from, its motion and its authored pose, is renderer-agnostic anyway.
 */
export interface EngineItem {
  readonly mesh: THREE.Mesh;
  readonly config: ItemConfig | null;
  motion: MotionConfig;
  phase: number;
  readonly home: THREE.Vector3;
  readonly homeRotation: THREE.Euler;
  readonly homeScale: THREE.Vector3;
}

/** Called once per rendered frame with the scene time, the frame delta and the live items. */
export type FrameCallback = (time: number, delta: number, items: readonly EngineItem[]) => void;

/**
 * The full engine surface.
 *
 * Both classes declare `implements Engine`, which is what makes `core-loader-webgpu`'s assertion
 * safe rather than merely asserted: the compiler checks each engine against this, so a method that
 * went missing from one of them fails the build instead of failing at a call site.
 */
export interface Engine {
  readonly canvas: HTMLCanvasElement;
  /** Whether the animation loop is on (a paused scene may still be running its loop). */
  readonly isRunning: boolean;
  start(): unknown;
  stop(): unknown;
  dispose(): void;
  refreshPlayback(): void;
  seek(time: number): void;
  renderOnce(): void;
  getConfig(): SceneConfig;
  setConfig(config: Partial<SceneConfig>): void;
  setLamps(lamps: LampConfig[]): unknown;
  setPost(post: Partial<PostConfig>): unknown;
  captureImage(mime?: string, quality?: number, time?: number): Promise<Blob>;
  captureStream(fps?: number): MediaStream;

  resize(): void;
  setOutputSize(size?: { width: number; height: number }): void;
  refresh(): void;
  rebuild(): void;
  resetCamera(): void;
  onFrame(callback: FrameCallback | null): unknown;

  getItems(): readonly EngineItem[];
  remove(item: EngineItem): void;
  clear(): void;

  pick(clientX: number, clientY: number): EngineItem | null;
  projectBounds(item: EngineItem): { x: number; y: number; width: number; height: number } | null;
  pointOnDragPlane(
    clientX: number,
    clientY: number,
    through: THREE.Vector3,
    out?: THREE.Vector3,
  ): THREE.Vector3 | null;
  viewDirection(out?: THREE.Vector3): THREE.Vector3;

  setInteractionInput(name: string, value: number): unknown;
  setScrollPreview(value: number | null): unknown;
  setScrollTestProgress(value: number): unknown;
}

export interface EngineOptions {
  respectReducedMotion?: boolean;
  canvas?: HTMLCanvasElement;
  preserveDrawingBuffer?: boolean;
}

/** What either `core-loader` must export. */
export interface EngineModule {
  MaterialRenderer: new (
    container: HTMLElement,
    config: Partial<SceneConfig>,
    options?: EngineOptions,
  ) => Engine;
  createDefaultConfig(): SceneConfig;
}
