# The WebGPU / TSL engine

A second renderer built on three's `WebGPURenderer` and TSL. It implements the same `Engine`
surface as the WebGL engine, so one scene config runs on either.

## Status

Experimental. The WebGL engine is the reference. This engine renders every preset and agrees
closely on most of them, but it is not pixel-equal and the gap is not uniform across scenes.
Anything that has to match a design should be checked on both.

Opt in per mount:

```ts
createMaterials(el, config, { renderer: "webgpu" });
```

`<Materials3D renderer="webgpu" />` and `<materials-3d renderer="webgpu">` pass the same option.
The class is exported as `@materials3d/core/renderer-webgpu`. It is not re-exported from
`@materials3d/core/renderer`, because it is a separate three build and naming it in that barrel
would pull `three/webgpu` into every consumer.

## What it buys

TSL, and a WebGPU backend where the browser has one. `"webgpu"` selects the engine, not the
backend: three's node renderer falls back to a WebGL backend where WebGPU is unavailable. It is
opt-in because it is a separate, larger bundle that a WebGL-only consumer should not pay for.

## Parity

Whole-frame mean absolute difference against the WebGL engine over the eight presets, 0 to 255,
measured with `pnpm tsl:compare <preset>`.

| preset    | mean abs diff | preset    | mean abs diff |
| --------- | ------------: | --------- | ------------: |
| assembly  |          0.44 | prism     |          0.42 |
| materials |          1.56 | reactions |          0.33 |
| orb       |          0.46 | skewer    |          0.31 |
| slimes    |          0.37 | staircase |          0.24 |

Measured at 640x380 on 2 September 2026. Headless Chromium has no WebGPU adapter here, so the
harness exercises this engine's WebGL backend; check a real GPU with `pnpm tsl:chrome`. The
term-by-term parity suite passes 53 of 53 cases.

The `orb` row is the scene that preset drew; it was replaced by `knot`, measured on 5 September
2026 at the same size: **mean abs diff 2.60, worst 140, 16.4% of pixels over 4**. The rows above
are left as the record of that earlier run rather than restated for a scene they did not measure.

That 2.60 is well above every other preset and it is not the `model` kind. The difference is
localized to silhouette edges and shows just as strongly on the rod and the disc beside the knot,
which are primitives; a trefoil is a thin tube folded through itself, so it carries several times
the silhouette per unit area and an edge-localized difference lands in far more pixels. The same
engine gap on a sphere reads as 0.46 because a sphere is nearly all interior.

## Performance

`pnpm tsl:perf` times `captureImage` on both engines in a real Chrome and subtracts the same
measurement on an empty scene to remove the encoder. It is the cost of one frame, not a frame
rate: nothing runs the rAF loop. Milliseconds at 900x540.

| preset    | webgl | webgpu | ratio |
| --------- | ----: | -----: | ----: |
| assembly  |   6.6 |    9.8 | 1.48x |
| materials |   7.4 |    9.9 | 1.34x |
| orb       |   6.4 |   10.0 | 1.56x |
| prism     |   3.7 |    0.1 | 0.03x |
| reactions |   5.0 |    5.6 | 1.12x |
| skewer    |   6.3 |   10.0 | 1.59x |
| slimes    |   5.6 |    9.9 | 1.77x |
| staircase |   6.1 |    9.9 | 1.62x |

Median of 18 frames in real Chrome on 2 September 2026. Totals land on vsync multiples, so the
subtraction is coarse and small differences are noise. `prism` is the one scene with a tone map,
half-float targets and a pyramid bloom, where this engine is far cheaper.

## What is known to differ

- `environment: "baked"` renders the analytic room on this engine. The bake chain produces the
  right map (the `env0` and `env3` probes agree with WebGL) but the item shader's room lookup does
  not read it (9.27 mean abs diff on the `materials` preset with a baked environment).
- `prism` with `bloomMode: "gather"` and no dust reads 10.9 against WebGL; pyramid mode, which the
  preset uses, reads 0.42.

