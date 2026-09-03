# Contributing

## Prerequisites

- Node 20.19 or newer (CI runs on 24)
- pnpm 11 (`packageManager` in `package.json` pins the version; `corepack enable` picks it up)
- `pnpm install`
- `pnpm exec playwright install chromium`, for the scripts that render headlessly: `render`,
  `sweep` and the `tsl:*` harnesses

`pnpm install` also points git at `.githooks` through the `prepare` script.

## Layout

| path                | contents                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `packages/core`     | `@materials3d/core`: the renderer, shapes, motions, presets, config model and poster shell |
| `packages/react`    | `@materials3d/react`                                                                       |
| `packages/element`  | `@materials3d/element`                                                                     |
| `apps/studio`       | Materials Studio (Vite, Tweakpane, CodeMirror)                                             |
| `gallery/`          | the shipped presets as JSON, and `gallery/community/` for submissions                      |
| `scripts/`          | headless rendering, calibration, gallery, release and WebGPU harness scripts               |
| `docs/technique.md` | rendering internals                                                                        |
| `WEBGPU.md`         | the second engine                                                                          |
| `DEPLOY.md`         | CI, deploy and release                                                                     |

## The check gate

```bash
pnpm check
```

Runs `format:check`, `lint`, `typecheck`, `test`, `depcruise`, `knip`, `licenses:check` and
`gallery:validate`. CI runs `pnpm build` and then the gate on every push and pull request. Each step is its own script
(`pnpm lint`, `pnpm typecheck`, `pnpm test`, ...). `pnpm format` and `pnpm lint:fix` write fixes.

The pre-commit hook in `.githooks/pre-commit` formats and lints the staged files. CI runs the full
gate.

## Dev loop

```bash
pnpm dev            # http://localhost:5173
```

`@materials3d/core` resolves to its TypeScript sources in dev, so renderer and preset edits
hot-reload. The studio's `predev` builds the core's standalone bundle first, because the studio
serves it for the embed exporter.

Dev builds expose `window.m3d`, a handle on the live scene:

| call                                                      | does                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `m3d.config()`                                            | the live `SceneConfig`                                               |
| `m3d.get("post.bloom")`                                   | read one dotted path                                                 |
| `m3d.patch({ "post.bloom": 0.4, "beam.incidence": -20 })` | write dotted paths and apply them; a path that does not exist throws |
| `m3d.set({ "items.0.material.iridescence": 0.3 })`        | like `patch`, but creates a missing path                             |
| `m3d.preset("orb")`                                       | load a preset                                                        |
| `m3d.presets()`                                           | the preset names                                                     |
| `m3d.still()`                                             | a PNG of the current frame, as an object URL                         |

`patch` and `set` infer whether the change rebuilds geometry (items, scatter, quality, background
mode and so on) or pushes uniforms. Pass `true` or `false` as the second argument to force it.

## Rendering without a browser window

These drive a headless Chromium through the same path the studio's Save still uses, so a headless
render and a studio export of one config are the same image. Time defaults to 0, so output is
byte-identical between runs.

```bash
pnpm render assembly                          # renders/assembly.png at 1920x1080
pnpm render gallery/skewer.json -o hero.png
pnpm render --all -d renders/ -w 1200 -h 630
pnpm render slimes -t 2.5                     # the frame 2.5 s in
```

`render` options: `-o/--out`, `-d/--dir`, `-w/--width`, `-h/--height`, `-t/--time`,
`-q/--quality`, `--all`, `--help`. Output goes to `renders/` unless `-o` or `-d` says otherwise. The format follows the extension (`.png`, `.webp`, `.jpg`). A scene is a
preset name or a path to a config JSON.

```bash
pnpm sweep orb +items.0.material.magnify=0,0.5,1
pnpm sweep orb plate.z=-2,-6,-14 +items.0.material.magnify=0,1
```

`sweep` renders one labelled contact sheet: one `path=v,v,v` axis is a row, two make a grid. A
leading `+` creates a path that is not in the config yet. Options: `-o/--out`, `-w/--width` and
`-h/--height` (per cell), `-t/--time`.

```bash
pnpm preset:from ~/Downloads/scene.json --base prism
```

`preset:from` prints the difference between a saved config and a base preset (or the defaults) as
source to paste into `presets.ts`. Needs `pnpm --filter @materials3d/core build` first.

```bash
pnpm calibrate reference.png render.png [--box x0,y0,x1,y1] [--step n]
```

`calibrate` measures the clear-glass ratio and hue histogram of one or two PNGs. See
[docs/technique.md](docs/technique.md#14-calibration).

## Gallery

`gallery/*.json` is generated from the presets by `pnpm gallery:build` and checked by
`pnpm gallery:validate` (part of `pnpm check`): every file must parse, normalise to itself and
match its preset. After changing a preset, run `gallery:build` and commit the JSON.

Community scenes live in `gallery/community/` as `{ title, author, config }`. The studio's
Publish to gallery button opens GitHub's new-file page for that directory with the scene
prefilled, so a submission arrives as a pull request. `gallery:validate` checks that each one is a
runnable config and carries no embedded image or video data.

## Changesets

A change to a published package needs a changeset:

```bash
pnpm changeset
```

Pick the packages and the bump, write a summary, and commit the generated `.changeset/*.md` with
the change. `@materials3d/core`, `@materials3d/react` and `@materials3d/element` are a fixed group
and share one version. The studio is private and takes no changesets. Release mechanics are in
[DEPLOY.md](DEPLOY.md).

## The WebGPU engine

The second engine and its harnesses (`tsl:parity`, `tsl:compare`, `tsl:perf`, `tsl:interaction`,
`tsl:chrome`) are described in [WEBGPU.md](WEBGPU.md).
