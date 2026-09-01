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
| reactions |      0.42 | staircase |      2.91 |
| assembly  |      1.14 | cascade   |      5.17 |
| materials |      1.57 | skewer    |      5.33 |
| slimes    |      2.54 | prism     |      7.91 |

Reproduce with `node scripts/tsl-compare.mjs <preset>`, which renders the same scene through both
engines and writes `compare-<preset>-{glsl,tsl,diff}.png`.

## What is known to differ

**`skewer`, at 5.33, is the largest and least explained.** None of the fixes so far touched it: no
camera bindings, no wall, no `positionY` racing a motion, no back-glass. It is 1.74 with post
disabled, so most of it is post amplifying something upstream, and it is the only preset built
entirely from rods via `scatter`.

**Post amplifies rather than causes.** `prism` is 7.91 with post and about 0.2 without; `cascade`
5.17 against 2.13. The bloom and tone-map passes are parity-clean. Reducing these numbers means
finding what still differs upstream, not looking at post.

### Cautionary tales

Every one of these was stated confidently, with evidence, and was wrong.

**It was not the specular lobe.** It differed threefold and `specular: 0` made the engines agree.
That was a symptom: the WebGL engine captured from a camera displaced by an interaction binding,
and `pow(dot(...), 40)` turns a degree of arc into a factor of three.

**`staircase` was not a shading difference.** Every shading probe agreed it was. The cause was this
engine applying interaction bindings BEFORE motions rather than after, so each shape sat a tenth of
a unit from where the other engine put it — a pose error, because the measured optical path reads
the pose.

**`prism`'s residual was not sub-pixel bevel coverage.** It looked exactly like it. It was
byte-identical at 450, 900 and 1800 pixels wide, which no coverage artefact would be. It was the
contact shadow, from a nested `Loop`.

**The noise difference was not irreducible.** It was argued — correctly — that
`fract(sin(x) * 43758)` cannot be reproducible across backends, and concluded that the wall's noise
therefore could not be matched. The two engines were running DIFFERENT HASH FUNCTIONS: Hoskins' in
GLSL, the sine one in the node graph. Sound reasoning about the wrong question. Checking which
function each side actually called would have taken a minute and the difference went to zero.

The pattern worth carrying: a difference in term X usually means an input to X is wrong upstream,
and the term that _looks_ responsible is the one amplifying rather than the one causing. Check
resolution dependence before believing anything about rasterisation, and check that both sides are
running the same function before theorising about why the same function disagrees.

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

- `node scripts/tsl-parity.mjs` — 53 term-by-term cases, each a single node function against its
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
- Not every probe exists on both sides. `GLSL_PROBES` in `scripts/tsl-compare.mjs` is the list, and a
  name missing from it silently falls through to a normal render on the GLSL side, which looks like a
  huge difference rather than like a missing probe.

**Build cases from the shader source, never from a transcription of it.** `NOISE_CHUNK` and
`FOOTPRINT_CHUNK` are exported from `shaders.ts` for exactly this. Two parity cases once carried
hand-written GLSL twins that used a different hash than the engine, so they agreed with a port that
was also wrong and passed for as long as they existed — the one failure mode a parity case must not
have, because it fails silently in the direction that hides bugs.

`--shift dx,dy` offsets the node image before diffing, for checking registration. Measured on the
composed frames, zero is best — the two engines are correctly registered.

Even with all of that, corroborating an important finding with a config A/B remains worthwhile: the
specular result on this page was established that way first and only then confirmed by probe.
