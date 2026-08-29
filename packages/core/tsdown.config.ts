import { defineConfig } from "tsdown";

// The publishable @materials3d/core build: one output module per source module (unbundled), so the
// dynamic import of ./core-loader stays a separate chunk and three tree-shakes out of the shell.
// three stays external (a peer dependency). The single-file CDN build is separate — see
// vite.standalone.config.ts.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/renderer/index.ts",
    "src/presets.ts",
    "src/studio/index.ts",
    // Included ONLY for its .d.ts: the ./standalone export's `default` points at the vite
    // single-file build (which emits no types) while its `types` points here. The dist/standalone.js
    // tsdown emits alongside is reachable through no export subpath — an unused byproduct of
    // dts emission, not a public entry.
    "src/standalone.ts",
    // The TSL node library, whole. Consumers reach individual helpers through whichever pass uses
    // them, so tree-shaking would otherwise drop the rest — and `scripts/tsl-parity.mjs` can only
    // compare a helper against its GLSL twin if the helper was emitted.
    "src/renderer/nodes/index.ts",
  ],
  format: "esm",
  dts: true,
  sourcemap: true,
  unbundle: true,
  deps: { neverBundle: ["three", /^three\//] },
  platform: "browser",
  target: "es2022",
  outDir: "dist",
});
