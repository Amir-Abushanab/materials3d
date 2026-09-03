#!/usr/bin/env node
/**
 * Guarded publish: publishes only the package versions npm does not already have, driving
 * `pnpm publish` directly rather than `changeset publish`.
 *
 * WHY NOT `changeset publish`. @changesets/cli 2.31 is broken against the npm 11 the release
 * workflow installs for OIDC trusted publishing: its pre-publish check misreads npm 11, thinks an
 * already-published package is unpublished, tries to publish over it and crashes on npm 11's E403
 * JSON (`Cannot read properties of undefined (reading 'includes')`), after the packages reach npm
 * and before it reports what shipped. The job goes red with no git tags and no GitHub Releases.
 * (Observed repeatedly in a sibling project; the failure is in changesets + npm, not in anything
 * repo-specific.)
 *
 * WHAT changesets/action READS. v2 does not scan stdout. It hands the publish script a file path
 * in `CHANGESETS_OUTPUT` and reads one JSON object per line from it,
 *   {"type":"git-tag","tag":"@materials3d/core@0.1.0","packageName":"@materials3d/core"}
 * then creates each tag through the GitHub API at the workflow's commit and cuts a Release for it
 * (src/run.ts and src/github.ts in changesets/action). A script that only printed `New tag:`
 * lines, as v1 wanted, publishes and leaves every release untagged. The line is still printed for
 * whoever reads the log; the file is what CI acts on. The local annotated tag is still created
 * too: with `push-with-git-cli` the action pushes tags by `git push origin <tag>`, which needs it
 * to exist in this checkout.
 *
 * Also self-heals: an already-on-npm version whose git tag never reached origin (a past run that
 * published, then died before tags were pushed) is announced again so no release stays tagless.
 * See restoreMissingTags.
 *
 * Run via `pnpm release`, which builds the packages first. Pass `--dry-run` to preview.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, run } from "./lib/cli.mjs";

const USAGE = `usage: pnpm release [--dry-run]

Publishes every non-private package under packages/ whose version is not on npm yet, creates its
git tag, and reports it to changesets/action through the CHANGESETS_OUTPUT file when set.

  --dry-run   print what would be published and which tags restored, publish nothing`;

const packagesDir = new URL("../packages/", import.meta.url);
const label = (list) => list.map((p) => `${p.name}@${p.version}`).join(", ");

/** Every non-private package under packages/, with its directory. */
function publishablePackages() {
  const out = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(new URL(`${entry.name}/package.json`, packagesDir), "utf8"));
    } catch {
      continue; // no readable package.json in this directory
    }
    if (pkg.private || !pkg.name || !pkg.version) continue;
    out.push({
      name: pkg.name,
      version: pkg.version,
      dir: fileURLToPath(new URL(`${entry.name}/`, packagesDir)),
    });
  }
  return out;
}

/** The `error.code` of the JSON npm still writes to stdout when a command fails, if any. */
function npmErrorCode(stdout) {
  try {
    return JSON.parse(String(stdout ?? ""))?.error?.code;
  } catch {
    return undefined;
  }
}

