/**
 * Where the build outputs live, resolved from this file rather than from the working directory,
 * so every script behaves the same from the repo root, a package directory or an editor task.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const CORE = resolve(ROOT, "packages/core");
export const DIST = resolve(CORE, "dist");
export const BUNDLE = resolve(DIST, "standalone/materials3d.standalone.js");
/** Default home for every image a script writes. Gitignored. */
export const RENDERS = resolve(ROOT, "renders");
/**
 * What the studio serves at `/`: the standalone bundle (copied in, gitignored) and the committed
 * demo meshes a `model` scene links to. The browser scripts serve it too, so a config naming
 * `/knot.glb` renders headless exactly as it does in the studio.
 */
export const STUDIO_PUBLIC = resolve(ROOT, "apps/studio/public");

/**
 * three's build directory, resolved from packages/core so the served copy is the one the package
 * is built against. pnpm keeps it under node_modules/.pnpm/three@<version>, and a hard-coded
 * version in that path broke every browser script on each three upgrade.
 */
export function threeBuildDir() {
  const requireFromCore = createRequire(resolve(CORE, "package.json"));
  // three does not export its package.json, but its main entry sits in build/. The specifier is
  // kept out of the call because knip reads a literal there as a root dependency to declare, and
  // the root deliberately has none: this is packages/core's three.
  return dirname(requireFromCore.resolve(THREE));
}

const THREE = "three";

/** Fail early, naming the command to run, when the outputs a script reads are not there. */
export function requireBuild({ bundle = true, dist = false } = {}) {
  if (bundle && !existsSync(BUNDLE)) {
    throw new Error(
      `standalone bundle missing at ${BUNDLE}\nRun: pnpm --filter @materials3d/core build:standalone`,
    );
  }
  if (dist && !existsSync(resolve(DIST, "renderer/shaders.js"))) {
    throw new Error(
      `packages/core/dist is missing or incomplete\nRun: pnpm --filter @materials3d/core build`,
    );
  }
}
