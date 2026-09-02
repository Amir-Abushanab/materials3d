---
"@materials3d/core": minor
---

Replace the `cascade` preset with `spectacles`, a drawn silhouette in glass.

Every other preset composes shapes the language describes with numbers. This one exists to show
the case it cannot: an outline with no radius, pasted in from a drawing, carrying its own holes.
A pair of spectacles is the clearest example there is — nobody would try to build one out of
lathes, and everyone can see whether it came out right.

- The frame is one subpath and the two lens openings are the next two, which is the
  outline-then-holes rule doing exactly what a vector tool's own output does.
- Three proportions do the work of reading as spectacles rather than as two rings: rims half again
  as wide as they are tall, a bridge in the upper third where a real one clears a nose, and square
  temple tabs off the outer edges. No arm is drawn — the hinge alone is enough to give the object
  a front and a back.
- Posed at three quarters, because face-on an extrusion is a coloured decal: the depth, the bevel
  and the refraction through the rim all disappear together.
- `measuredThickness` is on, which is unusual for an extrusion and earns it here — the frame is a
  thin ring of glass and the bridge is thinner still, so the analytic chord's single depth is
  uniform everywhere while the measured one falls off through the bevel and gives the rim its own
  gradient.

`cascade` goes to make room. It was the only preset threading one beam through several solids, and
the only one the WebGPU parity and perf harnesses could name — `pnpm tsl:live cascade` no longer
resolves, and `tsl:perf` loses that row. Its scene is recoverable from git history if the
benchmark is wanted back.
