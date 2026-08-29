/**
 * Gate on the gallery JSON being loadable and in sync with the presets that generated it.
 *
 * Two failures this catches: a config file that no longer parses into a valid scene (a hand edit
 * that dropped a required field), and a preset changed in code without `pnpm gallery:build`
 * being re-run, which would leave `<materials-3d src="gallery/skewer.json">` rendering the old scene.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const galleryDir = resolve(root, "gallery");
const bundle = resolve(root, "packages/core/dist/standalone/materials3d.standalone.js");

let core;
try {
  core = await import(pathToFileURL(bundle).href);
} catch {
  console.error(
    "gallery: the standalone bundle is missing — run `pnpm --filter @materials3d/core build:standalone`",
  );
  process.exit(1);
}

const files = readdirSync(galleryDir).filter((f) => f.endsWith(".json"));

// Community submissions (see apps/studio/src/publishToGallery.ts) live one level down and wrap the
// config in { title, author, config }. They are hand-authored, so they are NOT held to the
// normalization check below — only to being a config the renderer would actually run.
const communityDir = resolve(galleryDir, "community");
const community = existsSync(communityDir)
  ? readdirSync(communityDir).filter((f) => f.endsWith(".json"))
  : [];
if (files.length === 0) {
  console.error("gallery: no configs found");
  process.exit(1);
}

let failures = 0;

for (const file of community) {
  const raw = readFileSync(resolve(communityDir, file), "utf8");
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (error) {
    console.error(`gallery/community/${file}: invalid JSON — ${error.message}`);
    failures++;
    continue;
  }
  if (!entry?.title || !entry?.author || !entry?.config) {
    console.error(`gallery/community/${file}: needs "title", "author" and "config"`);
    failures++;
    continue;
  }
  if (
    /^data:/i.test(entry.config.backgroundImageUrl ?? "") ||
    /^data:/i.test(entry.config.backgroundVideoUrl ?? "")
  ) {
    console.error(`gallery/community/${file}: embedded image/video data — use a hosted URL`);
    failures++;
    continue;
  }
  try {
    core.ensureSceneConfig(entry.config);
  } catch (error) {
    console.error(`gallery/community/${file}: not a runnable config — ${error.message}`);
    failures++;
    continue;
  }
  console.log(`gallery/community/${file}: ok — "${entry.title}" by ${entry.author}`);
}

for (const file of files) {
  const name = file.replace(/\.json$/, "");
  const raw = readFileSync(resolve(galleryDir, file), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`gallery/${file}: invalid JSON — ${error.message}`);
    failures++;
    continue;
  }

  // Idempotence through the same validator the renderer uses: if normalizing changes anything,
  // the file is not a config the renderer would actually run.
  const normalized = core.ensureSceneConfig(parsed);
  if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
    console.error(`gallery/${file}: not normalized — regenerate with \`pnpm gallery:build\``);
    failures++;
    continue;
  }

  const preset = core.PRESETS[name];
  if (preset) {
    const expected = JSON.stringify(core.ensureSceneConfig(preset()));
    if (expected !== JSON.stringify(parsed)) {
      console.error(
        `gallery/${file}: out of sync with the "${name}" preset — run \`pnpm gallery:build\``,
      );
      failures++;
      continue;
    }
  }

  const items = parsed.scatter ? parsed.scatter.count : parsed.items.length;
  console.log(`gallery/${file}: ok — ${parsed.lamps.length} lamps, ${items} shapes`);
}

if (failures > 0) process.exit(1);