- Frosted roughness on the `materials` preset. The frosted row's difference scales smoothly with
  roughness and has no jump at a mip boundary. The env mip chain is a half-float chain written by
  hand and sampled at an explicit LOD, and the two backends filter it slightly differently. Metal,
  ceramic and plastic are identical; glass, glitter and liquid differ only along silhouettes.
- Silhouette coverage differs by about one pixel between the two rasterisers. Interiors are
  identical.
- The interaction controller attaches after the WebGPU device is initialised, where the WebGL
  engine attaches its pointer listeners in its constructor. A pointer already over the canvas at
  startup is missed on this engine.

## Working on it

Every harness is a root script; the `tsl:*` scripts build the core first.

| script                      | does                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm tsl:parity`           | term-by-term cases, each a node function against its GLSL twin, headless. Fast; run it first.                                                    |
| `pnpm tsl:compare <preset>` | whole-frame diff through both engines; writes `compare-<preset>-{glsl,tsl,diff}.png` into `renders/`                                             |
| `pnpm tsl:perf`             | frame cost on both engines in a real Chrome; `--scene`, `--width`, `--height`, `--frames`, `--out`                                               |
| `pnpm tsl:interaction`      | identical pointer, wheel and right-drag input into both engines, comparing the binding state rather than pixels; `--scene`, `--settle`, `--rest` |
| `pnpm tsl:chrome`           | drives the running studio (`pnpm dev`) in a real Chrome on both engines; `--url`, `--engine`, `--shots`                                          |
| `pnpm tsl:live`             | a live frame from each engine at the same scene time, through the rAF loop; `--no-dust`, `--out`                                                 |

`tsl:chrome` exists because headless Chromium serves WebGPU from a software adapter whose WGSL
front end is more permissive than a Metal- or Vulkan-backed one. Run it before believing the
engine works.

`tsl:compare` options:

- `--settle <ms>`: wait before capturing, for scenes whose media loads through a callback. A still
  background image needs about 1200; a video about 3500.
- `--time <t>`: capture both engines at an explicit scene time through `captureImage`, which is
  deterministic. `--loop` runs both on the wall clock and is not.
- `--probe <name>`: substitute one intermediate of the glass graph in both engines and bypass
  post, blitting the colour target straight to the screen. Post is non-linear, so a probe read
  through it is a different number. `GLSL_PROBES` in `scripts/tsl-compare.mjs` lists the names the
  GLSL side knows; a name missing there falls through to a normal render and looks like a large
  difference.
- `--crop x,y,w,h`: measure a region.
- `--shift dx,dy`: offset the node image before diffing, for registration checks. Zero is correct
  on the composed frames.
- `--at x,y;x,y`: print raw pixel values. They are byte/255, not sRGB-decoded.

Validate a crop before trusting a number. `--probe calib` is a constant: on a crop inside the
shape it must read `0.00`, and anything else means the crop touches background or an edge.
`--probe rampX` is a horizontal ramp of the fragment's own x, identical in both engines but
varying, so it exposes interpolation, MSAA resolve and target precision; it also reads `0.00`,
which establishes that there is no noise floor. Pick a crop, confirm both read `0.00`, then
measure.

Build parity cases from the shader source, never from a transcription. `NOISE_CHUNK` and
`FOOTPRINT_CHUNK` are exported from `shaders.ts` for this. A hand-written GLSL twin that drifts
from the engine agrees with a port that is also wrong.

Post's gather counts are build-time constants (`postPass` unrolls its loops), so `quality` stays
in `setConfig`'s structural test. `draw` must contain no `await`; the mutex around it guards state
a partial run would corrupt.

## Lessons

- Check resolution dependence before believing anything about rasterisation. A difference that is
  byte-identical at 450, 900 and 1800 pixels wide is not coverage.
- Check that both sides run the same function before theorising about why the same function
  disagrees.
- Check the instrument before the subject. A probe that answers identically for two different
  intermediates measures nothing.
- A difference in a term usually means an input upstream is wrong; the term that looks responsible
  is amplifying. Confirm an all-off baseline lands near zero before measuring against it.
- Measure orientation flips; do not reason about them. Every blit stores rows inverted relative to
  the uv it was drawn with; one hides it, two undo it, and only a chain shows it.
