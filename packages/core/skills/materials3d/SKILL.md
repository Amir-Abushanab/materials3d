---
name: materials3d
description: >
  Add a scene of rendered materials (glass, frosted, glitter, liquid, metal, ceramic, plastic
  shapes lit by soft lamps behind them, with optional traced light beams) to a website as a
  drop-in component on three.js. Load this when a user wants a @materials3d package:
  @materials3d/react (<Materials3D>), @materials3d/element (<materials-3d>) or @materials3d/core
  (createMaterials / mountMaterials); or asks for a refractive-glass hero background, a
  poster-first lazy WebGL scene, a CDN <script> scene, a prism beam, or how to reproduce a scene
  exported from Materials Studio.
metadata:
  type: core
  library: "@materials3d/core"
  library_version: "0.4.0"
sources:
  - "Amir-Abushanab/materials3d:README.md"
  - "Amir-Abushanab/materials3d:packages/core/README.md"
  - "Amir-Abushanab/materials3d:packages/react/README.md"
  - "Amir-Abushanab/materials3d:packages/element/README.md"
  - "Amir-Abushanab/materials3d:packages/core/src/config/model.ts"
  - "Amir-Abushanab/materials3d:packages/core/src/shell/createMaterials.ts"
  - "Amir-Abushanab/materials3d:packages/core/src/presets.ts"
---

# @materials3d: drop-in scenes of lit materials

A four-pass three.js renderer for hero sections and product visuals. Shapes take their colour
from a bounded field of lamps behind them; glass refracts the scene behind it, and a prism can
split a traced beam. Every entry shows a poster first and upgrades to WebGL only when the
container nears the viewport and the browser can run it, with three code-split out of the initial
load. Framework-agnostic core, with React and custom-element adapters.

## When to use

- A hero, background or product visual built from glass, metal, ceramic, plastic or liquid shapes.
- Reproducing a scene designed in Materials Studio (paste its Get code snippet or config JSON).
- A WebGL scene that behaves: lazy, poster fallback, reduced-motion and Save-Data aware.

## Install

```sh
pnpm add @materials3d/react three     # React
pnpm add @materials3d/element three   # <materials-3d> for Vue, Svelte, plain HTML
pnpm add @materials3d/core three      # framework-agnostic createMaterials
```

`three` is a peer dependency (`>=0.180 <1`). Add `@types/three` for TypeScript. Everything is
ESM-only.

## Choosing an entry

| Need                                 | Use                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------ |
| React                                | `import { Materials3D } from "@materials3d/react"`                       |
| Vue, Svelte, plain HTML              | `import "@materials3d/element"` then `<materials-3d>`                    |
| Framework-agnostic, own DOM          | `import { createMaterials } from "@materials3d/core"` (the poster shell) |
| Direct renderer, no shell or poster  | `import { MaterialRenderer } from "@materials3d/core/renderer"`          |
| One `<script>` from a CDN (three in) | `import { mountMaterials } from ".../@materials3d/core/standalone"`      |
| Built-in presets                     | `import { PRESETS } from "@materials3d/core/presets"`                    |
| Experimental WebGPU/TSL engine       | `createMaterials(el, config, { renderer: "webgpu" })`                    |

The `.` entry has no static three import; the engine arrives through a dynamic import, so a
bundler keeps three out of the initial chunk until a scene upgrades.

## Quick starts

React:

```tsx
import { Materials3D } from "@materials3d/react";

<Materials3D preset="skewer" poster="/hero.webp" style={{ width: "100%", height: "100vh" }} />;
```

Custom element:

```html
<script type="module">
  import "@materials3d/element";
</script>
<materials-3d preset="skewer" poster="/hero.webp" style="display:block;height:100vh"></materials-3d>
```

Core:

```ts
import { createMaterials } from "@materials3d/core";

const handle = createMaterials(
  document.getElementById("hero")!,
  { lampGain: 2 },
  { poster: "/hero.webp" },
);
// handle: { state, renderer, snapshot({ time }), set(partial), play(), pause(), destroy() }
```

