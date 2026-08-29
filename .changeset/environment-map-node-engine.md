---
"@materials3d/core": patch
---

Fix a reserved word that silently killed the whole backdrop program, and port the prefiltered
environment map to the node engine.

**`float half` does not compile.** `half` is reserved in GLSL ES 3.00, and three rewrites every
non-raw `ShaderMaterial` to 3.00 — so `softInside` failed, took `BACKDROP_FRAG` down with it, and
the wall backdrop drew nothing at all. A dead backdrop looks exactly like a scene with no wall
configured, which is why it survived: the symptom is an absence. Renamed to `edge`.

**The environment chain now exists on the node engine.** `studioRoom`, `sampleEnv` and `studioCone`
in `nodes/common`, `envBakePass` and `envBlurPass` in `nodes/passes`, and a `buildEnvironment` that
bakes the room into the mip levels of one texture — eight levels, each a sin(theta)-compensated
blur of the one above, built through scratch targets because a texture cannot be sampled and
written by the same draw. Verified by dumping the levels: level 0 carries the softbox panels,
level 5 is a broad wash, and the poles do not streak.

Two things the port is careful about. `envBlurPass` takes a texture NODE rather than a texture, so
one compiled material walks the whole chain by swapping `src.value` — taking a `Texture` would mean
a fresh shader compile for each of the fourteen draws a bake performs. And the glass branch's
reflection reads the ANALYTIC room, not the cone, because `GLASS_FRAG` does: glass takes a mirror
reflection whatever its roughness, since a transmissive surface spends its roughness on the cone
that goes through it.

`scripts/tsl-parity.mjs` gains both axes of the blur (45 cases, still exiting non-zero on any
mismatch). `sampleEnv` is deliberately not among them: it reads an explicit mip level, and the
harness renders single-level textures, so a case for it would compare two level-zero fetches and
prove nothing.
