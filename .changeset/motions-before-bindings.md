---
"@materials3d/core": patch
---

Fix the node engine applying interaction bindings before motions instead of after.

`ITEM_APPLIERS.positionY` writes `mesh.position.y` directly, so whichever of the two runs last owns
that component. The WebGL engine runs the motions first and the bindings second, deliberately — a
bound axis is meant to win over a drift on the same axis, which is what a scene asking for both is
asking for. The node engine had the order reversed, so the drift won and the binding was silently
inert at rest.

It did not look like a binding problem. It showed up as a POSE difference: on `staircase`, where all
twenty shapes bind `positionY` to scroll and also drift, each sat about a tenth of a unit away from
where the WebGL engine put it. That fed into the measured optical path, and out of that into the
colour of every shape — which is why it read as a shading difference over a third of the frame.

Both engines drive the motions on the previous frame's `interactionTime`, which is what
`applyInteraction` has produced by that point in the frame.

`staircase` goes from 11.17 to 2.91 mean absolute difference against the WebGL engine.