Presets: `skewer`, `assembly`, `staircase`, `slimes`, `reactions`, `materials`, `prism`, `aperture`,
`knot` (a `.glb` in glass; carries its mesh inline, so it needs no hosting). In
React a string preset lazy-loads the presets chunk; a function (`preset={() => PRESETS.knot()}`) is
tree-shakeable. Core and element: `createMaterials(el, PRESETS.knot())`, `<materials-3d preset="knot">`.

## Config model

One JSON object, `SceneConfig`, drives the renderer, the studio and every export. Omitted fields
fall back to `createDefaultConfig()`; `ensureSceneConfig(partial)` fills and clamps one.

- Light: `lamps` (up to 12: `x`, `y`, `r`, `color`, `intensity`, in plate space 0 to 1),
  `lampGain`, `lampGate: { lo, hi }` (the smoothstep that cuts the Gaussian tails to clear),
  `backdropLamps`, `clearGlass` (what glass shows where no lamp sits behind it), and `plate`
  (`z`, `scale`, `offset`: the plane the lamp field lives on; `z` near -3 reads as one continuous
  field, far back as banding).
- Backdrop: `background` (hex), `backgroundMode` (`color`, `gradient`, `image`, `wall`),
  gradient fields (`backgroundPalette`, `backgroundGradientType`: `linear`, `radial`, `conic`,
  `mesh`), `backgroundImageUrl` or `backgroundVideoUrl` with `backgroundImageFit`, and
  `transparentBackground: true` (or `background: "transparent"`) to composite over the page.
- Shapes: `items[]` of `{ shape, position, rotation, scale, material, motion, phase, interaction }`.
  Shape kinds: `rod`, `disc`, `prism`, `hex`, `cone`, `sphere`, `ring`, `arrow`, `droplet`,
  `blob`, `slab`, `path` (an SVG outline or whole `.svg`, extruded), `model` (a `.glb` named in
  `shape.model`, as a URL or `data:` URI; fitted so its longest half-extent is `r`). Flat-profile shapes take
  through `cuts` (`rect`, `circle`). Or `scatter` (`count`, `seed`, `shape`, `material`,
  `motion`, `stagger`, `spanX`, `spread`, ...) generates a row deterministically instead of `items`.
- Material (all optional): `kind` (`glass`, `frosted`, `glitter`, `liquid`, `metal`, `ceramic`,
  `plastic`), `path` (half the optical path, derived from the shape unless set), `density`,
  `absorption`, `tint`, `ior`, `dispersion`, `lens`, `bend`, `magnify`, `rim`, `specular`,
  `saturation`, `hueShift`, `emission`, `roughness`, `iridescence`, `filmNm`, `ripple`, `flow`,
  `sparkle`, `albedo`, `edgeTint`.
- Motion, per shape: `motion: { kind, axis, rate, amount }` with `none`, `skewer`, `spin`,
  `drift`, `wobble`, plus `phase`. Scene `loopSeconds` snaps every rate to whole cycles so a
  recorded clip loops.
- Camera and post: `camera` (`fov`, `distance`, `lookAt`, `height`, `roll`, `fit`), `orbit` (drag
  to orbit, wheel to zoom), `post` (`focus`, `range`, `aperture`, `bloom`, `bloomMode` of `gather`
  or `pyramid`, `caustics`, `haze`, `vignette`, `grain`, `toneMap` of `none`, `neutral` or `aces`,
  `dither`, `halftone`, `halftoneCmyk`, `paperTexture`, `innerLight`), `mirrorH`, `mirrorV`, `dust`.
- Optics: `measuredThickness` (a back-face depth pass), `tracedRefraction` (exact paths through
  faceted solids), `transmission` (`simple` | `cone`), `environment` (`analytic` | `baked`),
  `studio` (`gradient` | `softbox`), `beam` (a traced spectral beam through the scene's solids:
  `targets`, `incidence`, `entryAngle`, `ior`, `dispersion`, `revealSeconds`, ...). A `beam.targets`
  entry can name a `model`: the mesh is cut at `beam.z` and the largest contour is traced, so aim
  through solid material rather than through an opening the slice also found.
