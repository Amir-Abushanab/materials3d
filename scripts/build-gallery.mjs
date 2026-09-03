/**
 * Regenerate gallery/*.json from the shipped presets, so the JSON in the repo can never drift
 * from the code that produced it, and remove the JSON of any preset that no longer exists.
 *
 * It reads the *built* standalone bundle rather than the TypeScript sources: Node's type
 * stripping does not resolve this repo's extensionless imports, and the bundle is a single
 * self-contained ESM file that already exports PRESETS. `pnpm gallery:build` builds it first
 * when it is stale. gallery/community/ is hand-authored and never touched here.
 */
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, run } from "./lib/cli.mjs";
import { BUNDLE, ROOT, requireBuild } from "./lib/paths.mjs";

const USAGE = `usage: pnpm gallery:build

Writes gallery/<preset>.json for every shipped preset and deletes gallery/*.json files whose
preset no longer exists. gallery/community/ is left alone.`;

await run(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  requireBuild();
  const { PRESETS, ensureSceneConfig } = await import(pathToFileURL(BUNDLE).href);
  const galleryDir = resolve(ROOT, "gallery");

  const written = new Set();
  for (const [name, make] of Object.entries(PRESETS)) {
    const config = ensureSceneConfig(make());
    writeFileSync(resolve(galleryDir, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`);
    written.add(`${name}.json`);
    console.log(`wrote gallery/${name}.json`);
  }
  for (const file of readdirSync(galleryDir)) {
    if (!file.endsWith(".json") || written.has(file)) continue;
    unlinkSync(resolve(galleryDir, file));
    console.log(`removed gallery/${file} (no such preset)`);
  }
});
