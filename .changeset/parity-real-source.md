---
"@materials3d/core": patch
---

Add parity coverage for the wall's footprint maths, and stop the harness testing transcriptions.

`softMax`, `footprintDistance` and `hash12` had no parity case, which is how a nested-`Loop` bug and
a wrong noise hash both survived in the wall. They have one now, built from `FOOTPRINT_CHUNK` and
`NOISE_CHUNK` — extracted from `shaders.ts` and used by the shipping shader — rather than from a
copy pasted into the harness.

That distinction is the point. Two cases previously carried hand-written GLSL twins that used a
different hash than the engine does, so they agreed with a port that was also wrong and passed for
as long as they existed. A parity case that transcribes its reference is only as good as the
transcription, and a bad one fails silently in the direction that hides bugs.

`GROUND_SLOTS` and `GROUND_MAX_SIDES` move to `config/model` and are now read from there by the GLSL
material's defines, the node graph's unrolled walk and the harness, instead of being written out
three times.

53 cases, all matching.
