import { defineConfig } from "tsdown";

// @materials3d/react: a single ESM entry with types. react and @materials3d/core stay external (peers).
export default defineConfig({
  entry: ["src/index.tsx"],
  format: "esm",
  dts: true,
  sourcemap: true,
  deps: {
    neverBundle: ["react", "react/jsx-runtime", "@materials3d/core", /^@materials3d\/core\//],
  },
  platform: "browser",
  target: "es2022",
  outDir: "dist",
});
