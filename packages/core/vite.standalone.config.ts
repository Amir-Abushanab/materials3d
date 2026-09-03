import { defineConfig } from "vite";
import { resolve } from "node:path";

// The single-file CDN / standalone build. Vite's lib mode with codeSplitting disabled reliably
// emits ONE self-contained file (three bundled, runtime helpers inlined), required because the
// studio inlines this file as one Blob into its exported embed HTML. (tsdown/rolldown extracts a
// shared runtime-helper chunk here, which would break the single-Blob inline; tsdown builds the
// tree-shakeable main package, see tsdown.config.ts.)
// Output: dist/standalone/materials3d.standalone.js
export default defineConfig({
  build: {
    outDir: "dist/standalone",
    emptyOutDir: true,
    target: "es2022",
    // Explicit: Vite keeps whitespace in es-format library output (to protect the pure
    // annotations a downstream bundler tree-shakes on), which left this file at ~935 KB. Nothing
    // tree-shakes a CDN single file, so `output.minify` below asks for the whole minifier.
    minify: "oxc",
    // Ships next to the file, so a stack trace from a CDN embed still points at source.
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/standalone.ts"),
      name: "Materials3D",
      fileName: () => "materials3d.standalone.js",
      formats: ["es"],
    },
    rolldownOptions: {
      output: { codeSplitting: false, minify: true },
    },
  },
});
