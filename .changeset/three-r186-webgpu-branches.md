---
"@materials3d/core": patch
---

Fix the WebGPU renderer on three 0.186: metals lost their direct highlight, and the prism's internal
reflections and the reflections on opaque shapes came out wrong.

three r186 (mrdoob/three.js#34251) stopped giving each branch of a TSL `select`/`If` its own node
cache. A value that more than one branch reads was assigned inside whichever branch three generated
first, and every other branch, and the code after the conditional, then read it unassigned. The
values shared that way are now pinned with `.toVar()` before any branch reads them, so the
generated shader is correct on every three version the peer range allows. The WebGL renderer was
not affected. three fixed this upstream in mrdoob/three.js#34531, which is not in 0.186.1.
