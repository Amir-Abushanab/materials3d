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
| staircase |      0.17 | assembly  |      0.30 |
| skewer    |      0.24 | prism     |      0.36 |
| reactions |      0.27 | cascade   |      0.59 |
| slimes    |      0.27 | materials |      1.17 |

Reproduce with `node scripts/tsl-compare.mjs <preset>`, which renders the same scene through both
engines and writes `compare-<preset>-{glsl,tsl,diff}.png`.

## What is known to differ

**`materials`, at 1.17, is the only preset above 0.75, and its cause is characterised.** Of its
seven material rows, metal, ceramic and plastic match exactly, and glass, glitter and liquid differ
only along silhouettes (0.12–0.15, sub-pixel edges). Frosted is the outlier at 0.64, and it is
entirely roughness-driven: the same row at roughness 0 measures 0.12. It scales smoothly with
roughness — 0.12, 0.31, 0.64, 1.04 at 0, 0.15, 0.42, 0.85 — with no jump at a mip boundary, which is
the signature of precision rather than a content mismatch. `envLod`, the smoothstep-warped equirect
sampler, `ENV_WIDTH`, `ENV_LEVELS` and the texel angle are identical on both sides, and the env mip
chain's blit parity works out even at every level. What is left is a half-float mip chain written by
hand and sampled at an explicit LOD, filtered slightly differently by the two backends.

### Coverage

The gallery does not exercise everything, and two real bugs were hiding in what it misses. Testing
the untested surfaces against a `staircase` baseline (0.17):

- **The finish pass.** `dither` was 54.10 — it built its block grid from `screenCoordinate` where
  every other pattern in the pass uses the corrected `fragCoord`, and because that coordinate also
  feeds `src`, each block took its colour from the opposite row of the frame. `halftone`,
  `halftoneCmyk`, `paperTexture` and `innerLight` were all at baseline.
- **`backgroundMode: "image"` was not implemented at all.** `bgHasImage` and `bgImageTexture` were
  declared and wired into the backdrop graph but never assigned; there was no loader. Now a twin of
  the reference's `syncBackgroundMedia`, video included.
- Radial, conic and mesh gradients are all at baseline, as is `transparentBackground`.
- **The mirror feature was broken**, at 1.96 for `mirrorV` and 1.11 for `mirrorH`. The reference
  applies the mirror to every post ramp — haze, vignette, caustic pool, grain — because they all
  read `vUv`. This engine's ramps read a screen coordinate that ignored it. The root cause was one
  uniform doing two jobs: `sourceFlip` is the scene mirror XORed with the storage inversion, which
  is exactly right for READS and cannot answer "where is this pixel on a mirrored screen". Split
  into `sceneMirror`, and both are now 0.16.
- **`quality` below 1 was a no-op**, at 2.06. The reference renders the scene and post at a
  quality-scaled resolution and resolves the finish pass at full device resolution — its patterns
  are authored in device pixels — using `uScale` to keep gather radii the same fraction of a smaller
  frame. This engine always rendered full-size, so the setting did nothing at all here: a
  performance knob that silently didn't work, which mattered more than the difference did. Now
  0.26 / 0.23 / 0.17 at quality 0.5 / 0.7 / 0.9. The `dprMax` ceiling was ignored on this path too,
  pinned at a hard 2.

That image bug nearly escaped: the media loads through a callback, and the harness captured
immediately, so BOTH engines rendered the fallback colour and agreed perfectly about a picture
neither of them drew. `--settle <ms>` exists for this. A test that passes because nothing happened
is worse than no test, and it looks exactly the same in a results table.

**"Post amplifies rather than causes" was wrong.** It was recorded here as a finding, and the
opposite turned out to be true: on `prism`, `cascade` and `skewer` the SCENE agreed almost exactly —
the colour target diffed 0.02 on `skewer` — and post was where the whole difference was made. The
misreading came from a broken baseline: the "post off" variant zeroed a `dof` key that does not
exist and left `caustics` and `haze` on, so toggling those changed nothing and every effect looked
innocent. Build the all-off baseline from the keys the config actually has, and confirm it lands
near zero before trusting anything measured against it.

**Orientation is the recurring bug, and it is invisible one blit at a time.** Every blit into a
render target on this backend stores its rows inverted relative to the uv it was drawn with. A
single blit hides this and two undo each other, so it only surfaces in a CHAIN — the bloom pyramid,
where the orientation alternated level by level (0 inverted, 1 upright, 2 inverted) and the
composite summed levels that disagreed, giving every halo a mirror image of itself across the middle
of the frame. Levels 0 and 2 matched dumped one way and level 1 matched dumped the other, which is
the signature to look for. Fixed with `blitUv` in `nodes/passes.ts`, as a UNIFORM rather than a
baked-in flip: the parity harness feeds these passes plain textures, and hard-coding the flip makes
53/53 parity a lie about a pass that is otherwise a faithful twin.

