// The single-file CDN / standalone build entry. Unlike the `.` shell, which fetches the engine on
// demand, this statically imports the engine (three bundled in) and pre-binds createMaterials /
// mountMaterials with a synchronous loadCore, so a plain <script type="module"> from a CDN upgrades
// with no extra network round-trip. This is also the runtime the studio inlines into its exported
// embed HTML.
import * as core from "./core-loader";
import { createMaterialsImpl } from "./shell/createMaterials";
import type { MaterialHandle, MaterialOptions, RendererKind } from "./shell/createMaterials";
import type { SceneConfig } from "./config/model";

// Synchronous core, the engine is already bundled into this file, so there is no dynamic import
// (which is exactly why the standalone stays a single file: createMaterialsImpl never references the
// public createMaterials's `import("./core-loader")` default).
const loadCore = (): Promise<typeof core> => Promise.resolve(core);

let warnedWebgpu = false;

/**
 * {@link createMaterialsImpl} with the engine already bundled in (synchronous upgrade).
 *
 * Only the WebGL engine is in this file. `renderer: "webgpu"` cannot be honoured here, so it is
 * reported once and the scene runs on WebGL; the package entry (`@materials3d/core`) is the one
 * that can fetch the node engine.
 */
export function createMaterials(
  container: HTMLElement,
  config: Partial<SceneConfig> = {},
  options: MaterialOptions = {},
): MaterialHandle {
  if ((options as MaterialOptions<RendererKind>).renderer === "webgpu" && !warnedWebgpu) {
    warnedWebgpu = true;
    console.warn(
      '[materials3d] renderer: "webgpu" is not available in the standalone build, which bundles the WebGL engine only; falling back to WebGL. Use the @materials3d/core package entry for the WebGPU engine.',
    );
  }
  return createMaterialsImpl(loadCore, container, config, { ...options, renderer: "webgl" });
}

/** The drop-in embed contract: an alias of {@link createMaterials}. */
export const mountMaterials = createMaterials;

// CDN users get the raw engine, shapes, motions and presets directly too, plus the same config
// surface as the `.` entry (model, groups, palettes, colour helpers) so code written against the
// package entry ports to the standalone unchanged.
export { MaterialRenderer } from "./renderer/MaterialRenderer";
export * as shapes from "./renderer/shapes";
export * as motions from "./renderer/motions";
export { PRESETS } from "./presets";
export * from "./config/model";
export * from "./config/groups";
export * from "./config/palettes";
export { parseHex, toHex, rgbToHsl } from "./util/color";
export { outlineFromSvg } from "./util/svg";
export { parseGlb, loadMesh, preloadMeshes } from "./renderer/glb";
export type { RGB } from "./util/color";
export type {
  MaterialOptions,
  MaterialHandle,
  MaterialState,
  FallbackReason,
  SnapshotOptions,
  PosterFit,
  RendererKind,
  EngineFor,
} from "./shell/createMaterials";
export type { MaterialRendererOptions, AddOptions } from "./renderer/MaterialRenderer";
export type { MaterialItem, FrameCallback } from "./renderer/item";
