// The engine entry: importing this pulls in three. The `.` entry deliberately does not — see
// ../index.ts and ../core-loader.ts for how the shell keeps three out of its initial chunk.
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
