---
"@materials3d/core": patch
---

Fix two errors that stopped `BACKDROP_FRAG` compiling at all.

Both are in the wall branch, and a compile error anywhere in a program takes the whole program with
it — so this was never a wall-mode bug. Every scene was drawing its backdrop through a program that
had failed to build.

- **`float half` is not a declaration.** `half` is reserved in GLSL ES 3.00, and three rewrites
  every non-raw `ShaderMaterial` to 3.00. Renamed to `edge`.
- **`uWallMicroFreq` and `uWallMicroNormal` were never declared.** The renderer has supplied both
  since the wall was written; the shader only ever used them. They sat behind the `half` error,
  which failed first, so fixing one revealed the other.

The visible effect is not subtle — the `prism` scene changes by a mean of 14/255 across 90% of its
pixels, gaining back the contrast and facet structure the dead backdrop was costing it. Rendered
gallery images will differ.

The reason this survived is worth recording: a backdrop that fails to compile looks exactly like a
scene configured without one. The symptom is an absence, and nothing in the frame points at it.
