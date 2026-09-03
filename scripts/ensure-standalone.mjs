/**
 * `node scripts/ensure-standalone.mjs [--force]`: build the standalone bundle only when something
 * it is built from is newer than it.
 *
 * The gallery gate, `pnpm render`, `pnpm sweep` and the studio's pre-scripts all need the bundle,
 * and each used to run the Vite build unconditionally, so a `pnpm check` followed by `pnpm build`
 * built the same file three times over. The inputs are the core sources, the Vite config, the
 * package manifest and the lockfile (three is bundled in, so a three upgrade changes the output);
 * a bundle older than any of them, or no bundle, means build.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs, run } from "./lib/cli.mjs";
import { BUNDLE, CORE, ROOT } from "./lib/paths.mjs";

const USAGE = `usage: node scripts/ensure-standalone.mjs [--force]

Builds packages/core/dist/standalone/materials3d.standalone.js unless it is newer than every input
(packages/core/src, vite.standalone.config.ts, package.json, tsconfig.json and pnpm-lock.yaml).

  --force   build even when the bundle is up to date`;

const INPUTS = [
  resolve(CORE, "src"),
  resolve(CORE, "vite.standalone.config.ts"),
  resolve(CORE, "package.json"),
  resolve(CORE, "tsconfig.json"),
  resolve(ROOT, "pnpm-lock.yaml"),
];

/** The newest file under a path, with its mtime. A directory's own mtime ignores edits inside it. */
function newest(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return { path, mtime: stat.mtimeMs };
  let top = { path, mtime: 0 };
  for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
    // Tests are not bundled, so a test edit must not trigger a rebuild.
    if (!entry.isFile() || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const file = resolve(entry.parentPath, entry.name);
    const mtime = statSync(file).mtimeMs;
    if (mtime > top.mtime) top = { path: file, mtime };
  }
  return top;
}

await run(() => {
  const args = parseArgs(process.argv.slice(2), { force: false });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  let reason = args.force ? "--force" : "";
  if (!reason && !existsSync(BUNDLE)) reason = "no bundle yet";
  if (!reason) {
    const built = statSync(BUNDLE).mtimeMs;
    const changed = INPUTS.filter((input) => existsSync(input))
      .map(newest)
      .find((input) => input.mtime > built);
    if (changed) reason = `${relative(ROOT, changed.path)} is newer than the bundle`;
  }
  if (!reason) {
    console.log("standalone bundle is up to date");
    return;
  }
  console.log(`building the standalone bundle: ${reason}`);
  const result = spawnSync("pnpm", ["--filter", "@materials3d/core", "build:standalone"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`build:standalone exited with ${result.status ?? result.signal}`);
  }
});
