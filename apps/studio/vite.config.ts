import { defineConfig } from "vite";

// The embeddable @materials3d/core runtime is built separately by the core package's
// `build:standalone` (see predev/prebuild). Pointing publicDir at that output serves it at
// /materials3d.standalone.js, which the HTML exporter fetches and inlines into the downloaded file.
export default defineConfig({
  base: "/",
  publicDir: "../../packages/core/dist/standalone",
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
