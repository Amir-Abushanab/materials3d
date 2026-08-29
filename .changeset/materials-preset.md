---
"@materials3d/core": minor
---

New `materials` preset: every material kind against every shape kind, as a swatch grid.

Seven rows — `glass`, `frosted`, `glitter`, `liquid`, `metal`, `ceramic`, `plastic` — by eleven
columns, one per shape kind, with each swatch named `"metal · ring"` so the studio's shape list
doubles as the legend. Built by iterating `MATERIAL_KINDS` and `SHAPE_KINDS` rather than by listing
the pairs, and the per-shape size table is typed as a full `Record<ShapeKind, …>`, so adding a kind
to either list adds a row or a column instead of silently leaving one out.

Every row shares one set of optics and differs only in its shading model. The transmissive rows
carry no `tint`, so they take the colour of whatever lamp sits behind them and run warm to cool
across the frame; the opaque rows take their published `albedo` from `MATERIAL_PRESETS` and stay
put, which is the difference the chart exists to show. Flat, sharp and haze-free on purpose — a
swatch that changes with where it sits in the frame is not a swatch.
