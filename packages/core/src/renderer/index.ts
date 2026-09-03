// The engine entry: importing this pulls in three. The `.` entry deliberately does not, see
// ../index.ts and ../core-loader.ts for how the shell keeps three out of its initial chunk.
//
// `NodeMaterialRenderer` is deliberately NOT re-exported here: it is a SECOND three build, and
// naming it in this barrel would pull `three/webgpu` into everything that imports the barrel. It
// has its own subpath, `@materials3d/core/renderer-webgpu`, so reaching for it is a decision.
//
// That engine is EXPERIMENTAL and not pixel-equal to this one, which is the reference, see
// `WEBGPU.md`.
export {
  MaterialRenderer,
  expandScatter,
  resolveItems,
  bakeScatter,
  frameFov,
} from "./MaterialRenderer";
export type { MaterialRendererOptions, AddOptions } from "./MaterialRenderer";
export type { MaterialItem, FrameCallback } from "./item";
export * as shapes from "./shapes";
export * as motions from "./motions";
export { buildShape, defaultPath } from "./shapes";
export { applyMotion, applyMotions, isAnimated } from "./motions";
export { InteractionController, interactionActive } from "./interaction";
