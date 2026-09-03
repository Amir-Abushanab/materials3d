// Helpers for authoring tools built on the renderer. Pulls in three (via the renderer types), so
// it is a separate entry from the poster shell.
export { createThumbHost, prepThumbConfig, renderThumbFrame } from "./thumbnail";
export { renderMeshGradient } from "./meshPreview";
export { encodeAnimatedWebp } from "./webpMux";
export type { WebpAnimFrame } from "./webpMux";
