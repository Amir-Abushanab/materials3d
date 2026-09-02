---
"@materials3d/core": minor
---

Remove the `cascade` preset.

It threaded one beam through three solids — a hexagon, a sphere and a triangular prism, each with
its own index — so the fan arriving at the second element had already begun to separate. Nothing
replaces it; `prism` remains the dispersion scene, and `orb` is the new addition in this release
for a different reason.

Two things went with it, and both are worth knowing:

- It was the only preset the WebGPU harnesses could address by name. `pnpm tsl:live cascade` no
  longer resolves, and `tsl:perf` — which enumerates `Object.keys(PRESETS)` — loses that row from
  the tables WEBGPU.md is built on.
- It was the only test of threading one beam through several solids. That behaviour has not gone
  anywhere: `traceSolids` still walks a scene in whatever order it meets it, and that same walk is
  what lets a beam re-enter a re-entrant outline. Its three-solid geometry moved into the test that
  needs it rather than being deleted alongside the scene.
