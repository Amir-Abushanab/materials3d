/**
 * Code export. One config, one snippet per way of consuming it — the point of the config being
 * plain JSON is that every one of these is the *same* object, just wrapped differently.
 */

import type { SceneConfig } from "@materials3d/core";
import { createDefaultConfig } from "@materials3d/core";

export type CodeTarget = "react" | "element" | "vanilla" | "cdn" | "json";

export const CODE_TARGETS: { id: CodeTarget; label: string }[] = [
  { id: "react", label: "React" },
  { id: "element", label: "Web component" },
  { id: "vanilla", label: "Vanilla" },
  { id: "cdn", label: "CDN" },
  { id: "json", label: "JSON" },
];

/**
 * Strip everything the defaults already say, so the snippet shows the decisions rather than the
 * whole schema. Recurses into plain objects; arrays are all-or-nothing (a partial lamp list would
 * be meaningless).
 */
function minify(value: unknown, base: unknown): unknown {
  if (Array.isArray(value))
    return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
  if (value && typeof value === "object" && base && typeof base === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const trimmed = minify(v, (base as Record<string, unknown>)[key]);
      if (trimmed !== undefined) out[key] = trimmed;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value === base ? undefined : value;
}

/** The config with defaults removed — what a user would actually type. */
export function minimalConfig(config: SceneConfig): Record<string, unknown> {
  return (minify(config, createDefaultConfig()) as Record<string, unknown>) ?? {};
}

function indent(json: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return json.split("\n").join(`\n${pad}`);
}

/**
 * JSON destined for a single-quoted HTML attribute: a `'` inside the config (a shape named
 * "it's") would otherwise end the attribute mid-payload. The HTML parser decodes the entities
 * back before the element JSON.parses the attribute, so the payload round-trips unchanged.
 */
function attrJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("&", "&amp;").replaceAll("'", "&#39;");
}

export function exportCode(config: SceneConfig, target: CodeTarget, presetName?: string): string {
  const full = JSON.stringify(config, null, 2);
  const minimal = JSON.stringify(minimalConfig(config), null, 2);
  const usesPreset = Boolean(presetName);

  switch (target) {
    case "react":
      return `import { Materials3D } from "@materials3d/react";

// Poster-first: the shell shows \`poster\` immediately and fetches the engine only when the
// container nears the viewport and the browser can actually run it. Capture the poster from
// this studio's "Save still".
export function Hero() {
  return (
    <Materials3D
      style={{ width: "100%", height: "100vh" }}
      poster="/glass-poster.webp"${usesPreset ? `\n      preset="${presetName}"` : ""}
      config={${indent(minimal, 6)}}
    />
  );
}
`;

    case "element":
      return `<script type="module">
  import "@materials3d/element";
</script>

<materials-3d
  style="display:block; width:100%; height:100vh"
  poster="/glass-poster.webp"${usesPreset ? `\n  preset="${presetName}"` : ""}
  config='${attrJson(minimalConfig(config))}'
></materials-3d>
`;

    case "vanilla":
      return `import { createMaterials } from "@materials3d/core";

// createMaterials reaches the renderer (and three.js) through a dynamic import, so this module stays
// small and three is code-split into its own chunk.
const handle = createMaterials(document.querySelector("#hero"), ${indent(minimal, 0)}, {
  poster: "/glass-poster.webp",
  lazy: true,
  // Four passes at phone DPR is a real cost — a still frame of glass loses very little.
  minSizeForWebGL: 520,
});

// handle.snapshot({ time: 0 }) → a Blob you can host as the poster above.
`;

    case "cdn":
      return `<div id="hero" style="width:100%;height:100vh"></div>
<script type="module">
  import { mountMaterials } from "https://esm.sh/@materials3d/core/standalone";
  mountMaterials(document.querySelector("#hero"), ${indent(minimal, 2)});
</script>
`;

    case "json":
    default:
      return full;
  }
}
