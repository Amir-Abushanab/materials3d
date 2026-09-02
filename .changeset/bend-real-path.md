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

Ported to the WebGPU/TSL engine, and PARTLY at parity. Measured whole-frame against WebGL on a
glass sphere, mean absolute difference out of 255:

    bend 0    0.16     bend 1   12.30

So a scene that does not bend is unaffected — the shipped presets render byte-identically on the
node engine, `prism` to the same 188685 bytes as before the port — and a scene that does bend still
differs between the engines.

One lead, recorded because it is counter-intuitive. Writing the blend in the GLSL engine's order —
the bent plate into clear glass first, the ordinary plate on top with its weight scaled by the bend
— takes `bend 1` to 0.10, i.e. parity. It also regresses `bend 0` to 11.31 and moves the shipped
presets (`prism` 188685 to 165814 bytes, lit 100% to 95.6%), even though at `bend 0` the two forms
are algebraically identical and `u.bend` probes as exactly zero. TSL is therefore not evaluating
that expression as written, and that is the thread to pull rather than the blend maths.
