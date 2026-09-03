/**
 * `pnpm licenses:check`: the license texts @materials3d/core ships must match the repo's copies,
 * and every one of them must be accounted for in the package's THIRD-PARTY-NOTICES.md.
 *
 * The package carries its own copies because npm publishes only what sits under the package
 * directory. A copy that drifts from the root file, or a shipped license with no notice pointing
 * at it, is a redistribution error nothing else would catch.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, run } from "./lib/cli.mjs";
import { CORE, ROOT } from "./lib/paths.mjs";

const USAGE = `usage: pnpm licenses:check

Fails when a file in packages/core/licenses/ differs from the same file under licenses/, or when
packages/core/THIRD-PARTY-NOTICES.md and packages/core/licenses/ disagree about what is shipped.`;

await run(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const rootDir = resolve(ROOT, "licenses");
  const coreDir = resolve(CORE, "licenses");
  const notices = readFileSync(resolve(CORE, "THIRD-PARTY-NOTICES.md"), "utf8");
  const shipped = readdirSync(coreDir)
    .filter((file) => !file.startsWith("."))
    .toSorted();

  const problems = [];
  if (shipped.length === 0) problems.push("packages/core/licenses/ is empty");
  for (const file of shipped) {
    const rootCopy = resolve(rootDir, file);
    if (!existsSync(rootCopy)) {
      problems.push(
        `packages/core/licenses/${file}: no licenses/${file} at the repo root to match`,
      );
    } else if (!readFileSync(rootCopy).equals(readFileSync(resolve(coreDir, file)))) {
      problems.push(
        `packages/core/licenses/${file}: differs from licenses/${file}; copy the root file over it`,
      );
    }
    if (!notices.includes(`licenses/${file}`)) {
      problems.push(`packages/core/THIRD-PARTY-NOTICES.md: no section references licenses/${file}`);
    }
  }
  // A notice pointing at a file the package does not ship is the same error from the other side.
  const referenced = new Set([...notices.matchAll(/licenses\/([\w.+-]+)/g)].map((m) => m[1]));
  for (const file of referenced) {
    if (!shipped.includes(file)) {
      problems.push(
        `packages/core/THIRD-PARTY-NOTICES.md: references licenses/${file}, which the package does not ship`,
      );
    }
  }

  for (const problem of problems) console.error(problem);
  if (problems.length === 0) console.log(`licenses: ok (${shipped.join(", ")})`);
  return problems.length === 0;
});
