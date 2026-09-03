# @materials3d/core

## 0.2.0

### Minor Changes

- [#1](https://github.com/Amir-Abushanab/materials3d/pull/1) [`82ba9e9`](https://github.com/Amir-Abushanab/materials3d/commit/82ba9e9b80098a0366786077c0ea427b8c549ee3) Thanks [@Amir-Abushanab](https://github.com/Amir-Abushanab)! - Stop defocused and silhouette edges from stairstepping.

  Three separate causes, none of which the others fix:

  **The main pass was never antialiased.** `antialias: true` on the WebGLRenderer only ever applied
  to the default framebuffer, and the scene never draws there — every pass lands in a render target,
  and a target gets no multisampling unless it asks. Only the HDR targets did, added for the beam, so
  every byte-path scene, which is every preset that does not tone map, drew its shapes with no
  antialiasing at all. `colorRT` now asks for four samples on both paths. `bgRT` and `plainRT`
  deliberately still do not: the plate stores a linear depth in its alpha that the main pass rejects
  samples against, and an MSAA resolve would average that across a silhouette into a depth belonging
  to neither side.

  **The depth-of-field blur radius aliased, and multisampling the colour cannot reach that.** The
  depth target is packed into two channels and sampled NEAREST, because interpolating the low byte of
  two depths decodes to a distance that is in neither — so the radius derived from it stepped binary
  across a silhouette. One pixel inside a shape the gather reached across many pixels; one pixel
  outside it reached across none, the depth pass having cleared to the focal depth. Both engines now
  pre-filter the radius over a 3x3, averaging the RADII rather than the packed depths, so each tap
  still decodes a valid depth of its own.

  **`quality` can now go above 1, up to 2, and supersamples when it does.** The scene passes render
  larger than the canvas and the post pass resolves them back down. It is the one setting that
  antialiases everything at once, the depth included, so it is the answer to a defocused edge that
  still reads as a staircase after the two fixes above. Costs the square — 1.5 is a bit over twice
  the fragment work of 1 — and is worth it for a small canvas at a high display density. The default
  is unchanged at 1, so no existing scene renders differently for this.

  Still outstanding: a defocused shape does not bleed OUTWARD past its own silhouette, because a pure
  gather has no way to express that — the sharp background beside it has no circle of confusion of its
  own, so it never reaches in. That wants a scatter-as-gather with an energy-normalised weight, which
  redistributes light and would re-calibrate every preset. Dilating the radius without that
  normalisation was tried and looks far worse than the staircase did.

## 0.1.0

### Minor Changes

- Initial release: scene-level materials for the web.
- A four-pass renderer (depth, plate, main, post) in which colour comes from a bounded field of
  lamps behind the glass. Glass refracts other glass through a shared plate pass with
  depth-validated sampling.
- Shapes: `rod`, `disc`, `prism`, `hex`, `cone`, `sphere`, `ring`, `droplet`, `blob`, `slab`,
  `arrow`, `extrude`, and `path`, which extrudes an SVG outline (a whole `.svg` file is accepted;
  the first subpath is the outline and later ones are holes). Flat-profile shapes take through
  `cuts`.
- Materials: `path`, `density`, `tint`, `ior`, `dispersion`, `lens`, `bend`, `magnify`, `rim`,
  `specular`, `saturation`, `emission`, `hueShift`; kinds `glass`, `frosted`, `glitter`, `liquid`,
  `metal`, `ceramic`, `plastic`; `measuredThickness` and `tracedRefraction` for faceted solids.
- `beam`: a traced spectral light beam through the scene's solids, with a caustic wash on the wall
  backdrop, tone mapping and HDR targets.
- Backdrops: colour, gradients (linear, radial, conic, mesh), image or video, a shaded wall with
  contact shadows, and `background: "transparent"`.
- Environment: analytic studio lighting or a prefiltered baked map (`environment: "baked"`).
- Post: depth of field, saturation-weighted or pyramid bloom, caustics, haze, vignette, grain,
  dust, tone mapping, mirror, and the finish effects `dither`, `halftone`, `halftoneCmyk`,
  `paperTexture`, `innerLight`.
- Interaction bindings from normalized inputs (`scroll`, `hover`, `hoverSelf`, `pointerX`,
  `pointerY`, `pointerSpeed`, `press`, `pressSelf`, `scrollVelocity`, `appear`, `custom:*`) to
  scene, shape and lamp targets. Touch is opt-in. Captures render the rest state.
- Motion per shape (`skewer`, `spin`, `drift`, `wobble`) with `phase`; `scatter` generates a row
  deterministically from a seed.
- Presets: `skewer`, `assembly`, `staircase`, `slimes`, `reactions`, `materials`, `prism`, `orb`.
- `createMaterials`: a poster-first shell with no static three import. It upgrades to WebGL when
  the container nears the viewport and falls back to the poster on no WebGL, Save-Data, reduced
  motion, small viewports, repeated context loss or a failed engine fetch.
- Deterministic capture: `seek`, `captureImage`, `snapshot({ time })`. Editor primitives: `pick`,
  `projectBounds`, `pointOnDragPlane`, `bakeScatter`, `rebuild`.
- An experimental WebGPU/TSL engine behind `renderer: "webgpu"`, reachable as
  `@materials3d/core/renderer-webgpu`. WebGL remains the reference; see WEBGPU.md.
- `@materials3d/core/studio`: offscreen thumbnail helpers.
