---
"@materials3d/core": minor
---

Replace the `cascade` preset with `spectacles`: a drawn silhouette with a beam through it.

Every other preset composes shapes the language describes with numbers. This one shows the case it
cannot — an outline with no radius, pasted in from a drawing, carrying its own holes — and then
puts light through it. A pair of spectacles is the clearest example there is: nobody would try to
build one out of lathes, and everyone can see whether it came out right.

It is only possible because the tracer no longer needs a convex cross-section. This outline turns
back on itself at the bridge and at both temple tabs, and until the clipper learned to scan a
re-entrant polygon edge by edge it was refused outright.

Three things about it are optics rather than styling:

- **The beam crosses the bridge.** `crossSectionFor` reads the first subpath only, so the tracer
  sees a filled silhouette where the mesh has two lens openings. The bridge is the one part of the
  frame with clear air above and below, so the traced path and the rendered solid agree along its
  whole length; any route across an opening would bend light through air the mesh draws as empty.
- **The bridge's underside slopes.** A bar with parallel faces refracts a ray twice by equal and
  opposite amounts — it comes out displaced and exactly parallel, which is to say white. The apex
  between the faces is what makes a prism a prism, and seventeen degrees of it is what fans this
  one.
- **Incidence 14°, swept -34 to +18.** Measured rather than picked: the fan widens from 9° at
  normal to 16° by +20, past which the blue end passes the critical angle on the sloped face and
  starts bouncing inside the bar. Adjacent wavelengths only join into a sheet while they share a
  route.

The plate is resized to the scene, which `prism` never had to do because it carries no lamps: the
inherited 26x20 put a lamp nearly seven units off to the side of a frame two thirds of a unit wide.
And `rim` runs high where `cascade` runs it low — a frame is nearly all edge, so the Fresnel term
is what stops the far side being black on black.

`cascade` goes to make room. It was the only preset the WebGPU harnesses could name — `pnpm
tsl:live cascade` no longer resolves and `tsl:perf` loses that row — and the only test of threading
one beam through several solids. That behaviour has not gone anywhere, so its three-solid geometry
moved into the test that needs it rather than being deleted with the scene.
