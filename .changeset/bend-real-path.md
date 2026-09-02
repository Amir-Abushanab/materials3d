---
"@materials3d/core": minor
"materials-studio": minor
---

New `material.bend`: refraction along the REAL path, for shapes the prism tracer cannot take.

`lens` displaces the plate sample by the view-space NORMAL, weighted toward the rim. At the centre
of any convex shape the normal points at the camera, so that displacement is exactly zero there —
and the rim weight zeroes it again. That is right for a plate, whose middle should be a window, and
wrong for a ball, whose middle is the thickest part and therefore bends the most. A sphere on `lens`
alone renders a flat disc of clear glass where it should show what is behind it.

At 1, the view ray is refracted at the surface, walked the MEASURED thickness, and its exit point
projected — the construction the prism branch already used, with the back-depth pass standing in for
an analytic exit, so it works for any shape rather than only plane-bounded ones. Needs
`measuredThickness`. Defaults to 0, so every scene authored before it stays exactly as it was.

The offset alone was not enough, and finding out why took a probe rather than a guess. With the
`uProbe` guard readout, the orb's centre reported guard = 1.00 (passing), its own depth and the
plate's depth identical at 19.33, and an offset of exactly zero — so the fallback was not the depth
guard rejecting a sample, as it looked. The plate pass renders the whole frame INCLUDING the glass,
with glass falling back to the lamp field; a refracted ray near the centre of a convex solid lands
back inside that solid's own silhouette and samples its own flat plate pixel. Bending harder only
finds more flat colour.

So a material that bends samples a second plate rendered WITHOUT the glass in it. The trade is
explicit and is what `bend` means: a true optical path through the backdrop, in exchange for not
seeing the other glass along it. The extra draw is skipped entirely by any scene with no bending
material in it.

Also: a `bend` slider in the studio's material folder, and `window.m3d` gains `set()` — `patch`
refuses to create a missing path, which is right for catching a typo and wrong for adding to an
item's `material`, a sparse override set where absent means "take the default". `patch` and `set`
now also INFER whether a change needs geometry rebuilt rather than uniforms pushed, because the
caller cannot know which fields are baked and a silent no-op costs a round trip to notice.

Ported to the WebGPU/TSL engine, but NOT yet at parity. Both engines carry the same construction —
a second glass-free target, the refracted ray walked the measured thickness, the exit projected into
`screenUV`'s top-down convention — and `bend: 0` is byte-identical on both (`prism` renders to the
same 188685 bytes as before the port). At `bend: 1` they disagree: WebGL grades across the solid,
the node engine floods it. The remaining difference is in what the glass-free plate contains rather
than in the offset, since the hard core boundary does clear on both.
