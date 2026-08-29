---
"@materials3d/core": minor
---

Carve-outs: shapes with a flat profile now take a list of through-cuts, so a plate can be slotted.

- New `slab` shape — a rounded-rectangular plate, flat to the lens. A four-sided lathe already
  gave a square plate, but its fillet rounds the flat ends of the sweep, never the four vertical
  corners; a slab rounds the silhouette.
- New `cuts` on `ShapeConfig`: `rect` and `circle` holes, posed in the shape's profile plane.
  A slot is a `rect` whose corner radius has reached half its short side. Honoured by `slab` and
  `arrow`, and by `disc` / `prism` / `hex`, which swap their lathe for the equivalent extrusion
  when they carry cuts — same outline, same orientation.
- Cuts go all the way through. Glass thickness is measured as (back-face depth − front-face
  depth), so a hole open at both ends draws nothing and is exactly correct; a blind pocket would
  report the empty cavity as solid glass.
- `normalizeShape` now accepts `ShapeInput`, which permits partial cuts — it is the boundary that
  parses untrusted JSON, and it already defaulted every field of one.
- The Assembly preset is rebuilt around this: five pieces instead of seven, three of them slotted,
  with a drift at roughly half the rate and half the travel.
