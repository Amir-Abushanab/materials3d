// The single-file CDN / standalone build entry. Unlike the `.` shell — which fetches the engine on
// demand — this statically imports the engine (three bundled in) and pre-binds createMaterials /
// mountMaterials with a synchronous loadCore, so a plain <script type="module"> from a CDN upgrades
// with no extra network round-trip. This is also the runtime the studio inlines into its exported
// embed HTML.
import * as core from "./core-loader";
import { createMaterialsImpl } from "./shell/createMaterials";
import type { MaterialHandle, MaterialOptions } from "./shell/createMaterials";
import type { SceneConfig } from "./config/model";

// Synchronous core — the engine is already bundled into this file, so there is no dynamic import
// (which is exactly why the standalone stays a single file: createMaterialsImpl never references the
// public createMaterials's `import("./core-loader")` default).
const loadCore = (): Promise<typeof core> => Promise.resolve(core);

/** {@link createMaterialsImpl} with the engine already bundled in (synchronous upgrade). */
export function createMaterials(
  container: HTMLElement,
  config: Partial<SceneConfig> = {},
  options: MaterialOptions = {},
): MaterialHandle {
  return createMaterialsImpl(loadCore, container, config, options);
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
export type { RGB } from "./util/color";
export type {
  MaterialOptions,
  MaterialHandle,
  MaterialState,
  FallbackReason,
  SnapshotOptions,
} from "./shell/createMaterials";
