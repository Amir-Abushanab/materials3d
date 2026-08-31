---
"@materials3d/core": patch
"materials-studio": patch
---

Mark the WebGPU/TSL engine as experimental, and say what that means concretely.

It renders every preset and agrees closely with the WebGL engine on most of them, but it is not
pixel-equal, and the gap is not uniform — so WebGL is documented as the reference and anything that
has to match a design should be checked on both. The README, the `renderer` option, `RendererKind`
and the `NodeMaterialRenderer` class doc now carry the per-preset numbers rather than a bare
"experimental", and the studio's engine picker is labelled in the option itself rather than only in
its hover hint: someone comparing two renders needs to know which is the reference without going
looking for it.

Most of the remaining spread is the specular lobe, which comes out weaker. Because the lobe is
raised to the 40th power a fraction of a degree is a factor of two, and a flat face either catches
the highlight or does not — so faceted solids are hit hardest while smooth ones are nearly exact.
