# Deploying and releasing

CI lives in [`.github/workflows`](.github/workflows):

- **`ci.yml`**: on every push and pull request to `main`, `pnpm build` then `pnpm check` (format,
  lint, typecheck, tests, depcruise, knip, license notices, gallery validate). On a push to `main` it deploys the
  studio to Cloudflare Pages if the Cloudflare secrets are set.
- **`release.yml`**: on a push to `main` that touches `packages/**` or `.changeset/**`,
  [Changesets](https://github.com/changesets/changesets) opens a "Version Packages" PR from any
  pending changesets; merging that PR publishes the bumped `@materials3d/*` packages to npm over
  OIDC / Trusted Publishing.

Both need one-time account setup, below. Until then CI stays green: it skips the deploy, and the
release workflow manages Version PRs without attempting to publish.

## 0. The public repo

The repo must exist publicly at `github.com/Amir-Abushanab/materials3d` before the first publish.
npm provenance points at it, the package READMEs load `brand/icon-192.png` from it by raw URL, and
the studio's `og:image` points at `brand/og.png` there.

## 1. Deploy the studio to Cloudflare Pages

`pnpm --filter materials-studio build` produces `apps/studio/dist`, deployed to Cloudflare Pages as
project **`materials-studio`**.

One-time:

1. **Create a Cloudflare API token.** Dashboard, My Profile, API Tokens, Create Token, template
   "Edit Cloudflare Workers" (or a custom token with Account, Cloudflare Pages, Edit). Copy it.
2. **Get your Account ID** from the Cloudflare dashboard (Workers & Pages overview, or the
   dashboard URL).
3. **Add two GitHub repo secrets** (repo Settings, Secrets and variables, Actions):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. Optional. The workflow creates the project on its first deploy. To do it by hand:
   ```sh
   pnpm dlx wrangler login
   pnpm dlx wrangler pages project create materials-studio --production-branch=main
   ```

Then push to `main`: CI builds and deploys. The live URL is `https://materials-studio.pages.dev`
until you add a custom domain.

The deploy preflight checks that both secrets are set and skips the deploy with a notice when
either is missing. The check job uploads the studio build as a workflow artifact, and the deploy
job deploys that artifact rather than building again.

### Custom domain

In the Cloudflare Pages project, Custom domains, add the domain (and `www`). If its DNS is on
Cloudflare it is a click; otherwise add the CNAME it shows you.

## 2. Publish the packages to npm

The `@materials3d` packages publish through Changesets. `@materials3d/core`, `@materials3d/react`
and `@materials3d/element` are a **fixed** group and always share one version. The studio
(`materials-studio`) is private and takes no changesets.

### Recording a change

Whenever you change a published package, add a changeset. It drives the next version bump and
changelog:

```sh
pnpm changeset          # pick the packages, the bump (patch/minor/major), write a summary
```

Commit the generated `.changeset/*.md` file alongside your change.

### First release (one-time, from your laptop)

The packages are at 0.1.0 with hand-written `CHANGELOG.md` files, and no changeset is pending for
that version. npm cannot do a package's first publish over OIDC, so publish 0.1.0 by hand. First
create the free **`@materials3d` organization** on [npmjs.com](https://www.npmjs.com/org/create)
(the scope is public; `.changeset/config.json` sets `access: "public"`), then:

```sh
npm login               # uses your account's 2FA; nothing is stored in the repo
pnpm install
pnpm release            # builds and publishes @materials3d/{core,react,element}@0.1.0
```

After that, changesets as normal: each merged changeset feeds the next Version Packages PR.

Until 0.1.0 is on npm, `release.yml`'s preflight gate sees `@materials3d/core` absent from the
registry and manages Version PRs only, so earlier runs stay green.

### Enable tokenless CI releases (one-time, right after the first publish)

On each package's npm page: Settings, Trusted Publisher, add provider **GitHub Actions**,
repository **`Amir-Abushanab/materials3d`**, workflow **`release.yml`** (leave Environment blank).
CI then publishes over OIDC with no `NPM_TOKEN`, and every release carries provenance.

### Adding a new package

A new package needs the same bootstrap. The preflight gate keys off `@materials3d/core`, so once
that exists CI will try to publish the newcomer, and fails on it until you bootstrap by hand:

1. `npm login`, then `pnpm release` from your laptop. This publishes the new package's first
   version plus any pending bumps.
2. Add its Trusted Publisher on npmjs.com with the same values as above.

### Ongoing releases (automated)

1. Merge PRs that include changesets into `main`.
2. Changesets opens or updates a **"Version Packages"** PR (bumps the shared version, writes
   `CHANGELOG.md`).
3. Merge that PR. CI publishes the new version, tags it and cuts a GitHub Release.

`pnpm release` runs [`scripts/publish-if-needed.mjs`](scripts/publish-if-needed.mjs) rather than
`changeset publish`. The script publishes only the versions the registry confirms are missing,
creates each git tag locally, and writes the NDJSON git-tag events that `changesets/action` v2
reads to push the tags and create the releases. It exists because `@changesets/cli` 2.31 misreads
npm 11 (which the workflow installs for OIDC), tries to publish over an already-published version
and crashes on the E403 after the packages have reached npm, leaving a red run with no tags. It
also restores a tag that a past run published but never pushed. Pass `--dry-run` to preview what
it would publish.

> **Benign red run:** merging the Version PR while an older Release run is still in flight can
> fail that older run with "The pull request cannot be reopened". The run for the Version PR's own
> merge commit does the real work. The workflow's self-heal step reports the real API status rather
> than the bare `HttpError` the action surfaces.

> **Fallback:** if OIDC publishing 404s, create a granular `NPM_TOKEN` (scoped to `@materials3d`,
> read-write, no IP allowlist) and add it as `NODE_AUTH_TOKEN` in `release.yml`'s changesets step.

## The pre-commit hook

`pnpm install` sets `core.hooksPath` to `.githooks` through the `prepare` script. The hook formats and lints the staged files. CI runs the full
`pnpm check` gate.

## What is not wired up here

- **The gallery** (`gallery/*.json`) is a set of scene configs validated in CI by
  [`scripts/validate-gallery.mjs`](scripts/validate-gallery.mjs) and regenerated with
  `pnpm gallery:build`. It is not a deployed page; it ships inside the repo, not the Pages site.
- **Community scenes** (`gallery/community/*.json`) arrive as pull requests from the studio's
  Publish button and are validated by the same script. Nothing renders or lists them.
