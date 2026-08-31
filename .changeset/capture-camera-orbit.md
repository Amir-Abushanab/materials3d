---
"@materials3d/core": patch
---

Fix captures being taken from the wrong camera on any scene with a `cameraYaw` or `cameraPitch`
binding.

`captureImage` strips the live interaction state before posing the camera for the capture frame —
but it only stripped the time scrub and the zoom. `updateCamera` reads `orbitYaw` and `orbitPitch`
straight out of the same out-params, so a capture was framed from wherever the last live frame had
swung the camera.

That is not zero at rest. Before any pointer arrives the sources read 0, not their midpoint, so a
binding is evaluated at its `from` end: `prism` captured from a camera swung -3.5 degrees of yaw
and -3 of pitch. Every poster, every still and every exported frame of such a scene was framed from
a position the config never asked for, and the same config could produce two different images
depending on whether a pointer had been near the canvas.

It stayed hidden because a degree of arc is invisible in everything except a specular highlight,
where `pow(dot(...), 40)` turns it into a factor of three. That is how it was eventually found: the
node engine — which re-poses the camera from the rest state on every frame and so was always
correct here — disagreed with this one about the specular lobe on prisms, and nothing else.

Fixing it collapses that disagreement completely. On a validated interior crop every material probe
— world position, view vector, mirror vector, N·V, the lobe's argument and the lobe itself — now
reads a difference of exactly zero between the two engines, where the lobe alone had been 15.8.
Whole-frame, `cascade` goes 12.41 to 7.02 and `prism` 19.41 to 15.43.
