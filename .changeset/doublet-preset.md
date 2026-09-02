---
"@materials3d/core": minor
---

Replace the `cascade` preset with `doublet`: two overlapping lenses in one beam.

A `disc` is a lathe, so its slice in the beam's plane is a CIRCLE — and a circle is a lens, which
refracts every ray toward its own axis rather than simply bending it. Two in series is the cheapest
optic that does something a single prism cannot: the fan arriving at the second element has already
begun to separate, so each wavelength meets it at its own angle.

The overlap is the whole constraint on the scene, and it is a property of the tracer rather than of
the optics. `traceSolids` walks solids one at a time — enter the nearest, leave it, look for the
next — so a ray that leaves the first element INSIDE the second cannot enter it: from inside, every
crossing ahead points outward, `clipEntry` reports nothing, and the second lens is skipped in
silence. At an overlap of 0.13 a scan of the entire aim space, 160 combinations of entry angle and
incidence, found no route through both. Thinned to 0.03 the beam crosses just off the tangent point
and threads them. So "slightly" is load-bearing: much more and the second element goes dark.

`cascade` goes to make room. It was the only preset the WebGPU harnesses could name — `pnpm
tsl:live cascade` no longer resolves and `tsl:perf` loses that row — and the only test of threading
one beam through several solids. That behaviour has not gone anywhere, so its three-solid geometry
moved into the test that needs it rather than being deleted with the scene.
