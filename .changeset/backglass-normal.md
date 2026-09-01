---
"@materials3d/core": patch
---

Fix the back-glass pass using a face-flipped normal on the node engine.

The inner-interface pass draws BACK faces, and three flips `normalWorld` to face the viewer on a
back-facing draw. `BACKGLASS_VERT` does no such thing — it carries `mat3(modelMatrix) * normal`
straight through — and the shader wants exactly that: the outward normal of the face the ray is
leaving through, which points away from the camera by definition here.

Taking three's flipped one put the reflected ray on the wrong side of every back face. It surfaced
as a bright ring on the bevel, which is the one place where which plane a ray exits by is genuinely
in question, so it read as a bevel artefact rather than as a normal pointing the wrong way. The
node graph now builds the world normal from the object's own, matching the vertex shader.

`prism` 10.28 to 7.91 and `cascade` 6.56 to 5.17; with post disabled, `prism` goes 2.40 to 0.18.
