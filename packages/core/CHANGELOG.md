# @materials3d/core

## 0.3.0

### Minor Changes

- [#5](https://github.com/Amir-Abushanab/materials3d/pull/5) [`9308bca`](https://github.com/Amir-Abushanab/materials3d/commit/9308bcaa15ba1f907ddfe38cccae672b2eab8f64) Thanks [@Amir-Abushanab](https://github.com/Amir-Abushanab)! - **Breaking: the `orb` preset is gone**, replaced by `knot`. `PRESETS.orb` no longer exists and
  `preset="orb"` no longer resolves; use `knot`, or lift the old scene out of `gallery/orb.json` in
  an earlier tag and pass it as a config. The two are close relatives, `knot` was built on `orb`'s
  optics, which is most of the argument for the swap: the same numbers that lit a sphere light a
  loaded mesh unchanged.

  Add a `model` shape kind: point `shape.model` at a `.glb` and the renderer draws that mesh with
  the same materials, motions and post stack as the built-in primitives.

  The twelve primitives and `path` reach a lot of silhouettes, but not a shape with interior form
  that a designer built in Blender. This is the escape hatch for those, alongside `path`.

  - `.glb` only, read with a purpose-built parser rather than `GLTFLoader`: the glass shader uses
    `position` and `normal` and nothing else, so materials, textures, cameras, rigs and animation
    are all discarded, and the renderer chunk gains no dependency.
  - Node transforms are baked to world space, so a hierarchy arrives assembled rather than piled on
    the origin.
  - The mesh is centred and scaled until its longest half-extent is `r`, the same fit `path` gives
    a pasted SVG, so `r` resizes it whatever units it was authored in.
  - `material.path` is measured off the loaded geometry (half its shortest bounding-box extent),
    which reproduces the hand-written value for `rod`, `sphere`, `disc`, `ring`, `slab` and `prism`.
  - Quantized meshes (`KHR_mesh_quantization`) and sparse accessors are read, since neither needs a
    decoder and half-reading either gives a mesh that is wrong rather than one that is missing.
  - Compressed geometry (Draco, meshopt), external buffers and meshes over 250k triangles are
    refused by name instead of read as noise.
  - Loads asynchronously and rebuilds when the file lands, drawing a placeholder sphere meanwhile.
    `captureImage` waits for it, so a poster or a headless render is never a picture of the
    placeholder.

  A new `knot` preset draws a `.glb` in glass between a rod and a disc, all on one lamp field and
  one post stack. It carries its mesh inline (a 2016-triangle quantized trefoil, ~25 kB of base64)
  because a preset hands back a URL and nothing in this package can make one resolve in a consumer's
  app. That rides along with `@materials3d/core/presets` and the standalone build, not with the
  drop-in component, which does not import presets: about 8 kB gzip on the CDN bundle, and nothing
  at all for anyone using the React or element wrappers. It is meant to be the only preset that does
  this; a second one should link a hosted file, as `gallery/community/knot.json` does.

  **A `model` can stand in a traced beam.** `beam.targets` used to reach only the shapes whose
  cross-section is a parameter, a lathe's `r` and `sides` or a `path`'s drawn outline; a mesh has
  neither and was skipped in silence. It is now measured: the geometry is cut at the sheet's plane
  and the largest contour handed to the same tracer, so a `.glb` refracts and disperses light the way
  a `prism` item does. The same solid exported as a mesh and traced as a `model` reaches the polygon
  `crossSectionFor` derives analytically, which is the test that pins it.

  Cutting a mesh needs the item's whole pose, not the roll and centre a lathe needed, since the
  contour changes with the sheet's height and with every axis the item is turned about. Only the
  largest contour is traced: a plane through a pair of glasses returns the frame and both lens
  openings, and the tracer keeps a single inside, so aim through solid material.

  Materials Studio picks a `.glb` off disk, parsing it before it is applied so a bad file reports
  why rather than silently leaving a sphere. `pnpm make:glb` writes test meshes in the encodings no
  exporter hands you on request.

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
