---
"@materials3d/core": patch
---

Fix the node engine's value noise using a different hash than the shader it ports.

`valueNoise` builds on `hash12` in GLSL — Hoskins' sine-free hash — but on `hash21`, the
`fract(sin(...) * 43758)` one, in the node graph. The two are interchangeable as noise and are not
the same numbers, so every wall backdrop rendered a different texture in each engine.

No probe of `valueNoise` could show it, because the parity case carried a hand-written GLSL twin
that also used the sine hash, and therefore agreed with the wrong side. So did the caustic case,
through a shared prelude. Both now build from `NOISE_CHUNK`, exported from `shaders.ts` — the same
source the shipping shader uses — and a case for `hash12` itself is added.

There is a second reason to prefer the sine-free hash beyond matching: `fract(sin(x) * 43758)`
amplifies whatever a backend does in the last bits of `sin` into an unrelated value, so it is not
reproducible across backends even when both sides are spelled identically. The paper-texture path
still uses `hash21` deliberately — both engines agree there.

The bare wall backdrop goes from 1.47 to **0.00** mean absolute difference. `prism` 10.86 to 10.28
and `cascade` 6.88 to 6.56.
