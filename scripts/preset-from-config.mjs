/**
 * `pnpm preset:from <config.json> [--base <preset>]`: a tuned scene, as source you can paste.
 *
 * The gallery flows one way: `pnpm gallery:build` writes JSON out of the preset functions, and
 * nothing comes back. So a scene tuned in the studio, which is where scenes SHOULD be tuned, since
 * a slider and a live frame beat a rebuild per guess, had no route into `presets.ts` except
 * retyping it by hand against a diff you had to work out yourself.
 *
 * This prints the DIFFERENCE and not the config: a preset that dumped every field would bury the
 * three numbers that matter under two hundred that are just the defaults, and the point of those
 * functions is that what they contain is what somebody chose. Paste the output into
 * `{ ...createDefaultConfig(), <here> }`, or with `--base prism`, into `{ ...prism(), <here> }`.
 *
 *   pnpm preset:from scene.json                 # a config saved from the studio
 *   pnpm preset:from scene.json --base prism
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, run } from "./lib/cli.mjs";
import { DIST } from "./lib/paths.mjs";

const USAGE = `usage: pnpm preset:from <config.json> [--base <preset>]

Prints the fields in which the config differs from the defaults (or from --base's preset), as a
TypeScript object literal to paste into packages/core/src/presets.ts.`;

/** Arrays are replaced wholesale rather than merged. A scene's `items` and `lamps` are ordered
 *  lists whose entries mean nothing individually; a per-index diff of them is unreadable, and
 *  wrong the moment one is inserted. */
function diff(subject, base) {
  if (Array.isArray(subject) || Array.isArray(base)) {
    return JSON.stringify(subject) === JSON.stringify(base) ? undefined : subject;
  }
  if (
    subject === null ||
    typeof subject !== "object" ||
    base === null ||
    typeof base !== "object"
  ) {
    return Object.is(subject, base) ? undefined : subject;
  }
  const out = {};
  for (const key of Object.keys(subject)) {
    const d = diff(subject[key], base[key]);
    if (d !== undefined) out[key] = d;
  }
  // A key the base has and the subject does not is a real difference, and the only honest way to
  // say it in a spread is `undefined`, which is also what the normalizers read as "absent".
  for (const key of Object.keys(base)) {
    if (!(key in subject)) out[key] = undefined;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Print as source rather than JSON: unquoted keys where they are identifiers, and `undefined`
 *  preserved, so the result pastes into a `.ts` file without a second pass. */
function literal(value, indent = "  ") {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => inner + literal(v, inner)).join(",\n")},\n${indent}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const body = keys
    .map(
      (k) =>
        `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${literal(value[k], inner)}`,
    )
    .join(",\n");
  return `{\n${body},\n${indent}}`;
}

await run(async () => {
  const args = parseArgs(process.argv.slice(2), { base: "" });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const file = args.positionals[0];
  const baseName = args.base || undefined;
  if (!file) throw new Error(USAGE);
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  if (!existsSync(resolve(DIST, "presets.js"))) {
    throw new Error("build the package first: pnpm --filter @materials3d/core build");
  }

  const { PRESETS } = await import(pathToFileURL(resolve(DIST, "presets.js")).href);
  const { ensureSceneConfig, createDefaultConfig } = await import(
    pathToFileURL(resolve(DIST, "index.js")).href
  );
  if (baseName && !PRESETS[baseName]) {
    throw new Error(`no preset "${baseName}"; presets are: ${Object.keys(PRESETS).join(", ")}`);
  }

  // BOTH sides normalized. Comparing a hand-saved file against a normalized base reports every
  // field the normalizer would have filled in as a difference, which is most of them.
  const subject = ensureSceneConfig(JSON.parse(await readFile(path, "utf8")));
  const base = ensureSceneConfig(baseName ? PRESETS[baseName]() : createDefaultConfig());
  const delta = diff(subject, base) ?? {};
  const keys = Object.keys(delta);

  const spread = baseName ? `...${baseName}()` : "...createDefaultConfig()";
  console.log(`// ${keys.length} field(s) differ from ${baseName ?? "the defaults"}`);
  console.log(`{\n  ${spread},`);
  for (const key of keys) console.log(`  ${key}: ${literal(delta[key])},`);
  console.log("}");
});
