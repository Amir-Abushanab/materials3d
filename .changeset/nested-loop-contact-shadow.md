---
"@materials3d/core": patch
---

Fix contact shadows coming out at roughly twice their strength on the node engine.

The wall's occlusion loop walks the grounded footprints and calls `footprintDistance`, which
contains a `Loop` of its own. A TSL `Loop` nested inside another does not survive: the inner
function's `toVar` accumulator is hoisted out of the scope it belongs to, so each slot came back
with a distance that is not the one the same call returns evaluated on its own — measured as -0.19
against +0.04 for the identical expression outside the loop.

Nothing about it looks like a loop problem. It reads as a shading difference over the whole
backdrop wherever a shape meets the wall, and it propagates: the wall is what the glass refracts,
so the shapes carried it too.

The outer walk is now unrolled in JavaScript. `GROUND_SLOTS` is a compile-time constant, so this
costs nothing a `Loop` would not — the shader was going to unroll it anyway — and the count guard
stays a runtime condition.

Found by bisecting the wall term by term with new dev probes: the footprint distance and the
soft-inside curve both matched exactly, while the occlusion built from them did not.

`prism` 16.31 to 10.86, `cascade` 7.60 to 6.88, and the prism body with post disabled 5.02 to 1.06.
