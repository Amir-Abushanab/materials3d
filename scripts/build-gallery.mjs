/**
 * Regenerate gallery/*.json from the shipped presets, so the JSON in the repo can never drift
 * from the code that produced it.
 *
 * It reads the *built* standalone bundle rather than the TypeScript sources: Node's type
 * stripping does not resolve this repo's extensionless imports, and the bundle is a single
 * self-contained ESM file that already exports PRESETS. Run `pnpm --filter @materials3d/core
 * build:standalone` first (`pnpm gallery:build` does).
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bundle = resolve(root, "packages/core/dist/standalone/materials3d.standalone.js");
const { PRESETS, ensureSceneConfig } = await import(pathToFileURL(bundle).href);

for (const [name, make] of Object.entries(PRESETS)) {
  const config = ensureSceneConfig(make());
  writeFileSync(resolve(root, "gallery", `${name}.json`), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`wrote gallery/${name}.json`);
}
