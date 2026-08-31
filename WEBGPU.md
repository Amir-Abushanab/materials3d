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

### A caution about the probes

`--probe <name>` substitutes an intermediate into the material in both engines. It is the main
diagnostic tool here and it is easy to misread:

- Probe values pass through the **whole post chain**, so they are neither linear nor isolated.
  Three different probes have been observed reading identically at the same pixel.
- A probe delta carries a constant level shift, which reads convincingly as a geometric offset. A
  "constant world-position offset between the engines" was chased for a while on this basis and was
  an artifact of the probe path.
- Frame means are swamped when the shape covers little of the frame.

What works: crop to the shape (`--crop`), turn post off in the config (`toneMap: "none"` and the
post amounts to 0), and **corroborate anything important with a config A/B rather than a probe**.
Every finding on this page rests on an A/B; none rests on a probe delta.

Not every probe exists on both sides — `GLSL_PROBES` in `scripts/tsl-compare.mjs` is the list, and a
name missing from it silently falls through to a normal render on the GLSL side, which looks like a
huge difference rather than like a missing probe.
