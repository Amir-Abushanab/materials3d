---
"@materials3d/core": minor
"materials-studio": minor
---

New `orb` preset: one glass sphere over a mesh gradient, and the scene `material.bend` exists for.

A sphere is the shape that most exposes what `lens` cannot do. That term displaces the plate sample
by the view-space NORMAL, which at the centre of any convex solid points straight at the camera —
so the displacement there is exactly zero however far the knob is pushed. On a plate that is right,
because the middle should be a window. On a ball it renders a flat disc of clear glass with a hard
edge where the rim weighting takes over, sitting inside the shape like a sticker.

At `bend: 1` the body shades continuously from edge to edge and reads as solid glass. Setting
`bend` to 0 in the studio brings the disc back, and that comparison is the whole preset.

Two things about it are worth stating plainly, because both cost real time to learn:

- **It does not magnify.** The exit POINT is projected, not the refracted ray's eventual landing on
  the plate, so displacement is bounded by the solid's own size — the same approximation the prism
  tracer makes. Moving the plate further back does not turn this into a ball lens.
- **`clearGlass` is bright, and that is load-bearing.** Whatever the depth guard still rejects falls
  back to it; left dark it multiplies the interior down to nothing and the orb reads as a hole
  rather than as glass.

Renders at 0.16/255 whole-frame mean difference between the two engines, which is the same noise
floor every other preset sits at.
