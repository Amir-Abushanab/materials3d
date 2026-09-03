# Third-Party Notices: @materials3d/core

This package redistributes code derived from, or bundled from, third-party
open-source software.

## @paper-design/shaders

- Source: https://github.com/paper-design/shaders
- License: Apache License 2.0, full text in
  [`licenses/paper-design-shaders-Apache-2.0.txt`](./licenses/paper-design-shaders-Apache-2.0.txt)
- NOTICE (from the upstream `NOTICE` file):

  > Powered by Paper Shaders: https://shaders.paper.design

Two of the stylisation effects in the post pass (the `dither` and `halftone`
modes, compiled into `dist/` from `src/renderer/shaders.ts`) are derived from
the corresponding `@paper-design/shaders` fragment shaders (`image-dithering`
and `halftone-dots`). See the repository's root `THIRD-PARTY-NOTICES.md` for
the full description of the changes made in adapting them.

## three.js

- Source: https://github.com/mrdoob/three.js
- License: MIT, full text in [`licenses/three-MIT.txt`](./licenses/three-MIT.txt)

three is a peer dependency everywhere except the standalone build:
`dist/standalone/materials3d.standalone.js` is a single-file bundle that
includes a copy of three.js.

## vgpu (Vercel Labs)

- Source: https://github.com/vercel-labs/vgpu
- License: MIT, full text in [`licenses/vgpu-MIT.txt`](./licenses/vgpu-MIT.txt)
- Copyright (c) 2025 Vercel, Inc.

Derived from vgpu's `prism-background`, `environment-map` and bloom examples and its
`@vgpu/wgsl-std` package, compiled into `dist/` from `src/renderer/lightSheet.ts`,
`src/renderer/shaders.ts`, `src/renderer/nodes/*.ts` and `src/util/noise.ts`: the beam tracer's
Fresnel transmittance and spectral colorimetry, the sheet mesh topology and spectral density, the
neutral tone map, the prefiltered environment map, the paired bloom taps, and the simplex noise.
See the repository's root `THIRD-PARTY-NOTICES.md` for the full description of the changes made
in adapting them.
