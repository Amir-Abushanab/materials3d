/**
 * The contract the shell needs from an engine, and the reason it is written down.
 *
 * There are two engines — the WebGL/GLSL {@link MaterialRenderer} and the WebGPU/TSL
 * {@link NodeMaterialRenderer} — reached through sibling dynamic imports so a bundler can ship
 * only the one a consumer asked for. Typing the shell against one of them directly would make the
 * other's loader unassignable, and widening to a union would leak engine choice into every call
 * site. Naming the surface instead keeps the two interchangeable and states exactly what a new
 * engine would have to provide.
 */
import type { SceneConfig } from "./config/model";

export interface Engine {
  readonly canvas: HTMLCanvasElement;
  start(): unknown;
  stop(): unknown;
  dispose(): void;
  refreshPlayback(): void;
  getConfig(): SceneConfig;
  setConfig(config: Partial<SceneConfig>): void;
  captureImage(mime?: string, quality?: number, time?: number): Promise<Blob>;
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