The same class of bug, twice more in one session: the backdrop reconstructed its plane uv from a
full-screen quad as `(uv - 0.5) * frame + 0.5`, which silently assumes the camera looks at the
plane's CENTRE — `camera.lookAt.y` is nonzero in most presets, so everything authored against the
plane landed shifted (138px on `skewer`). It now draws on the same real world-space plane the WebGL
engine does and takes the uv off the geometry, which cannot drift. And post's gathers added `+y`
offsets to a coordinate that is deliberately mirrored against the screen, so the caustic pool — a
one-sided gather — pooled light above the glass instead of below it.

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

**The tool lied twice, and both times it looked like an engine bug.** The probe index and the
target-dump name shared one global, so asking for the colour target ALSO substituted a material
intermediate into every shape's shader in the WebGL engine — which matches probes by index — while
the node engine, which matches by name, rendered normally. The result was a confident 34.70 on a
target that actually differs by 0.38. Dump-only names now leave the material index at zero. Then the
lamp-overlay taps were compared with an off-by-one probe index, so both taps returned the same
channel. Validate that a new probe distinguishes what it claims to before reading anything into it.

The pattern worth carrying: a difference in term X usually means an input to X is wrong upstream,
and the term that _looks_ responsible is the one amplifying rather than the one causing — except
when it is not, as post was here. Check resolution dependence before believing anything about
rasterisation, check that both sides are running the same function before theorising about why the
same function disagrees, and check the instrument before the subject.

## What has been ruled out

Each of these was compared directly and matches: the traced refraction path, the back-glass pass,
the plate depth guard, the traced and measured optical chord, the back-face depth, the refracted
screen-space offset, `clearGlass`, the absorption block, the reflection weight, the studio mode, and
both studio room functions (which are parity-clean). An **opaque** prism matches exactly, which rules
out the geometry and the room together. The camera, the mesh transforms and the projection are
byte-identical, and so — on a validated interior crop — is every material intermediate.

The wall's extent, the `frame`/`size` pair it derives from, and all eighteen wall uniforms match
exactly, so the wall difference is inside `wallShade` itself.

**The dust light-field tap was flipped, and it was my own fix that did it.** When the bloom
pyramid's orientation was corrected, the same v-flip was applied by symmetry to the two levels the
dust reads — on the reasoning that they are blit-written like everything else in that chain. They
are, but this pass is drawn with the SCENE, and the uv it is handed already runs the same way as
the stored rows. The flip lit every grain from the mirror image of the frame.

Three things let it through, and each is worth remembering:

- It was reasoned, not measured. The note attached to it said what it _should_ do.
- The reasoning included "no preset uses dust", generalised from checking three presets. `cascade`
  and `prism` both use it.
- It cost 1.4 in a LIVE frame and almost nothing through `captureImage`, so every static comparison
  here called it fine. `pnpm tsl:live` exists now because of it.

It was found by a person looking at the studio and saying the light seemed off. Removing it took
`prism` from 0.50 to 0.36 static and 1.76 to 0.37 live, and `cascade` from 0.72 to 0.59.

The bloom pyramid now matches level by level (0.18–0.21 at every level and at the composite), as do
the colour target's RGB (0.02 on `skewer`) and its alpha (0.00).

Post's gather counts came from `quality` in the reference and were HARD-CODED at 12 and 6 in this
engine against its 24 and 10, so every gather in the pass sampled a different set of points. That
alone was 1.0 of `skewer` through the caustic pool and 0.9 through depth of field; both fell to 0.03
and 0.02. Note `postPass` unrolls its loops in JavaScript, so these are build-time numbers and
`quality` has to stay in `setConfig`'s structural test.

The background VIDEO branch is verified: 0.18 against a 0.17 baseline, tested with a video whose
every frame is identical, so playback position cannot make the comparison non-deterministic. It
needs `--settle 3500`, not the 1200 the still image needs — the WebGL engine takes noticeably longer
to decode its first video frame, and at 1200 it renders the plane black while this engine has
already painted it. That read as a 50.77 failure in exactly the shape a real bug would.

**Motion is compared, and matches.** `--time <t>` captures both engines at an explicit scene time
through `captureImage`, which is deterministic — unlike `--loop`, which lets both run on the wall
clock and diffs whatever frames land. Every preset holds its t=0 figure across t = 1.3, 2.1, 3.7 and
5.5 (`skewer` 0.24/0.24/0.29, `cascade` 0.72→0.75, `prism` 0.50→0.53, `materials` 1.17→1.19). This
axis was worth covering on history alone: the two worst bugs of the porting effort, a double-rate
clock and bindings applied before motions, were both invisible at t=0.

