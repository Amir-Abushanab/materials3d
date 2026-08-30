---
"@materials3d/core": minor
---

A second engine, on three's node renderer and TSL, reached by `MaterialOptions.renderer: "webgpu"`.

**Opt-in, and code-split.** The two engines are separate three builds sharing only `three.core`, so
the default path is unchanged at roughly 733 KB while the node renderer's is nearer 1,028 KB. The
shell picks between two sibling dynamic imports and never folds them into one parameterized
`import(path)`, because a bundler can only split on a literal specifier — doing it the other way
pulls both engines into every build with nothing to indicate it.

`"webgpu"` selects the ENGINE, not the backend: three's node renderer falls back to a WebGL backend
on its own, so what opting in actually buys is TSL and whatever a WebGPU backend adds where the
browser has one. Headless Chromium has no `navigator.gpu` under any flag, which is why the WebGL
backend is the only one CI can exercise.

**`scripts/tsl-parity.mjs` is the reason this is a parallel migration rather than a replacement.**
Every ported pass has a GLSL twin, and the harness renders both on identical input and diffs the
whole frame. Forty-three cases, all matching — most bit-identical, the rest within one level of
8-bit quantisation. It exits non-zero on any mismatch.

Ported and under test: the colour transfer functions and both tone maps, the studio room in both
forms, value noise and the slope limiter; the whole bloom chain (extract, downsample, paired blur,
composite, particle field, blit); the post pass with its depth-of-field gather, occlusion guard,
saturation-weighted bloom, caustic pool, haze, vignette and tone map; the lamp plate, the prism
plane walk, the back-glass total-internal-reflection walk, depth encoding and dielectric Fresnel;
the microfacet layer (GGX, correlated Smith, F82, thin film, the Zirr–Kaplanyan glint field); the
three opaque families; the transmissive cone with its spectral weighting and hue rotation; and the
beam and dust materials.

Six things the harness and the engine smoke test caught that reading the code would not have:

- **A node's assignment is emitted where it is FIRST BUILT, not where the JavaScript reads.**
  Building follows a walk of the returned graph, so a value first reached through the argument of
  something containing a `Loop` lands inside that loop body — and every later use reads whatever
  the last iteration left, or nothing when the bound is zero. That put `view` inside the prism's
  plane walk: on a shape with no planes the loop never ran, `view` stayed zero, and every Fresnel
  term collapsed to grazing incidence. `.toVar()` pins it to the enclosing scope.
- **An `If` callback with a concise body silently loses its assignment.** `() => x.assign(y)`
  returns a node, so TSL reads the branch as having a return value and emits `return <value>;`
  inside inlined code — then, finding no function to return from, comments the line out and reports
  the node's generated code as empty. A block body returns undefined and none of it happens.

- **`select` takes the condition FIRST.** Written the other way round it passes a colour as the
  predicate, which compiles, renders, and is wrong in every branch. It was wrong in five places
  across three files, and the post pass rendered pure black.
- **Fluent `mix` argument order is not obviously `(a, b, t)`.** Using it swapped the near and far
  bloom scales — a 34/255 error that produced a perfectly plausible picture.
- **`Fn` cannot take a plain JavaScript object.** The opaque shader was written to take its uniforms
  as an argument; it compiled and rendered nothing. Passes are factories over their uniforms now.
- **The node renderer applies output colour management a raw `ShaderMaterial` does not.** Left at
  defaults, a pass that does nothing but copy a ramp differed by 74/255.

Two conventions in `renderer/nodes/` are load-bearing. TSL is imported from `three/webgpu`, never
`three/tsl` — they are separate module instances with separate node registries, and mixing them
fails a weak-map lookup at draw time with an error that names nothing. And the combinators go
through thin wrappers with their argument order pinned, because passing a relaxed node to three's
typed overloads makes resolution pick the first candidate rather than infer: a vec3 silently
resolves as a vec2 and the error surfaces at an unrelated `.z` several lines later.

**Wired into the render loop**: the four passes in order — back-face depth, plate, main and post —
with the bloom pyramid between the last two, plus the light sheet, the traced prism interior and the
back-glass total-internal-reflection pass. The prism preset renders its dispersed fan through the
node engine. Three things there are worth knowing:

- The plate carries linear depth in ALPHA and coverage only on the main pass, because the main pass
  validates its refracted samples against it. A plate that writes a flat one reports every shape at
  the far plane and the guard passes on samples it should reject.
- `renderBackGlass` turns `autoClear` off for its draws. Every `renderAsync` clears its target
  first, so a pass meant to ADD to the plate erases it instead — visible as a frame that gets
  DARKER when a light-adding pass is switched on.
- The dev probes in the item material are substituted on the main pass only and carry the plate's
  own alpha. The plate is drawn by that same material, so a probe returning unconditionally
  rewrites the plate the main pass then samples, and every reading taken through it describes a
  frame that does not exist. That cost a dozen measurements before it was spotted.

**The port is complete.** Every GLSL shader has a node twin that the engine actually calls: the
four scene passes, both depth passes, the bloom pyramid, post, the environment bake and its
sin(theta)-compensated blur, all four backdrop branches including the lit wall with its contact
shadows, the beam, the caustic, the dust field with its index-derived vertex stage, the back-glass
walk, and the finish pass. The imperative API is implemented too, against the same
renderer-agnostic helpers the WebGL engine uses — so `core-loader-webgpu`'s assertion no longer
hides a missing method, only the fact that the two classes share no nominal base type.

**How close the two engines are**, measured by `scripts/tsl-compare.mjs` as mean absolute
difference over the whole frame, out of 255:

    assembly 1.1   reactions 1.4   materials 2.1   slimes 7.7
    skewer  10.4   staircase 11.2  cascade  16.4   prism   29.9

On `assembly` and `reactions` fewer than 5% of pixels differ by more than one 8-bit level. The two
dark scenes are the outliers, and their gap is dominated by a low-level glow the WebGL engine has
across the whole frame which this one does not — not bloom, haze or the backdrop, all of which have
been ruled out by measurement, and not yet explained.

**Every defect this port surfaced was found by measuring, not by reading.** The list is worth
keeping because the same shapes will recur:

- A double output encode. The post pass already ends in the display transfer, and three's output
  colour management ran on top: a mid grey left the shader at 0.5 and reached the canvas at 188.
- Shapes missing from the plate entirely — the item materials sampled the target they were being
  drawn into, so the driver dropped the draw.
- A vertical flip on every plate and depth read, which made each shape refract a mirrored copy of
  the frame. Invisible on a tall rod, worth 28 levels on `staircase`.
- A parity case whose GLSL reference had been written from the port rather than transcribed from
  `shaders.ts`, so it compared the port against itself and passed while the two engines computed
  different functions.
- Coordinate conventions, repeatedly: `screenUV` counts down where `gl_FragCoord` counts up, a
  source lookup needs a target flip where a screen position must not, and GLSL's `mat2` is
  column-major.

**And the instrumentation was wrong more often than the renderer.** Probe scales that silently
saturated, an sRGB decode applied to raw bytes, probes read through a post pass that smears them,
and a mask that counted backdrop pixels as geometry and produced a confident, entirely false
"13.3% of back faces are missing". `scripts/tsl-compare.mjs` carries `--at` for raw pixel readout
and states in a comment that its values are `byte/255`.
