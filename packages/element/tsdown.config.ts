import { defineConfig } from "tsdown";

// @materials3d/element: a single ESM entry with types. @materials3d/core stays external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  sourcemap: true,
  deps: { neverBundle: ["@materials3d/core", /^@materials3d\/core\//] },
  platform: "browser",
  target: "es2022",
  outDir: "dist",
});
