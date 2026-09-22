// The `@materials3d/core` entry: the lightweight poster-fallback shell (createMaterials / mountMaterials) plus
// the framework-agnostic config model. Deliberately free of any static three or renderer import,
// the shell fetches the engine on demand via a dynamic import (see ./core-loader), so a bundler
// keeps three.js out of this module's initial load. For a synchronous, three-bundled build see
// ./standalone (the CDN entry) or import ./renderer directly.
export * from "./config/model";
export * from "./config/groups";
export * from "./config/palettes";
export { parseHex, toHex, rgbToHsl } from "./util/color";
// The one reader for outline data, so a pasted `d` and an uploaded `.svg` cannot diverge.
export { outlineFromSvg } from "./util/svg";
export type { RGB } from "./util/color";
// Explicit (not `export *`) so the internal createMaterialsImpl, which the standalone build uses to
// avoid bundling the dynamic-import path, stays off the public surface.
export { createMaterials, mountMaterials } from "./shell/createMaterials";
// The capability probe, exported because every consumer that wants "only upgrade on a GPU" would
// otherwise hand-roll the same WEBGL_debug_renderer_info read — and the failure mode of getting it
// wrong is silent: treat "cannot read the renderer" as "software" and you downgrade people whose
// privacy settings hide the extension, who then see a poster forever with nothing to report.
export { probeWebGL, isSoftwareRenderer, hasWebGL } from "./shell/probe";
export type {
  MaterialOptions,
  RendererKind,
  EngineFor,
  MaterialHandle,
  MaterialState,
  FallbackReason,
  SnapshotOptions,
  PosterFit,
} from "./shell/createMaterials";

// Type-only re-exports (erased at build time, no runtime three import) so consumers can type
// `onReady(r)` / renderer options / frame callbacks.
export type {
  MaterialRenderer,
  MaterialRendererOptions,
  AddOptions,
} from "./renderer/MaterialRenderer";
export type { MaterialItem, FrameCallback } from "./renderer/item";
export type { Engine, EngineItem, EngineOptions, EngineModule } from "./engine";
export type { TiltStatus } from "./renderer/tilt";
