// The dynamic-import target for the shell. The `.` entry's `createMaterials` reaches the renderer
// (and, through it, three.js) via `import("./core-loader")`, so a bundler code-splits three out of
// the initial load, the drop-in component ships a tiny shell and fetches the engine only when a
// scene actually upgrades. The standalone/CDN build imports this statically instead.
export { MaterialRenderer } from "./renderer/MaterialRenderer";
export { createDefaultConfig } from "./config/model";
