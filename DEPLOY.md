# Deploying & releasing

CI lives in [`.github/workflows`](.github/workflows):

- **`ci.yml`** — on every push / PR to `main`: `pnpm check` (format, lint, typecheck, tests, depcruise, knip, gallery validate) + `pnpm build`. On a push to `main` it then deploys the studio to Cloudflare Pages **if** the Cloudflare secrets are set.
- **`release.yml`** — on push to `main` that touches `packages/**` or `.changeset/**`, [Changesets](https://github.com/changesets/changesets) opens a "Version Packages" PR from any pending changesets; merging that PR publishes the bumped `@materials3d/*` packages to npm via OIDC / Trusted Publishing.

Both need some one-time account setup, below. Until you do it, CI still runs green — it just skips the deploy, and the release workflow manages Version PRs without attempting to publish.

## 1. Deploy the studio → Cloudflare Pages

`pnpm --filter materials-studio build` produces `apps/studio/dist`, deployed to Cloudflare Pages as project **`materials-studio`**.

One-time:

1. **Create a Cloudflare API token.** Dashboard → _My Profile_ → _API Tokens_ → _Create Token_ → template **"Edit Cloudflare Workers"** (or a custom token with **Account → Cloudflare Pages → Edit**). Copy it.
2. **Get your Account ID** from the Cloudflare dashboard (Workers & Pages overview, or the dashboard URL).
3. **Add two GitHub repo secrets** (repo → _Settings_ → _Secrets and variables_ → _Actions_):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. _(Not needed — the workflow creates the project on its first deploy. Do it by hand only if you prefer.)_
   ```sh
   pnpm dlx wrangler login
   pnpm dlx wrangler pages project create materials-studio --production-branch=main
   ```

Then **push to `main`** → CI builds and deploys. The live URL is `https://materials-studio.pages.dev` until you add a custom domain.

### Custom domain

In the Cloudflare Pages project → _Custom domains_ → add the domain (and `www`). If its DNS is on Cloudflare it's a click; otherwise add the CNAME it shows you.

## 2. Publish the packages → npm

The **`@materials3d`**-scoped packages publish via [Changesets](https://github.com/changesets/changesets). `@materials3d/core`, `@materials3d/react` and `@materials3d/element` are a **fixed** group — they always share one version.

### Recording a change

Whenever you change a published package, add a changeset — it drives the next version bump and changelog:

```sh
pnpm changeset          # pick the packages, the bump (patch/minor/major), write a summary
```

Commit the generated `.changeset/*.md` file alongside your change.

### First release (one-time, from your laptop)

npm can't do a package's **first** publish over OIDC, so bootstrap `0.1.0` by hand. First create the free **`@materials3d` organization** on [npmjs.com](https://www.npmjs.com/org/create) (the scope is public; `.changeset/config.json` sets `access: "public"`), then:

```sh
npm login               # uses your account's 2FA — nothing stored anywhere
pnpm install
pnpm release            # builds + publishes @materials3d/{core,react,element}@0.1.0
```

Until this is done, `release.yml`'s **preflight gate** sees `@materials3d/core` is absent from npm and manages Version PRs only — so pre-bootstrap runs stay green instead of failing on a package that has never existed.

### Enable tokenless CI releases (one-time, right after the first publish)

On **each** package's npm page → _Settings_ → _Trusted Publisher_ → add provider **GitHub Actions**, repository **`Amir-Abushanab/materials3d`**, workflow **`release.yml`** (leave _Environment_ blank). Now CI publishes over OIDC with **no `NPM_TOKEN`** — nothing to leak or rotate — and every release gets provenance automatically.

### Adding a new package

A new package needs the same one-time bootstrap as the originals. The preflight gate keys off `@materials3d/core`, so once that exists CI will _try_ to publish the newcomer — but npm can't do a package's **first** publish over OIDC, so the Release workflow **fails** on it until you bootstrap by hand:

1. `npm login` → `pnpm release` from your laptop — publishes the new package's first version (plus any pending bumps).
2. Add its **Trusted Publisher** on npmjs.com — same values as above (GitHub Actions · `Amir-Abushanab/materials3d` · `release.yml`).

After that it releases tokenlessly via CI like the rest.

### Ongoing releases (automated)

1. Merge PRs that include changesets into `main`.
2. Changesets opens/updates a **"Version Packages"** PR (bumps the shared version, writes `CHANGELOG.md`).
3. **Merge that PR** → CI publishes the new version, tags it, and cuts a GitHub Release.

`pnpm release` runs [`scripts/publish-if-needed.mjs`](scripts/publish-if-needed.mjs) rather than `changeset publish`. That script publishes only the versions the registry confirms are missing, and creates each git tag itself. The reason is in its header: `@changesets/cli` 2.31 misreads npm 11 (which the workflow installs for OIDC), tries to publish over an already-published version and crashes on the E403 — _after_ the packages reach npm but _before_ printing the `New tag:` lines `changesets/action` needs, leaving a red run with no tags and no releases. Pass `--dry-run` to preview what it would publish.

> **Benign red run:** merging the Version PR while an older Release run is still in flight can fail that older run with _"The pull request cannot be reopened"_ — it raced the merge. The run for the Version PR's own merge commit does the real work; nothing to fix. The workflow's self-heal step reports the real API status rather than the bare `HttpError` the action surfaces.

> **Fallback:** pnpm's OIDC support is still maturing — if CI publishing 404s, create a granular **`NPM_TOKEN`** (scoped to `@materials3d`, read-write, no IP allowlist) and add it as `NODE_AUTH_TOKEN` in `release.yml`'s changesets step.

## What's _not_ wired up here

- **The gallery** (`gallery/*.json`) is a set of scene configs validated in CI by [`scripts/validate-gallery.mjs`](scripts/validate-gallery.mjs) and regenerated with `pnpm gallery:build`. It is not a deployed page — it ships inside the repo, not the Pages site.
