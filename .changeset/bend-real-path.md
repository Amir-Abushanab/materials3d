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

Ported to the node engine, at parity. Whole-frame mean absolute difference against WebGL on a glass
sphere, out of 255: `bend 0` 0.16, `bend 1` 0.10 — both at the noise floor, and the shipped presets
render byte-identically (`prism` to the same 188685 bytes as before the port).

Getting there turned up a real bug in this port, and it was mine rather than TSL's. Node uniforms
are uniquified by the TEXTURE they reference, so `plateSampler()` and `plainSampler()` both calling
`TSL.texture()` against the same 1x1 stand-in collapsed into ONE `uniform sampler2D` in the
generated shader — read at two different uvs, with the two bind calls then overwriting each other.
Whichever bound last won, so the plate and the glass-free plate silently swapped depending on which
one the graph happened to reference first.

It surfaced as an algebraically impossible result: reordering two `mix` calls that provably reduce
to the same expression when the bend term is zero moved the frame and turned 4% of pixels black.
Five API-level probes each ruled something out and none of them found it — `u.bend` renders as pure
black, `weight` is non-zero, and `mix(red, plain, t)` renders the solid red that proves
`mix(a, b, 0) == a`. Dumping the emitted GLSL found it in one diff: one `nodeUniform26` where there
should have been two. The plain sampler now has its own stand-in texture.

Worth knowing separately: the headless harness reports its backend as **webgl2**, so these runs
exercise TSL compiled to GLSL rather than WGSL. The node graph is still what is under test, but
"the WebGPU engine" is not what is being measured here.
