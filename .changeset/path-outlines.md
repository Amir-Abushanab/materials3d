---
"@materials3d/core": minor
---

New `path` shape kind: an arbitrary silhouette, authored as SVG path data and extruded.

- The lathes and the slab cover shapes describable by numbers. This is for the ones that are not —
  a pair of spectacles has no radius, only an outline — and it takes the `d` attribute a vector
  tool puts on the clipboard, so curves arrive without being pre-tessellated and a scene still
  fits in a share link.
- Two normalizations make a paste work rather than merely parse. Y is flipped, because SVG's grows
  downward and three's grows up. And the drawing is scaled about its own bounding-box centre until
  its longer half-extent is `r`, so a path from a 0–1000 viewBox and one from a unit square land at
  the same size — and `r` becomes the resize handle on a kind that has no radius of its own.
- The first subpath is the outline and every later one is a hole. A contract rather than a winding
  rule or an even-odd fill: a containment test that guesses wrong silently turns a hole into a
  second body. `cuts` still apply on top.
- A `d` subset, deliberately: M/L/H/V/C/S/Q/T/A/Z in both cases, which is every command that
  describes a closed contour. Arc flags are read one character at a time, so an optimizer's
  `a1 1 0 011 1` is not mistaken for a radius of one hundred and eleven.
- Depth is compensated for the bevel and the outline is not. Depth is a number the config asked for
  and `defaultPath` hands it straight to Beer–Lambert; correctly insetting an arbitrary contour is
  a polygon-offset problem whose answer for a non-convex outline is not even a single contour, so
  the drawing comes out as drawn plus the bevel's own lip — the trade `arrow` already makes.
- Not eligible for traced refraction, which wants bounding planes only a faceted lathe can supply,
  so it takes the screen-space refraction like every other extrusion. `measuredThickness` is
  optional exactly as it is for `slab` and `arrow` — `defaultPath` is `depth / 2` and the analytic
  chord is `2 · path · ndv^0.4`, which face-on is the depth, the true path through a plate.

Follow-ups in the same release:

- Paste a whole `<svg>` document, not just the `d` inside it. Every `<path>` is read in document
  order, which is already the outline-then-holes order a vector tool writes. Extraction happens
  before the length cap, or the cap would truncate the markup and leave nothing to find.
- The length cap now cuts between commands. A blind slice could halve a coordinate, and one
  truncated number poisons its contour — so the shape did not come out shortened, it came out
  gone, silently replaced by the default outline.
- The default bevel is sized off the outline's NARROWEST LIMB rather than its bounding box, so a
  fine feature is no longer swallowed by its own fillet. A negative `fillet` now means "no bevel";
  `0` still means "pick a proportional one", and every kind but `path` reads a negative as `0`
  because a lathe with no fillet collapses its corner arc into degenerate triangles.
- A CONVEX drawn outline can be a `beam` target. `crossSectionFor` takes the shape rather than
  three loose fields, and answers per shape instead of per kind — a drawn lozenge refracts the
  beam, a pair of spectacles is dropped as a `ring` is. Its convexity test is normalized to the
  turn angle, so a traced circle at an exported file's precision is not mistaken for re-entrant.
  The beam's rotation applies only to the lathes, whose slice is generated in XZ; a path is drawn
  in the sheet's own plane and takes just the item's roll.
- The studio coalesces outline edits instead of rebuilding every shape's geometry per keystroke —
  measured at 18 ms per rebuild for a 4000-point outline, and 75 ms for a self-intersecting one.

Beam tracing generalized to re-entrant outlines:

- `clipConvex` is Cyrus–Beck, which treats each edge as a half-plane and is convex-only by
  construction — on a notched outline it reports crossings on the far side of the notch that the
  ray never makes. It is now one of two clippers, chosen per shape by a `convex` flag on
  `PreparedPolygon`: convex outlines take it unchanged (so every existing scene, and the angular
  fast path for lathes, is untouched), and anything else takes a general nearest-crossing scan.
- The multi-solid walk already re-scanned every solid each step, including the one just left, so
  re-entry needed nothing but the clipper: a beam now crosses a "C" as glass, air, glass. The
  scans apply `SURFACE_EPS` themselves, since a ray stepping on from an exit stands on the
  boundary and returning that t would make the caller skip the solid as "behind the ray".
- `crossSectionFor` now refuses only SELF-CROSSING outlines. Convexity was the wrong gate; a star
  is a perfectly good solid, while a figure-of-eight has no inside for the trace to be right about.
- Outlines are simplified with Douglas–Peucker rather than uniform index sampling. Uniform
  sampling thins a straight run and a narrow notch at the same rate, and the notch is the feature
  that made the outline interesting; simplifying first also means the self-crossing test only
  rejects outlines that genuinely cross, not ones where rounding made them appear to.
- Measured on 3000 rays: a re-entrant star traces in 4.1 ms against 3.5 ms for the shipped
  triangular prism, and drops 9 rays to the prism's 255 — so `MAX_BOUNCES` and `MAX_SOLIDS` needed
  no change.
