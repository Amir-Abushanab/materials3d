---
"materials-studio": minor
"@materials3d/core": minor
---

The studio can switch engines.

An **engine** control in Performance swaps between the WebGL renderer and the node/TSL one in
place, keeping the scene exactly as it is. It names the ENGINE, not the backend: `WebGPU (TSL)`
selects three's node renderer, which still falls back to a WebGL backend where the browser has no
WebGPU.

The choice is session state, not scene state. A config describes a picture; which renderer draws it
is a property of this sitting, so it neither serializes nor reaches an export — and a scene shared
by link opens on whichever engine the recipient last chose.

The second engine is fetched on demand, so the studio does not carry a whole second three build for
everyone who never switches. Verified in the production build rather than assumed: it lands in its
own 700 KB chunk, the main chunk contains zero references to `WebGPURenderer` or the WGSL node
builder, and it is referenced lazily.

`@materials3d/core` gains a `./renderer-webgpu` subpath for this. `NodeMaterialRenderer` is
deliberately not re-exported from `./renderer`: naming it in that barrel would pull `three/webgpu`
into everything importing the barrel, so reaching for it has to be a decision.

Two things the swap is careful about. The config object survives it — it is the studio's single
source of truth, and the new renderer normalizes the same object, so the panel keeps binding to
what it was already bound to. And if the fetch fails, the control is put back where the engine
actually is rather than claiming a switch that did not happen.