- Budget: `quality` (0.35 to 1 scales the scene passes), `dprMax`, `paused`, `timeOffset`.

React flat props map onto the scene: `lamps`, `lampGain`, `background`, `transparentBackground`,
`clearGlass`, `post`, `motion` (applied to every shape), `scatter` (merged onto the preset's),
`orbit`, `quality`, `dprMax`, `paused`. Precedence: default, then `preset`, then flat props, then
`config`. `handle.set(partial)` and the element's `config` merge one level deep, so
`set({ post: { bloom: 0.2 } })` keeps the other post fields; arrays such as `lamps` and `items`
replace whole.

## Interaction (optional, off by default)

Bindings map a normalised 0 to 1 input onto a parameter and write uniforms, never the config:
`value = mix(from ?? authored, to, smoothedSource)`. Sources: `scroll`, `hover`, `hoverSelf` (the
cursor over this shape), `pointerX`, `pointerY`, `pointerSpeed`, `press`, `pressSelf`,
`scrollVelocity`, `appear` (a one-shot entrance latch), `tiltX` / `tiltY` (device tilt, see below),
`custom:<name>` fed by `renderer.setInteractionInput(name, value)`.

- Scene bindings in `interaction.bindings`: `timeOffset`, `cameraZoom`, `lampGain`, `aperture`,
  `bloom`, `haze`, `beamIncidence`, and more.
- Shape bindings in `items[i].interaction.bindings` (or `scatter.interaction` for every generated
  shape): the optics (`density`, `ior`, `dispersion`, `lens`, `rim`, `specular`, ...), `hueShift`,
  `positionX`, `positionY`.
- Lamp bindings in `lamps[i].bindings`: `x`, `y`, `radius`, `intensity`. A lamp that follows the
  cursor behind the glass is the natural hero interaction:

```ts
lamps: [{ x: 0.35, y: 0.4, r: 0.2, color: "#f0803a", intensity: 1,
  bindings: [
    { source: "pointerX", target: "x", from: 0.1, to: 0.9 },
    { source: "pointerY", target: "y", from: 0.1, to: 0.9 },
  ] }],
```

Touch is ignored unless `interaction: { touch: true }`. Reduced motion, pauses and captures settle
to the authored rest state, so exports stay deterministic.

### Tilt (the input a phone has and a desktop doesn't)

`tiltX` / `tiltY` read the device's orientation sensor, normalized 0..1 the way a ball would roll on
the screen (`tiltX` → 1 as the right edge drops, `tiltY` → 1 as the bottom edge drops) and resting at
0.5 in whatever pose the reader was already holding — the first reading becomes the neutral centre,
so a phone held at the usual 50° doesn't peg every binding at one end. On these materials it is the
most literal reading of the surface: tilt the device and the highlight travels across the glass the
way it would on a real object in your hand.

Binding either source arms the sensor; a scene that mentions neither attaches no `deviceorientation`
listener. `interaction.tilt` is optional tuning on top: `range` (degrees to the 0/1 ends, default
25), `smoothing` (default 0.18), `invertX` / `invertY`, and `pointer: true` — which lets tilt drive
the shared CURSOR, so the lamp-follows-the-cursor scene above works on a phone with no second set of
bindings (a real finger always wins; `hoverSelf` / `pressSelf` still need a real pointer).

**iOS gets no tilt, on purpose.** Safari gates the sensor behind a modal permission dialog, and
nothing in this library opens one — a tilt-bound scene on an iPhone reads 0.5 on both axes and looks
exactly like a scene with no tilt. Treat tilt as an enhancement some phones don't get, the way you
would a hover state; don't build a fallback for it and don't build a permission button for it.

If a page genuinely warrants asking — an interactive piece a reader came to play with, not a
background — `enableTilt()` on the renderer / handle / element is the explicit opt-in. Call it from
a tap handler, directly, without awaiting anything first or the gesture is spent. `tiltStatus()`
reports `"unsupported"` (no sensor), `"prompt"` (gated, inert unless you ask), `"denied"`,
`"listening"` or `"live"`. Everywhere but iOS tilt is live as soon as it is bound and `enableTilt()`
is a no-op that resolves true. `recenterTilt()` re-takes the neutral pose after a change of grip.

## Poster and fallback

- `poster` (URL or data URI), or for SSR an `<img data-materials3d-poster>` inside the container,
  which the shell adopts with no hydration flash and puts back on unmount (React: pass it as a
  child). `posterFit`: `fill` (default, matches the canvas), `cover`, `contain`.
- Make a poster with `handle.snapshot({ time: 0 })` once running, `renderer.captureImage()` from
  `onReady`, or the studio's Save still. Same config and same `time` always give the same pixels.
- Fallback stays on the poster permanently: `onFallback(reason)` with `no-webgl`,
  `reduced-motion` (with `reducedMotionBehavior: "poster"`), `save-data`, `small-viewport` (below
  `minSizeForWebGL`), `context-lost` (twice), `load-error`. `onStateChange`: `poster`, `loading`,
  `running`, `fallback`.
- Shell options: `lazy` (default true, IntersectionObserver with `rootMargin` 200px), `webgl`
  (`auto` | `force` | `off`), `respectReducedMotion`, `reducedMotionBehavior` (`static` |
  `poster`), `respectSaveData`, `minSizeForWebGL`, `fadeMs`, `paused`, `renderer`. In React and the
  element these are read at mount only.

Element specifics: attributes `preset`, `src` (a config JSON URL), `config` (inline JSON),
`transparent`, `paused`, `poster`, `poster-fit`, `lazy`, `webgl`, `min-size`, `renderer`; a
`config` property; a read-only `handle`; events `materials3d-ready` and `materials3d-fallback`.

## Performance

- Four passes per frame (depth, plate, main, post), so a phone at high DPR pays about four times
  a single-pass renderer. Ship a poster and set `minSizeForWebGL` (520 is a good hero value).
- `quality` below 1 renders the scene passes smaller; `dprMax` caps device pixels (default 2).
- Changing `items`, `scatter`, `quality`, or the tone map rebuilds; everything else pushes
  uniforms. Every post effect left at 0 costs nothing.
- The renderer pauses offscreen and in hidden tabs.

## SSR and Next.js

`@materials3d/react` carries `"use client"`. All packages import safely under Node (the element's
registration is guarded), so RSC and SSR imports do not throw; the canvas mounts client-side.
Render the container with an `<img data-materials3d-poster>` child on the server for a zero-flash
poster.

## Pitfalls

- `three` is a peer: install it (`>=0.180 <1`), plus `@types/three` for TypeScript.
- The container needs a size; the scene fills it. Give it a height or an `aspect-ratio`.
- Colours are hex strings in display space. Do not hand a `THREE.Color` to a uniform; it is
  linear and reads washed out.
- `material.path` is half the optical path (a rod's radius, half a disc's thickness), not a size.
  Leave it unset to derive it from the shape; for `model` it is measured off the loaded mesh.
- `model` is `.glb` only, geometry only. A `.gltf` (which names sibling `.bin` files) and the
  compressed forms (Draco, meshopt) are refused with a message, not half-read; quantized meshes
  and sparse accessors load fine. Its materials, textures, rigs and animation are ignored: the look
  comes from `material`, the movement from `motion`. Cap is 250k triangles, since every shape is
  drawn four times a frame.
- A transparent background does not refract the page: the gaps go transparent and the glass still
  bends the lamp field. Set `clearGlass` to suit the surface behind it.
- Up to 12 lamps. Motion belongs to shapes, not the scene; spread `phase` across a full turn or the
  wave's trough sits still.
- Do not recreate per render in React: changed props update the live scene; only a remount or
  `destroy()` tears it down. StrictMode's double mount is safe.
- Reduced motion defaults to a static frame; `reducedMotionBehavior: "poster"` shows the poster.
- `renderer: "webgpu"` is experimental and not pixel-equal to WebGL, which is the reference.
