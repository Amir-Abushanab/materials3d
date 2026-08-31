# The WebGPU / TSL engine

A second renderer built on three's `WebGPURenderer` and TSL, implementing the same `Engine` surface
as the WebGL one so a scene config can be handed to either.

**It is experimental. WebGL is the reference.** It renders every preset and agrees closely on most
of them, but it is not pixel-equal, and the gap is not uniform across scenes. Anything that has to
match a design should be checked on both.

```ts
createMaterials(el, config, { renderer: "webgpu" });
```

Or import the class directly, as `@materials3d/core/renderer-webgpu`.

It is opt-in rather than automatic because it is a separate build: the default path stays around
733 KB, this one is nearer 1,028 KB, and a consumer who will never touch it should not pay for it.

Note that `"webgpu"` selects the **engine**, not the backend — three's node renderer falls back to
a WebGL backend wherever the browser has no WebGPU. What it buys is TSL, and a WebGPU backend where
one exists.

## Where it stands

Whole-frame mean absolute difference against the WebGL engine, over the eight gallery presets.
0 is identical, 255 is the maximum possible.

| preset    | mean\|d\| | preset    | mean\|d\| |
| --------- | --------: | --------- | --------: |
| reactions |      0.49 | staircase |      2.91 |
| assembly  |      1.14 | cascade   |      7.60 |
| materials |      1.57 | skewer    |      8.02 |
| slimes    |      2.73 | prism     |     16.31 |

Reproduce with `node scripts/tsl-compare.mjs <preset>`, which renders the same scene through both
engines and writes `compare-<preset>-{glsl,tsl,diff}.png`.

## What is known to differ

**The bevels and other sub-pixel geometry.** The two rasterizers disagree by about one pixel of
coverage at a silhouette. Interiors agree exactly — on a validated interior crop of the prism every
material probe (world position, view vector, mirror vector, N·V, the specular lobe's argument and
the lobe itself) reads a difference of exactly **zero**. What is left on `prism` is concentrated in
a thin bright ring on the bevel, a sub-pixel-wide band of steeply-angled faces.

**The wall backdrop's shading**, in `wall` mode — `prism` and `cascade`. Both engines now receive
identical wall uniforms, so this is a difference in the shader itself, not in what feeds it. It is
not the relief: zeroing both relief scales in both engines halves the backdrop-only difference but
does not touch the prism case. `wallShade` and `footprintDistance` have no parity case yet, which is
the obvious next step.

**Post amplifies whatever reaches it.** On `prism`, 11.92 with post on against 4.41 with it off,
spread across bloom (~2.7) and the tone map (~3.7) rather than concentrated in one term.

**`skewer` has a residual that has not been attributed to anything.** None of the three fixes so
far touched it: it has no camera bindings, no wall, and no `positionY` binding racing a motion — so
it is a fourth cause. The obvious place to start is that it is the one preset built entirely from
rods.

### Two cautionary tales

**It was not the specular lobe**

An earlier version of this page blamed the specular lobe, on good evidence: it differed threefold,
and `specular: 0` made the two engines agree. That was a symptom. The cause was that the WebGL
engine captured from a camera displaced by an interaction binding, and `pow(dot(...), 40)` turns a
degree of arc into a factor of three. Fixing the camera collapsed the lobe difference to exactly
zero — along with every other material intermediate. Worth remembering when the next "obviously it
is term X" presents itself.

**And `staircase` was not a shading difference at all.** It read as one across a third of the frame,
and every shading probe agreed: the optical path differed, and so did everything downstream of it.
The cause was that this engine applied interaction bindings BEFORE motions rather than after, so
every shape sat about a tenth of a unit from where the other engine put it. A pose error, arriving
entirely disguised as a shading error, because the measured optical path reads the pose.

## What has been ruled out

Each of these was compared directly and matches: the traced refraction path, the back-glass pass,
the plate depth guard, the traced and measured optical chord, the back-face depth, the refracted
screen-space offset, `clearGlass`, the absorption block, the reflection weight, the studio mode, and
both studio room functions (which are parity-clean). An **opaque** prism matches exactly, which rules
out the geometry and the room together. The camera, the mesh transforms and the projection are
byte-identical, and so — on a validated interior crop — is every material intermediate.

The wall's extent, the `frame`/`size` pair it derives from, and all eighteen wall uniforms match
exactly, so the wall difference is inside `wallShade` itself.

## Working on it

Two harnesses, both headless:

- `node scripts/tsl-parity.mjs` — 50 term-by-term cases, each a single node function against its
  GLSL twin. Fast, and the first thing to check.
- `node scripts/tsl-compare.mjs <preset>` — whole-frame diff, with `--crop`, `--probe`, `--at`.

And one that is not: `pnpm tsl:chrome` drives the studio's own UI in a real Chrome. It exists
because headless Chromium falls back to a software adapter whose WGSL front end is more permissive
than a Metal- or Vulkan-backed one. `pow()` with a negative constant base compiled fine headlessly
and was rejected outright on a real GPU, which took down every pipeline in this engine while every
headless check stayed green. Run it before believing the engine works.

### The probes

`--probe <name>` substitutes an intermediate into the material in both engines and then **bypasses
post entirely**, blitting the colour target straight to the screen. That matters: post is
non-linear, and a probe read through tone mapping, bloom, haze, vignette and grain is a different
number — one that saturates, that shifts by a constant, and that answers identically for two
different probes wherever the shape covers little of the frame. Probes were read through post for a
long time here and produced several confident wrong conclusions.

**Always validate the crop before trusting a number.** Two probes exist for exactly this:

- `--probe calib` is a constant. On a crop that lies entirely inside the shape it must read
  `mean|d| 0.00`. Anything else means the crop includes background or a silhouette edge, and every
  other number measured on that crop is contaminated.
- `--probe rampX` is a horizontal ramp of the fragment's own x — provably identical in both
  engines, but _varying_, so unlike `calib` it can expose interpolation, MSAA resolve and target
  precision. It also reads `0.00`, which is what establishes that there is no noise floor: on a
  validated crop, **any** nonzero difference is real.

So the workflow is: pick a crop, confirm `calib` and `rampX` are both `0.00`, then measure.

Two things still to know:

- Silhouette pixels differ by about one pixel of coverage between the two rasterizers. Interiors
  agree exactly (that is what `calib 0.00` on an interior crop shows), so this only matters if a
  crop touches an edge — which is what `calib` is there to catch.
- Not every probe exists on both sides. `GLSL_PROBES` in `scripts/tsl-compare.mjs` is the list, and
  a name missing from it silently falls through to a normal render on the GLSL side, which looks
  like a huge difference rather than like a missing probe.

`--shift dx,dy` offsets the node image before diffing, for checking registration. Measured on the
composed frames, zero is best — the two engines are correctly registered.

Even with all of that, corroborating an important finding with a config A/B remains worthwhile: the
specular result on this page was established that way first and only then confirmed by probe.
