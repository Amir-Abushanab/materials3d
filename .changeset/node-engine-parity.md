---
"@materials3d/core": patch
---

Close most of the gap between the two engines. Four defects, three of them invisible in the code.

**The node renderer was encoding the frame twice.** Its post pass is a faithful port of `POST_FRAG`,
which writes `gl_FragColor` directly — the whole engine is display-referred and never applies an
output transform, because a hand-written fragment shader bypasses the one three injects. The node
renderer has no such exemption, so it ran three's output colour management on top. A mid grey left
the shader at 0.5 and reached the canvas at 188 instead of 128, which lifts every dark value,
compresses every bright one, and costs about half the chroma. `outputColorSpace` is now
`LinearSRGBColorSpace`.

**Shapes were missing from the plate entirely.** The item materials sample the plate, so on the
plate pass they were bound to the target being drawn into — a feedback loop, and the driver drops
the draw. GLSL sidesteps it by guarding the fetch behind `uPass`, but a node graph binds the
texture whether the branch reads it or not, so the binding itself had to go: one shared texture
node, pointed at a 1×1 stand-in for the plate pass and at the real plate for the main pass. The
visible cost was a shape refracting a backdrop instead of itself, which reads as washed out rather
than as missing.

**The glass branch was missing most of its tail** — thin film, the rim window, the specular lobe,
glitter, hue rotation, authored tint, authored absorption, saturation and the contrast expansion,
plus the reflection weight that quadruples under a softbox. All present now.

**`transmission: "simple"` did nothing.** The node engine always ran the eleven-sample cone; the
default is three rays. Added as `simpleTransmission`, selected by a real `If` on a scene uniform
rather than a `select` — a select evaluates both sides, which would cost eleven plate lookups on
every scene that asked for three.

Also: the back-face depth target now filters NEAREST, matching the GLSL engine and for the reason
its comment gives — a blend of the low byte of two packed depths decodes to a distance in neither.

Measured with `scripts/tsl-compare.mjs` on a single glass rod: mean absolute difference 29.5 → 9.0,
pixels differing by more than one 8-bit level 99.7% → 43.5%, and chroma 14.4 → 26.7 against the
WebGL engine's 29.9. On the 77-shape `materials` scene, 34.1 → 24.2.

Both engines now carry a matching dev probe — `__tslDebug` and `__glslProbe` — that substitutes one
intermediate of the glass shader on the main pass only, carrying the pass's real alpha. That
symmetry is what found the double encode: the same constant written by both shaders came back as
two different bytes.
