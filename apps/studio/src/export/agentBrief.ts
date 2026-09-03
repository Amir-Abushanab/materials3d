/**
 * "Copy for your agent": the clipboard payload that hands a designed scene to a coding agent.
 *
 * Three parts: a task, the current scene's snippet (so the agent reproduces THIS scene rather than
 * a generic one), and the package's own agent skill as reference. The skill is the exact
 * `packages/core/skills/materials3d/SKILL.md` that ships with `@materials3d/core`, inlined at
 * build time through `?raw`, so the button and the published skill cannot drift and there is no
 * runtime fetch to fail. Its YAML frontmatter is tooling metadata (name, sources) that reads as
 * noise to an agent consuming the doc as prose, so it is stripped.
 *
 * The snippet carries a placeholder poster path rather than a data URI: an inline poster would be
 * kilobytes of noise in an agent's context. The task asks for a poster instead.
 */
import skillDoc from "../../../../packages/core/skills/materials3d/SKILL.md?raw";
import type { SceneConfig } from "@materials3d/core";
import { exportCode, type CodeTarget } from "./exportCode";

const TASK = `Add a Materials3D scene to my site: the exact scene I designed in Materials Studio.

1. Install the package for my framework: \`pnpm add @materials3d/react three\` (or the matching
   adapter; the reference below has the table). \`three\` is a peer dependency; add \`@types/three\`
   for TypeScript.
2. Mount the component using the config under "THE SCENE I DESIGNED" verbatim. Those numbers are
   the design; reproduce them exactly, do not re-tune or tidy the values.
3. Give the container a real size (it fills its parent) and wire up a poster image for first paint.

Use the reference below, @materials3d's own agent skill, to pick the right entry point for my stack
and get the config, poster and SSR details right.`;

/** Strip a leading YAML frontmatter block. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");
}

/**
 * The full agent brief for a scene. `target` picks which adapter the embedded snippet uses (the
 * reference covers the rest); the JSON tab has no adapter, so it falls back to React.
 */
export function buildAgentBrief(
  config: SceneConfig,
  target: CodeTarget = "react",
  presetName?: string,
): string {
  const snippet = exportCode(config, target === "json" ? "react" : target, presetName);
  return [
    TASK,
    "--- THE SCENE I DESIGNED ---",
    snippet,
    "--- REFERENCE: the @materials3d agent skill ---",
    stripFrontmatter(skillDoc).trim(),
  ].join("\n\n");
}
