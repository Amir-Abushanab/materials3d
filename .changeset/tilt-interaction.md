---
"@materials3d/core": minor
"@materials3d/element": minor
"@materials3d/react": minor
---

Device tilt as an interaction input. `tiltX` / `tiltY` join the binding sources, reading the phone's
orientation sensor normalized 0..1 the way a ball would roll on the screen and resting at 0.5 in
whatever pose the reader was already holding — the first reading becomes the neutral centre, and the
axes are rotated by the screen angle so `tiltX` means "toward the right edge" in every orientation.
On these materials it is the most literal reading of the surface: tilt the device and the highlight
travels across the glass the way it would on a real object in your hand.

Binding either source is what arms the sensor; a scene that mentions neither attaches no
`deviceorientation` listener. `interaction.tilt` tunes it (`range`, `smoothing`, `invertX` /
`invertY`) and `tilt.pointer` lets tilt stand in for the cursor, so the lamp-follows-the-cursor scene
works on a phone without a second set of bindings.

**iOS gets no tilt, on purpose.** Safari gates the sensor behind a modal permission dialog, and
nothing here opens one — a tilt-bound scene on an iPhone reads 0.5 on both axes and renders exactly
as it would with no tilt at all. A decorative effect is not worth interrupting a reader for, so tilt
is an enhancement some phones simply don't get. `enableTilt()` on the renderer / handle / element is
the explicit opt-in for a page where tilt is the point; `tiltStatus()` reports where the sensor
stands, and `recenterTilt()` re-takes the neutral pose after a change of grip.

**The interactivity runtime is now a lazy chunk.** The controller, its listeners, the applier tables
and the new tilt sensor (~3.7 KB gzipped) used to ship in every bundle, including the scenes that
bind nothing; both engines now reach them through a dynamic import, and the eager core chunk drops
from 75.9 KB to 72.7 KB gzipped. `interactionActive` moved to `renderer/interactionGates.ts` (it is
re-exported from `@materials3d/core/renderer` as before), and a dependency-cruiser rule fails the
build if anything in the eager graph imports the runtime again.

BREAKING, narrowly: `InteractionController` is now a TYPE-only export of `@materials3d/core/renderer`
— a value re-export would drag the chunk back into every bundle. The renderers own the instance;
nothing outside them could usefully construct one.

The one behavioural difference: interaction goes live a chunk-fetch after the first frame rather
than on it. Nothing to react to until a reader moves, so it is invisible in practice —
`setInteractionInput` calls made in that window are staged and replayed, and `enableTilt()` reports
false (and starts the fetch) if it somehow lands first.
