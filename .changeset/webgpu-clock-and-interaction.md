---
"@materials3d/core": patch
---

Drive the interaction layer and the clock on the node engine.

**The clock advanced by a fixed 1/60 per animation frame**, which is the display rate, not a
duration. On a 120Hz screen every scene ran at exactly double speed and on 144Hz at 2.4× — the
scene was simply faster on better hardware, which is not something anyone would attribute to the
renderer. Now wall-clock delta, capped at 50ms so a backgrounded tab resumes rather than teleports,
with the intro ramp the WebGL engine has. Measured on a 120Hz display, both engines now advance
2.00s of scene time per 2.00s of wall time.

**The interaction layer was constructed and never driven.** The controller tracked the pointer and
answered `bindingValue` correctly, so from the config's side everything looked present — but
nothing called `update`, ran the appliers, or read the results back, so every reaction in every
scene was inert. Now wired: per-frame binding evaluation through the same applier tables as the
WebGL engine (adapted by uniform name rather than duplicated, because binding semantics drifting
between engines is worse than having none), `hoverSelf`/`pressSelf` raycasting, the camera zoom and
orbit targets, the beam retrace, and `timeOffset` as a delta over the authored clock.

Captures now render the interaction REST state, as the WebGL engine does, so an export no longer
depends on where the pointer happened to be. Note that the rest state is each binding's authored
base, which is NOT the same as evaluating the mix at zero — that gives `from`, the far end of the
travel. Prism's beam is authored at -60° with its incidence binding starting at -75°, so getting
this wrong moved the beam in every capture.
