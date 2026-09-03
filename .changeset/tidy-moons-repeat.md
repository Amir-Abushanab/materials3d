---
"@materials3d/core": minor
---

Stop defocused and silhouette edges from stairstepping.

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
