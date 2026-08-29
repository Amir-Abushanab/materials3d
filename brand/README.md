# Brand

One mark: **a flat-ended glass rod over a bounded lamp field.**

Every element in it is a claim the renderer actually makes, which is the only reason to prefer it
over a nicer-looking abstraction:

| in the mark                                     | in the renderer                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| colour sits behind the rod, never painted on it | the plate pass — lamps are a field _behind_ the glass                   |
| clear tile between the lamps                    | `lampGate` crushing the Gaussian tails, which is what makes glass clear |
| saturated down the middle, clear at both rims   | the absorption chord, `2R·(N·V)`                                        |
| flat end shown as an ellipse, not a hemisphere  | `rod()`'s fillet — the cue a capsule throws away                        |
| warm fringe on one rim, cool on the other       | per-channel IOR split (`dispersion`)                                    |

Colours are the shipped default lamps (`createDefaultConfig()`), so the mark and the renderer
cannot drift apart without someone noticing.

## Files

| file                                       | use                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `mark.svg`                                 | the mark, on its plate. The default everywhere.                       |
| `mark-bare.svg`                            | no plate, transparent — for surfaces that supply their own background |
| `favicon.svg`                              | the 16px cut. Not the same file — see below.                          |
| `logo.svg` / `logo-dark.svg`               | horizontal lockup, mark + wordmark                                    |
| `favicon.ico`, `favicon-16/32.png`         | raster fallbacks                                                      |
| `apple-touch-icon.png`, `icon-192/512.png` | home screen and PWA manifest                                          |
| `og.svg` / `og.png`                        | 1280×640 social card — link previews and GitHub's repo social preview |

The plate is `#efedeb` — the studio's own backdrop, and the renderer's default `background`.
Corner radius is 22.7% of the tile (58/256), so it matches at any size.

The wordmark is Inter Display SemiBold at `-3.4` tracking, **outlined**: the lockups need no font
at render time. `3d` takes `#8a72d6`, the violet at the rod's face.

Clear space around the lockup is the mark's corner radius — 25px at the 112px lockup height.

## Why `favicon.svg` is a separate file

`mark.svg` scaled to 16px turns to mush: the dispersion fringe and the specular streak are both
sub-pixel there and land as noise, and the chord's clear rim disappears into the downsample.
So the favicon cut drops both, scales the rod up to carry the tile, and pushes the chord and the
lamps harder to survive the resampling. Keep the two in sync by eye, not by diff.

## Regenerating

Rasters (needs `rsvg-convert`, `brew install librsvg`):

```bash
cd brand
rsvg-convert -w 512 mark.svg -o icon-512.png
rsvg-convert -w 192 mark.svg -o icon-192.png
rsvg-convert -w 180 mark.svg -o apple-touch-icon.png
rsvg-convert -w 32  favicon.svg -o favicon-32.png
rsvg-convert -w 16  favicon.svg -o favicon-16.png
rsvg-convert -w 1280 og.svg -o og.png
```

`favicon.ico` bundles the 16px and 32px PNGs; rebuild it with any ICO packer after regenerating
those two.

Wordmarks in `logo.svg`, `logo-dark.svg` and `og.svg` are outlined. To change the type, edit the
text in a source SVG and re-outline it:

```bash
inkscape --export-text-to-path --export-plain-svg --export-filename=logo.svg logo-src.svg
```

## Where it is used

| surface                                            | how                                                             |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `apps/studio/index.html` — favicon                 | `favicon.svg` inlined as a data URI                             |
| `apps/studio/index.html` — panel head              | `mark.svg` inlined as an `<svg>`                                |
| `apps/studio/index.html` — apple-touch, `og:image` | relative path (Vite hashes it) / absolute raw URL               |
| `README.md`                                        | `logo.svg` + `logo-dark.svg` via `<picture>`                    |
| `packages/*/README.md`                             | `icon-192.png` by absolute raw URL — npm strips SVG             |
| GitHub repo social preview                         | upload `og.png` by hand at repo → _Settings_ → _Social preview_ |

Both of the inlined copies in `apps/studio/index.html` exist because that app's `publicDir` is
repointed at the core's standalone build output, so `apps/studio/public/` is never served and a
relative path resolves at build time but 404s under `vite dev`. After changing `favicon.svg` or
`mark.svg`, regenerate those two blocks from the source files — do not hand-edit them.

The embed exporter (`apps/studio/src/export/exporters.ts`) deliberately carries **no** mark: the
document it writes is the user's scene, not ours.
