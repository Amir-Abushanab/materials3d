/**
 * Gate on the gallery JSON being loadable and in sync with the presets that generated it.
 *
 * Three failures this catches: a config file that no longer parses into a valid scene (a hand
 * edit that dropped a required field); a preset changed in code without `pnpm gallery:build`
 * being re-run, which would leave `<materials-3d src="gallery/skewer.json">` rendering the old
 * scene; and the two sets drifting apart, a preset with no JSON or a JSON whose preset is gone.
 *
 *   pnpm gallery:validate      (rebuilds the standalone bundle first when it is stale)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, run } from "./lib/cli.mjs";
import { BUNDLE, ROOT, requireBuild } from "./lib/paths.mjs";

const USAGE = `usage: pnpm gallery:validate

Checks every gallery/*.json against the shipped presets (one file per preset, normalized and in
sync) and every gallery/community/*.json for being a runnable config.`;

await run(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  requireBuild();
  const core = await import(pathToFileURL(BUNDLE).href);
  const galleryDir = resolve(ROOT, "gallery");
  const files = readdirSync(galleryDir)
    .filter((file) => file.endsWith(".json"))
    .toSorted();

  // Community submissions (see apps/studio/src/publishToGallery.ts) live one level down and wrap
  // the config in { title, author, config }. They are hand-authored, so they are NOT held to the
  // normalization check below, only to being a config the renderer would actually run.
  const communityDir = resolve(galleryDir, "community");
  const community = existsSync(communityDir)
    ? readdirSync(communityDir)
        .filter((file) => file.endsWith(".json"))
        .toSorted()
    : [];

  let failures = 0;
  const fail = (message) => {
    console.error(message);
    failures++;
  };
  if (files.length === 0) fail("gallery: no configs found");

  for (const file of community) {
    const raw = readFileSync(resolve(communityDir, file), "utf8");
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (error) {
      fail(`gallery/community/${file}: invalid JSON: ${error.message}`);
      continue;
    }
    if (!entry?.title || !entry?.author || !entry?.config) {
      fail(`gallery/community/${file}: needs "title", "author" and "config"`);
      continue;
    }
    if (
      /^data:/i.test(entry.config.backgroundImageUrl ?? "") ||
      /^data:/i.test(entry.config.backgroundVideoUrl ?? "")
    ) {
      fail(`gallery/community/${file}: embedded image/video data; use a hosted URL`);
      continue;
    }
    try {
      core.ensureSceneConfig(entry.config);
    } catch (error) {
      fail(`gallery/community/${file}: not a runnable config: ${error.message}`);
      continue;
    }
    console.log(`gallery/community/${file}: ok, "${entry.title}" by ${entry.author}`);
  }

  // The preset set and the file set must be equal. A missing file is a preset nobody can load by
  // URL; an orphaned file is a scene the code no longer has, which `pnpm gallery:build` removes.
  const presetNames = Object.keys(core.PRESETS);
  const fileNames = files.map((file) => file.replace(/\.json$/, ""));
  for (const name of presetNames) {
    if (!fileNames.includes(name)) {
      fail(`gallery/${name}.json: missing for the "${name}" preset; run \`pnpm gallery:build\``);
    }
  }
  for (const name of fileNames) {
    if (!presetNames.includes(name)) {
      fail(`gallery/${name}.json: no preset called "${name}"; \`pnpm gallery:build\` removes it`);
    }
  }

  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    const raw = readFileSync(resolve(galleryDir, file), "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(`gallery/${file}: invalid JSON: ${error.message}`);
      continue;
    }

    // Idempotence through the same validator the renderer uses: if normalizing changes anything,
    // the file is not a config the renderer would actually run.
    const normalized = core.ensureSceneConfig(parsed);
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
      fail(`gallery/${file}: not normalized; regenerate with \`pnpm gallery:build\``);
      continue;
    }

    const preset = core.PRESETS[name];
    if (preset && JSON.stringify(core.ensureSceneConfig(preset())) !== JSON.stringify(parsed)) {
      fail(`gallery/${file}: out of sync with the "${name}" preset; run \`pnpm gallery:build\``);
      continue;
    }

    const items = parsed.scatter ? parsed.scatter.count : parsed.items.length;
    console.log(`gallery/${file}: ok, ${parsed.lamps.length} lamps, ${items} shapes`);
  }

  if (failures > 0) console.error(`gallery: ${failures} problem(s)`);
  return failures === 0;
});