/** Is this exact name@version already on the npm registry? */
function isPublished(name, version) {
  try {
    // --prefer-online revalidates npm's HTTP cache instead of trusting a possibly-stale local
    // packument, so a version published moments ago is still seen.
    const raw = execFileSync("npm", ["view", name, "versions", "--json", "--prefer-online"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let versions = JSON.parse(raw);
    if (!Array.isArray(versions)) versions = [versions]; // single-version packages come back as a bare string
    return versions.includes(version);
  } catch (err) {
    // An unknown package is npm's E404, on stderr and in the JSON it writes to stdout. Match the
    // code and not any "404": a URL or a proxy message could contain those digits too.
    if (/\bE404\b/.test(String(err?.stderr ?? "")) || npmErrorCode(err?.stdout) === "E404") {
      return false;
    }
    // Network / registry / auth hiccup is not evidence the version is unpublished: fail loudly
    // rather than trigger a bogus publish.
    throw err;
  }
}

/** Annotated tag at HEAD, like `changeset publish` makes; a pre-existing tag only warns. */
function ensureLocalTag(tag) {
  try {
    execFileSync("git", ["tag", tag, "-m", tag], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    console.error(`warning: could not create git tag ${tag}: ${String(err?.stderr ?? err)}`);
  }
}

/**
 * Announce a tag: the local tag, the `New tag:` line for the log, and the event changesets/action
 * reads from CHANGESETS_OUTPUT. Outside the action (a laptop publish) there is no file to write.
 */
function announceTag(name, version) {
  const tag = `${name}@${version}`;
  ensureLocalTag(tag);
  console.log(`New tag: ${tag}`);
  const output = process.env.CHANGESETS_OUTPUT;
  if (output) {
    appendFileSync(output, `${JSON.stringify({ type: "git-tag", tag, packageName: name })}\n`);
  }
}

/**
 * A version can be live on npm yet have no git tag or GitHub Release: a previous run published,
 * then died before changesets/action pushed the tags (the sibling repo lost tags twice this way,
 * once to the changesets/npm 11 crash, once to this script not creating them), or the first
 * publish ran from a laptop. Such a version never re-enters `pending`, so without this pass its
 * tag would stay lost on every future run. Announce it again here (at this run's commit; the
 * original release commit isn't knowable) so changesets/action creates the tag and cuts the
 * Release. Never fails the run.
 */
function restoreMissingTags(onNpm, dryRun) {
  if (onNpm.length === 0) return;
  let remote;
  try {
    const raw = execFileSync("git", ["ls-remote", "--tags", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    remote = new Set(
      raw
        .split("\n")
        .map((line) => line.split("\t")[1])
        .filter(Boolean)
        .map((ref) => ref.replace("refs/tags/", "").replace(/\^\{\}$/, "")),
    );
  } catch (err) {
    console.error(
      `warning: could not list origin tags, skipping tag restore: ${String(err?.stderr ?? err)}`,
    );
    return;
  }
  for (const p of onNpm) {
    const tag = `${p.name}@${p.version}`;
    if (remote.has(tag)) continue;
    if (dryRun) {
      console.log(`(dry run) would restore missing tag ${tag}`);
      continue;
    }
    console.log(`Restoring missing tag for already-published ${tag}`);
    announceTag(p.name, p.version);
  }
}

await run(() => {
  const args = parseArgs(process.argv.slice(2), { "dry-run": false });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const dryRun = args["dry-run"];
  const pkgs = publishablePackages();
  const pending = pkgs.filter((p) => !isPublished(p.name, p.version));

  restoreMissingTags(
    pkgs.filter((p) => !pending.includes(p)),
    dryRun,
  );

  if (pending.length === 0) {
    console.log(`Nothing to publish. Already on npm: ${label(pkgs)}`);
    return;
  }

  console.log(`Publishing: ${label(pending)}`);
  if (dryRun) {
    console.log("(dry run) skipping publish");
    return;
  }

  const published = [];
  const failed = [];
  for (const p of pending) {
    try {
      // The same call `changeset publish` makes for a pnpm workspace: from the package dir (so
      // workspace: deps get rewritten), --access public per .changeset/config.json, and
      // --no-git-checks so pnpm doesn't balk at CI's git state. Provenance + npm OIDC trusted
      // publishing come from the workflow env (NPM_CONFIG_PROVENANCE, id-token).
      execFileSync("pnpm", ["publish", "--access", "public", "--no-git-checks"], {
        cwd: p.dir,
        stdio: "inherit",
      });
      announceTag(p.name, p.version);
      published.push(p);
    } catch {
      // A non-zero exit is benign only if the version is already on npm (our pre-check raced a
      // concurrent publish, or misfired); anything else is a real publish failure.
      if (isPublished(p.name, p.version)) {
        console.error(`${p.name}@${p.version} is already on npm; skipping.`);
      } else {
        failed.push(p);
      }
    }
  }

  if (failed.length > 0) throw new Error(`Failed to publish: ${label(failed)}`);
  console.log(`Published: ${label(published)}`);
});
