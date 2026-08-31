---
"@materials3d/core": patch
---

Fix the node engine rendering nothing usable in the studio. Four defects, none of which any
existing check could see, because every harness in this repo is headless.

**`pow()` with a negative base took down every pipeline.** WGSL leaves `pow(e1, e2)` undefined for
a negative `e1`, and Tint does not merely return NaN: where both operands fold to constants — which
they do inside an unrolled loop over literal indices — it rejects the whole shader module at parse
time. One such expression in the spectral weights killed every pipeline built from the material, so
the scene drew as nothing at all. It compiled fine on the software adapter every existing check
runs on and failed only on a real GPU, which is why parity stayed green throughout. Replaced with a
documented `sq` helper; `grep` for `.pow(2)` before believing a shader is fine.

**`setConfig` pushed uniform values and never rebuilt anything.** The item list, beam and render
targets are objects built from the config, so changing preset left the previous scene's meshes on
screen wearing the new scene's uniforms — every preset drew as one leftover shape. It now mirrors
`MaterialRenderer`'s structural test and goes through the existing `refresh`/`rebuild`, which also
re-poses the camera; the framing was stale too.

**Two draws could interleave, and the damage latched.** `draw` is async, yields at every
`renderAsync`, and mutates shared state across those yields — `passIndex`, the plate binding, the
clear colour, `scene.overrideMaterial`, and the visibility of the backdrop and beam. The frame loop
fired it without awaiting, so the second draw read the flags the first had already cleared, saved
`false` as "was visible", and restored that. The backdrop and beam then stayed hidden for every
frame afterwards. Added a one-in-flight guard; structural rebuilds now run exclusively.

**Visibility was never authored.** It was only ever save/restored inside `draw`, so nothing could
put it back once a bad frame had poisoned it — and `transparentBackground` was silently ignored on
this engine as a result. Now derived from the config each frame.

Also: `resize` never applied `frameFov`, so `camera.fit` and `minVisibleWidth` did nothing here and
any non-16:9 frame diverged from the WebGL engine.
