---
"@materials3d/core": patch
---

Fix scenes that bind `positionX` / `positionY` on a drifting shape opening in the wrong pose, and
rendering different stills from the same config.

A position binding runs after the motions and wins over a drift on the same axis, so at rest it
holds that axis at the shape's authored position. Until the lazily loaded interaction chunk
arrived, though, nothing wrote the binding, so the first frames showed the drift instead and the
shapes snapped into place a moment later. A `captureImage` in that window exported the drifted
pose, so the same config rendered differently depending on how fast one dynamic import resolved.
`staircase` showed it in the WebGPU renderer; the WebGL renderer had the same gap. Both now draw
the frames before the chunk in the same rest pose as every frame after it.
