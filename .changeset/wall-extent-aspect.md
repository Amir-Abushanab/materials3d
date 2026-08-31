---
"@materials3d/core": patch
---

Fix the wall backdrop being rendered 40% too narrow.

`beamWallExtent` takes `max(camera.aspect, 1)` for the wall's horizontal half-width, but the extent
was only ever derived in `applyBackground` — which runs on refresh, before the first `resize`, when
`camera.aspect` is still three's default of 1. So the wall came out square, its horizontal extent
short by the whole aspect ratio, and nothing recomputed it on resize. Everything the wall shades
from world position — the relief at both scales, the light falloff, the contact shadows — was
computed on a horizontally compressed surface.

The node engine had its own, differently wrong derivation: it measured from the camera's z rather
than from the orbit distance and the look-at, and omitted the safety margin that keeps the wall
overshooting the frustum. Both now use one derivation, re-run whenever the aspect changes.

**This changes how wall-mode scenes look** — `prism` and `cascade` in the gallery. The relief is now
at the scale the constants were chosen for rather than horizontally squeezed.

Whole-frame agreement between the two engines moves slightly the wrong way as a result (`cascade`
7.02 to 7.60, `prism` 15.43 to 16.31): the wall is now drawn at its correct, larger scale in both,
where a residual difference in the wall shading itself is more visible. That difference is real and
still unattributed — the fix is correctness, not parity.
