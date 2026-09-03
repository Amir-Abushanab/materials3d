# @materials3d/core

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
