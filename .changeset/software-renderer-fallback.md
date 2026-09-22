---
"@materials3d/core": minor
---

`webgl="auto"` now upgrades only onto a GPU.

A software rasterizer (SwiftShader, llvmpipe, Microsoft Basic Render) keeps the poster and reports a
new `"software-renderer"` fallback reason. The probe already asked for this via
`failIfMajorPerformanceCaveat`, which does not deliver it — Chrome hands back a SwiftShader context
regardless — so a machine with no usable GPU ran four passes per frame on the CPU, costing seconds
of blocked main thread, while the element was already carrying the better answer in its poster.

`probeWebGL()` and `isSoftwareRenderer(gl)` are exported, because otherwise every consumer wanting
this writes the same `WEBGL_debug_renderer_info` read, and the failure mode is silent: the extension
is hidden under some privacy settings, and treating "cannot tell" as "software" downgrades people
with a perfectly good GPU who then see a poster forever with nothing to report. An unreadable
renderer counts as hardware.

If you want the live render on a software renderer, that is `webgl="force"`.
