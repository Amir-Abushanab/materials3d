# Third-Party Notices

This project includes code derived from third-party open-source software.

## @paper-design/shaders

- Source: https://github.com/paper-design/shaders
- Homepage: https://shaders.paper.design
- License: Apache License 2.0 — full text in
  [`licenses/paper-design-shaders-Apache-2.0.txt`](./licenses/paper-design-shaders-Apache-2.0.txt)
- NOTICE (from the upstream `NOTICE` file):

  > Powered by Paper Shaders: https://shaders.paper.design

Two of the stylisation effects in the post pass
(`packages/core/src/renderer/shaders.ts`) are **derived from** the corresponding
`@paper-design/shaders` fragment shaders. Significant changes made in adapting
them: paper's shaders are standalone generative canvases sized by their own
world-space/fit machinery; here they are folded into the tail of Materials3D's
single composite post pass — they read the already-composited colour in
straight (un-premultiplied) form, and paper's sizing / fit / aspect UV plumbing
is removed or simplified.

Derived effects (see the per-effect header comments in that file for the exact
upstream source):

| Our effect | Upstream `@paper-design/shaders` |
| ---------- | -------------------------------- |
| `dither`   | `image-dithering`                |
| `halftone` | `halftone-dots`                  |

The remaining post effects are original to this project: `halftoneCmyk`,
`paperTexture` and `innerLight`. (Paper's `paper-texture` depends on a bundled
noise-texture asset for its fibre / crumple / fold noise, so it is not ported as
lean GLSL — the version here is original, in the spirit of it.)

## three.js

- Source: https://github.com/mrdoob/three.js
- License: MIT — full text in [`licenses/three-MIT.txt`](./licenses/three-MIT.txt)

three is a peer dependency of the published packages, but two built artifacts
bundle a copy of it: `@materials3d/core`'s standalone build
(`dist/standalone/materials3d.standalone.js`) and the deployed Materials Studio
site. Each published package carries these notices and license texts in its own
tarball.

## Inter

- Source: https://github.com/rsms/inter
- License: SIL Open Font License 1.1 — full text in
  [`licenses/inter-OFL-1.1.txt`](./licenses/inter-OFL-1.1.txt)
- Copyright 2016 The Inter Project Authors

The wordmark in `brand/logo.svg`, `brand/logo-dark.svg` and `brand/og.svg` is set in Inter
Display SemiBold 4.000 and converted to outlines, so those files contain path data derived from
Inter's glyph designs. No font file is redistributed and nothing in this repo loads Inter as a
webfont — the studio's UI uses the platform system stack.

## vgpu (Vercel Labs)

- Source: https://github.com/vercel-labs/vgpu
- Homepage: https://vgpu.sh
- License: MIT — full text in [`licenses/vgpu-MIT.txt`](./licenses/vgpu-MIT.txt)
- Copyright (c) 2025 Vercel, Inc.

The prism beam tracer (`packages/core/src/renderer/lightSheet.ts`) and the tone-mapping stage of
the post pass (`packages/core/src/renderer/shaders.ts`) are **derived from** vgpu's
`prism-background` example — specifically its `optics.ts`, `light-mesh.ts` and
`materials/shared/tone-mapping.wgsl`.

What was taken:

- **Fresnel transmittance.** The exact equations averaging both polarizations, accumulated at
  entry and exit and folded into vertex intensity.
- **Spectral colorimetry.** The Wyman/Sloan/Shirley (JCGT 2013) analytic fits to the CIE 1931
  colour matching functions, the D65 illuminant table, the shift-toward-neutral gamut mapping, the
  photopic weighting and the shared photographic shoulder.
- **Mesh topology.** Drawing the outgoing fan as a connected sheet spanning adjacent wavelengths
  rather than as independent per-wavelength ribbons, and the per-slice white input beam.
- **Spectral density.** Dividing flux by the angular-spread Jacobian between neighbouring
  wavelengths, and the topology-matching test that decides when two rays bound a drawable band.
- **`tonemapNeutral`.** The Khronos PBR neutral curve, ported from WGSL to GLSL.

Significant changes made in adapting them: vgpu's version is WGSL over a bespoke WebGPU pipeline
with its own HDR targets, bloom chain and baked studio environment; here the tracer is plain
TypeScript emitting a `THREE.BufferGeometry`, drawn as one additive pass inside Materials3D's
existing four-pass renderer, and the tone map is folded into the tail of the shared post pass
rather than being its own stage. The geometry is driven by Materials3D's `SceneConfig` rather than
vgpu's control objects, and the reference's camera orbit, dust, environment map and bloom pipeline
were not taken.

Also adapted from the same repository's example gallery: the prefiltered environment map
(`examples/environment-map` — equirectangular baking, the `1/sin(theta)` blur compensation and the
roughness-to-LOD mapping), and the bilinear-paired Gaussian taps from `bloom-blur-paired.wgsl`.

Also adapted: the simplex noise in `packages/core/src/util/noise.ts`, transcribed to TypeScript
from the same repository's `@vgpu/wgsl-std` package.
