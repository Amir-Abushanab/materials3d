---
"@materials3d/core": minor
"materials-studio": minor
---

New `material.magnify`: a convex solid as an actual lens.

`bend` fixed a sphere's flat middle but could not magnify, and the reason is structural: it moves a
sample around the FRAME, so the furthest it can travel is bounded by the shape's own size on
screen. Sweeping the plate across four distances under `bend` is visually flat. A lens magnifies
because the ray keeps going — refract at the surface and follow it to the plate, and the further
back the plate hangs the more of it a given angular deviation sweeps across.

Built on `backplate`, which is the same cast the REFLECTION already uses, pointed along the
refracted direction instead of the mirrored one. That is why it costs the reflective character
nothing: rim, specular and the environment are computed from their own terms and never touch the
transmitted colour. It reads the analytic lamp field rather than the rendered plate, so it sees no
other glass — the same trade `bend` makes — and it cannot sample itself at all.

Under its own knob rather than folded into `bend`, so either can be dialled back on its own.
Defaults to 0. At parity across both engines (0.16/255 whole-frame, the same noise floor as every
other preset), and `prism` and `skewer` are unchanged.

The `orb` preset now uses it at 0.85 with the plate pushed back to z -14, where the lamp rosette
arrives as distinct coloured lobes rather than one wash. `pnpm sweep orb +items.0.material.magnify=0,0.5,1`
shows the difference — and `sweep` now takes a `+` prefix to create a missing override, since an
item's material is sparse and a knob nobody has authored has no path to write to.
