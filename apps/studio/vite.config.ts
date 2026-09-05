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

// A real public dir, not the core package's build output, which is what this used to point at.
// Vite allows exactly one, and the studio now serves two kinds of thing from it: the embeddable
// @materials3d/core runtime, which `ensure-standalone` copies in (the HTML exporter fetches
// /materials3d.standalone.js and inlines it into the downloaded file), and the demo meshes the
// gallery's `model` scenes link to, which are committed. The copied bundle is gitignored; see
// scripts/ensure-standalone.mjs.
export default defineConfig({
  base: "/",
  publicDir: "public",
  plugins: [stripHtmlComments()],
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
