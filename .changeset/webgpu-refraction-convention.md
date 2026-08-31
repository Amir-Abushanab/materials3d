---
"@materials3d/core": patch
---

Fix the refraction offset's vertical convention, and port the liquid ripple.

**The plate sample was displaced the wrong way up the frame.** `screenUV` is top-down — three
builds it from a fragment coordinate it flips "to follow WebGPU standards" — while the lens offset
comes from a view-space normal and the traced offset from `ndc * 0.5 + 0.5`, both of which are
y-UP. The GLSL engine never has to think about this because its `suv` is y-up too, so both of its
terms already agree.

The symptom was not a mirrored image, which is what made it hard to read. A sample sent the wrong
way lands on nearer geometry, the depth guard correctly rejects it, and the fragment falls back to
clear glass — so a coordinate-convention bug surfaced as bright chevrons down every rod and looked
for a long time like the guard's 0.30 tolerance being too tight. Widening the tolerance did remove
them, which is exactly why it would have been the wrong fix: it would have papered over a wrong
sample position by accepting it. On the affected rod the guard went from rejecting in triangular
bands (29.4 mean|d| against the reference) to 3.5.

**The liquid ripple had no node counterpart at all**, so `slimes` rendered a flat surface and a
binding targeting `ripple` wrote to an inert cell. Ported as `rippleNormal` — four travelling waves
at incommensurate frequencies, with the flow rate snapped to whole cycles over the loop so a
recorded clip still closes on itself.

Whole-frame difference against the WebGL engine, before → after: reactions 1.40 → 0.49, materials
2.08 → 1.57, slimes 7.70 → 2.73, skewer 10.35 → 8.02, cascade 13.69 → 12.41, prism 20.09 → 19.41.
