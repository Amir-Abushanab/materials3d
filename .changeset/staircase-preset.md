---
"@materials3d/core": minor
---

New `staircase` preset: a glass spiral staircase falling away down the page.

Thirty-four near-clear slab treads on a tapering helix with a vertical axis, shot on a 50° lens
from close in: the top treads are roughly six times wider on screen than the last and the run
trails off as it descends. Untinted, so each tread takes the colour of the lamp behind it and the
descent runs hot coral at the hero through to cool blue at the far end.

Every tread carries the same two hover bindings (`hueShift` + `emission`, so it lights up under the
cursor) and a `scroll` → `positionY` binding that lifts the whole spiral, so scrolling the page
descends the staircase.
