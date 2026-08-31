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
| reactions |      0.49 | skewer    |      8.02 |
| assembly  |      1.14 | staircase |     11.17 |
| materials |      1.57 | cascade   |     12.41 |
| slimes    |      2.73 | prism     |     19.41 |

Reproduce with `node scripts/tsl-compare.mjs <preset>`, which renders the same scene through both
engines and writes `compare-<preset>-{glsl,tsl,diff}.png`.

## What is known to differ

**The specular lobe is weaker.** A rod gains +2.4 brightness from it where the WebGL engine gains
+4.5. This is most of the remaining spread, and it is not prism-specific — it is simply largest
where the specular contribution is largest.

The lobe is `pow(dot(reflect(-V, N), KEY), 40)`. At that exponent a fraction of a degree is a factor
of two, and on a **flat face** the mirror direction is constant across the whole face, so the face
either catches the highlight or does not. On a smooth surface the same error only slides the
highlight slightly. That is why `prism` and `hex` are worst affected and spheres, rods, cones,
discs, slabs and rings are near-exact, and why the opaque path is unaffected — it reads the room,
which is smooth in direction and forgiving.

Isolated by config A/B: with `specular: 0` the two engines agree (16.2 vs 16.0 on the prism body);
with it on they are 99.4 vs 47.3.

**`staircase` has a residual that has not been attributed to anything.** It is a bright scene,
unlike the other two worst cases, so it may well be a different cause rather than more of the same.

### The measured chain, and where it stops

On a validated interior crop of the prism (`--crop 500,270,50,50`, where `calib` and `rampX` both
read `0.00`, so every figure below is real):

| probe     | mean\|d\| | worst | pixels >4 |
| --------- | --------: | ----: | --------: |
| `calib`   |      0.00 |     0 |      0.0% |
| `rampX`   |      0.00 |     0 |      0.0% |
| `ndvP`    |      2.20 |     4 |      0.0% |
| `posW`    |      4.13 |     5 |     13.5% |
| `dotKey`  |      5.84 |     7 |    100.0% |
| `viewV`   |      7.71 |     8 |    100.0% |
| `mirrorV` |      7.73 |     8 |    100.0% |
| `lobe`    |     15.83 |    26 |    100.0% |

`dotKey` is the lobe's argument before the exponent. It differs by about 0.02 — under two degrees —
and `pow(·, 40)` turns that into the threefold `lobe` difference, which is the specular deficit.
`chord` (0.05) and the room functions match, so the lobe is the whole story here.

**Where it stops, and the next lead.** `view` is `normalize(cameraPosition - positionWorld)`. Both
engines compute exactly that; the cameras are byte-identical (position, fov, aspect, quaternion,
view matrix, projection X/Y). Yet `viewV` differs on 100% of pixels by roughly eight times what the
measured `posW` difference and an identical camera can account for. One of `cameraPosition` or
`positionWorld` is therefore not the quantity it is assumed to be on one side. That inconsistency
is the sharpest remaining lead — and note that swapping `normalWorld` for `normalWorldGeometry`
changes `lobe` not at all, so the normal is not it.

## What has been ruled out

Each of these was compared directly and matches: the traced refraction path, the back-glass pass,
the plate depth guard, the traced and measured optical chord, the back-face depth, the refracted
screen-space offset, `clearGlass`, the absorption block, the reflection weight, the studio mode, and
both studio room functions (which are parity-clean). An **opaque** prism matches exactly (141.9 vs
142.5), which rules out the geometry and the room together. The camera (position, fov, aspect,
quaternion, view matrix, projection X/Y), the mesh transforms and the geometry are byte-identical.

Whatever is left in `V` or `N` is below what the current instrumentation can resolve.

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
