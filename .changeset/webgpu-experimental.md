---
"@materials3d/core": patch
"materials-studio": patch
---

Mark the WebGPU/TSL engine as experimental, and say what that means concretely.

It renders every preset and agrees closely with the WebGL engine on most of them, but it is not
pixel-equal, and the gap is not uniform — so WebGL is now documented as the reference and anything
that has to match a design should be checked on both.

The detail lives in a new `WEBGPU.md`: where it stands per preset, what is known to differ (mostly
the specular lobe), what has already been ruled out, and how to work on it. The README, the
`renderer` option, `RendererKind` and the `NodeMaterialRenderer` class doc each say "experimental"
and point there rather than repeating any of it.

The studio labels the option itself "WebGPU (TSL) · experimental" rather than only its hover hint:
someone comparing two renders needs to know which is the reference without going looking for it.
