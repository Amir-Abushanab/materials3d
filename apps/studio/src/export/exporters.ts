/** Pixel and file exports: a still frame, a config file, a self-contained embed page, and a
 *  wallpaper folder for the desktop wallpaper apps. */

import type { SceneConfig } from "@materials3d/core";
import type { MaterialRenderer } from "@materials3d/core/renderer";
import { IMAGE_FORMATS, type ExportSize, type ImageFormat } from "../output/formats";
import { download, downloadText } from "../util/download";
import { createZip } from "./zip";

/**
 * Capture a still at an exact pixel size, independent of the on-screen preview.
 *
 * Always rendered at `time = 0` — the frame the scene opens on — so a poster regenerated later
 * matches the first frame a visitor sees and doesn't churn in git on every re-export.
 */
export async function saveStill(
  renderer: MaterialRenderer,
  name: string,
  format: ImageFormat,
  quality: number,
  size?: ExportSize,
): Promise<void> {
  const definition = IMAGE_FORMATS[format];
  if (size) renderer.setOutputSize({ width: size.width, height: size.height });
  try {
    const blob = await renderer.captureImage(
      definition.mime,
      definition.lossy ? quality : undefined,
      0,
    );
    download(blob, `${name}.${definition.extension}`);
  } finally {
    if (size) renderer.setOutputSize(undefined);
  }
}

export function saveConfig(config: SceneConfig, name: string): void {
  downloadText(`${JSON.stringify(config, null, 2)}\n`, `${name}.json`);
}

/**
 * A single self-contained HTML file: the standalone runtime (three bundled) inlined as a module,
 * plus this config. No network at runtime, nothing to install — drop it on any host.
 *
 * The runtime is fetched from the studio's own origin, where vite serves the core package's
 * `build:standalone` output.
 */
export async function exportEmbedHtml(config: SceneConfig, name: string): Promise<void> {
  const html = await buildEmbedHtml(config, name);
  download(new Blob([html], { type: "text/html" }), `${name}.html`);
}

/**
 * JSON destined for the inside of a `<script>` block. `JSON.stringify` alone is not enough: the
 * HTML parser ends the script at the first `</script`, wherever it appears — a shape or group
 * named "</script>" would truncate the module and leave the rest as markup. `<` parses
 * back to `<` inside the JS string literal, so the payload is unchanged.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003C");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The embed document itself. Shared by the .html export and the wallpaper folder. */
async function buildEmbedHtml(config: SceneConfig, name: string): Promise<string> {
  const runtimeUrl = new URL("./materials3d.standalone.js", document.baseURI);
  const runtime = await fetch(runtimeUrl).then((r) => {
    if (!r.ok) throw new Error(`Could not load the runtime (${r.status})`);
    return r.text();
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(name)}</title>
<style>
  html, body { height: 100%; margin: 0; background: ${config.background.replace(/[<>{}]/g, "")}; }
  #hero { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="hero"></div>
<script type="module">
  // The runtime is inlined below as a string and imported from a Blob URL rather than pasted in
  // directly: a minified bundle renames its internals, so reaching mountMaterials through the module's
  // real export list is the only way that survives \`vite build\`.
  const source = ${jsonForScript(runtime)};
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const { mountMaterials } = await import(url);
    mountMaterials(document.getElementById("hero"), ${jsonForScript(config)});
  } finally {
    URL.revokeObjectURL(url);
  }
</script>
</body>
</html>
`;
}

/**
 * A wallpaper folder (.zip): the embed HTML plus a Wallpaper Engine `project.json`, a Lively
 * `LivelyInfo.json` and a preview frame — so the one zip imports as a live web wallpaper into
 * either app without any repackaging.
 */
export async function exportWallpaperFolder(
  config: SceneConfig,
  name: string,
  renderer: MaterialRenderer,
): Promise<void> {
  const html = await buildEmbedHtml(config, name);
  const preview = await renderer.captureImage("image/jpeg", 0.85);
  const description = "Refractive glass, exported from Materials Studio.";
  const project = {
    title: name,
    type: "web",
    file: "index.html",
    preview: "preview.jpg",
    description,
    tags: ["Abstract"],
    visibility: "public",
  };
  const lively = {
    AppVersion: "0.0.0.0",
    Title: name,
    Type: 3,
    FileName: "index.html",
    Preview: "preview.jpg",
    Thumbnail: "preview.jpg",
    Desc: description,
    Contact: "",
    License: "",
    Arguments: "",
  };
  const zip = createZip([
    { name: "index.html", data: html },
    { name: "project.json", data: JSON.stringify(project, null, 2) },
    { name: "LivelyInfo.json", data: JSON.stringify(lively, null, 2) },
    { name: "preview.jpg", data: new Uint8Array(await preview.arrayBuffer()) },
  ]);
  download(zip, `${name}-wallpaper.zip`);
}