One path remains UNVERIFIED. `coneRotation`'s pixel argument was corrected from `screenCoordinate`
to `gl_FragCoord`'s convention — the same mix-up that made `dither` 54 — but it measures identically
either way, because the only scenes that reach it are dominated by the roughness term above, and no
preset uses cone transmission. It is kept as the faithful mapping, not because it was shown to help.

**Interaction is compared, and matches.** `pnpm tsl:interaction` drives identical pointer events
into both engines and reads the state the bindings produce — beam incidence and entry, orbit yaw and
pitch, zoom, camera position — rather than pixels, because `captureImage` deliberately strips live
interaction state on both engines and so can never see it. Held pointer, sampled as a TRAJECTORY
rather than a snapshot: the state is continuously animated, so one reading compares two phases of an
ongoing curve. The two agree to 0.003, converging to 0.001.

It also drives the WHEEL and a right-button drag, and that is where it earned its keep: the
renderer's own orbit controls — drag to orbit, wheel to zoom — were never ported to this engine at
all. `yaw`, `pitch` and `distance` existed and `updateCamera` read all three, but nothing ever wrote
them, so every preset (all eight set `orbit`) was inert here while the WebGL engine orbited and
zoomed. Nothing caught it because every comparison in this directory moves a pointer and none of
them turned a wheel. Reported by a person using the studio, not by any harness.

It needs one thing that is itself the finding: the script waits for BOTH controllers to exist before
dispatching. The WebGL engine attaches its pointer listeners synchronously in its constructor, while
this one builds its controller after negotiating a WebGPU device — so a pointer already over the
canvas during startup is missed here and caught there. Narrow, and inherent to async device
initialisation, but real.

## Performance

`pnpm tsl:perf` times both engines on the same scenes in a real Chrome. It measures `captureImage`,
the only entry point on either engine that AWAITS a finished frame, and subtracts the same
measurement on an empty scene to remove the encoder. Not a frame-rate benchmark: nothing runs the
rAF loop, so nothing is vsync-limited.

At 900x540, after the change described below:

| preset    | webgl | webgpu | ratio | preset    | webgl | webgpu | ratio |
| --------- | ----: | -----: | ----: | --------- | ----: | -----: | ----: |
| cascade   |  27.0 |    4.0 | 0.15x | materials |  11.0 |    9.2 | 0.84x |
| assembly  |   9.9 |    7.0 | 0.71x | slimes    |   9.2 |    8.7 | 0.95x |
| staircase |   9.7 |    8.6 | 0.89x | skewer    |   9.0 |    9.2 | 1.02x |
|           |       |        |       | reactions |   7.4 |    8.3 | 1.12x |

`prism` is omitted deliberately: its scene term is two or three milliseconds, which is the
difference of two ~15ms measurements and inside run-to-run variance. It has produced both 0.15x and
1.71x on the same build, and neither means anything.

`cascade` is the one big win, and it is structural: it and `prism` are the only presets with a tone
map, and therefore the only ones with half-float targets, 4x MSAA, a pyramid bloom and dust. There
this engine is six times faster.

**Every pass used to be awaited, and that was most of a frame.** `renderAsync` has been deprecated
since three r181 in favour of `render()` plus a single `await renderer.init()`, which this engine
already does at construction — but it was still awaiting nineteen passes per frame. That cost about
10ms and did not vary with scene complexity, because it was never about the scene: the LDR presets
all sat at a flat ~10ms whatever was in them, which is what fixed overhead looks like in a table.
Issuing the passes instead moved them from 1.11-1.63x SLOWER than the WebGL engine to 0.71-1.12x,
with six of the seven measurable presets now at or below parity. Every preset's pixel output is
unchanged, and the deprecation is gone with it.

It also removes every suspension point from `draw`. The mutex that guards it is kept — see the note
on `drawing` — because `draw` still mutates state a partial run would corrupt, and one `await` put
back anywhere inside it restores the hazard.

Both floors are the PNG encoder at about 10ms, and the subtraction is what makes the numbers
readable — but it has to be a real floor. The first version zeroed `bloom` and left `bloomMode` and
dust alone, which does NOT retire the pyramid: the WebGL engine still builds it when the mode is
"pyramid" or any dust exists. That subtracted 16ms from one engine and 10ms from the other and
reported WebGPU as ELEVEN times faster on `cascade`. A floor that is not a floor produces a headline
rather than an error.

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
