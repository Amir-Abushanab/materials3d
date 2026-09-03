import { defineConfig, type Plugin } from "vite";

// The HTML carries authoring notes (why the favicon is inlined, where the mark comes from) that
// nobody reading the built page needs, so the build drops them. Dev keeps them.
function stripHtmlComments(): Plugin {
  return {
    name: "strip-html-comments",
    apply: "build",
    transformIndexHtml: (html) => html.replace(/<!--[\s\S]*?-->/g, ""),
  };
}

// The embeddable @materials3d/core runtime is built separately by the core package's
// `build:standalone` (see predev/prebuild). Pointing publicDir at that output serves it at
// /materials3d.standalone.js, which the HTML exporter fetches and inlines into the downloaded file.
export default defineConfig({
  base: "/",
  publicDir: "../../packages/core/dist/standalone",
  plugins: [stripHtmlComments()],
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
