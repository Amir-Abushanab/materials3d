---
"@materials3d/core": minor
---

**Breaking: the `orb` preset is gone**, replaced by `knot`. `PRESETS.orb` no longer exists and
`preset="orb"` no longer resolves; use `knot`, or lift the old scene out of `gallery/orb.json` in
an earlier tag and pass it as a config. The two are close relatives, `knot` was built on `orb`'s
optics, which is most of the argument for the swap: the same numbers that lit a sphere light a
loaded mesh unchanged.

Add a `model` shape kind: point `shape.model` at a `.glb` and the renderer draws that mesh with
the same materials, motions and post stack as the built-in primitives.

The twelve primitives and `path` reach a lot of silhouettes, but not a shape with interior form
that a designer built in Blender. This is the escape hatch for those, alongside `path`.

- `.glb` only, read with a purpose-built parser rather than `GLTFLoader`: the glass shader uses
  `position` and `normal` and nothing else, so materials, textures, cameras, rigs and animation
  are all discarded, and the renderer chunk gains no dependency.
- Node transforms are baked to world space, so a hierarchy arrives assembled rather than piled on
  the origin.
- The mesh is centred and scaled until its longest half-extent is `r`, the same fit `path` gives
  a pasted SVG, so `r` resizes it whatever units it was authored in.
- `material.path` is measured off the loaded geometry (half its shortest bounding-box extent),
  which reproduces the hand-written value for `rod`, `sphere`, `disc`, `ring`, `slab` and `prism`.
- Quantized meshes (`KHR_mesh_quantization`) and sparse accessors are read, since neither needs a
  decoder and half-reading either gives a mesh that is wrong rather than one that is missing.
- Compressed geometry (Draco, meshopt), external buffers and meshes over 250k triangles are
  refused by name instead of read as noise.
- Loads asynchronously and rebuilds when the file lands, drawing a placeholder sphere meanwhile.
  `captureImage` waits for it, so a poster or a headless render is never a picture of the
  placeholder.

A new `knot` preset draws a `.glb` in glass between a rod and a disc, all on one lamp field and
one post stack. It carries its mesh inline (a 2016-triangle quantized trefoil, ~25 kB of base64)
because a preset hands back a URL and nothing in this package can make one resolve in a consumer's
app. That rides along with `@materials3d/core/presets` and the standalone build, not with the
drop-in component, which does not import presets: about 8 kB gzip on the CDN bundle, and nothing
at all for anyone using the React or element wrappers. It is meant to be the only preset that does
this; a second one should link a hosted file, as `gallery/community/knot.json` does.

**A `model` can stand in a traced beam.** `beam.targets` used to reach only the shapes whose
cross-section is a parameter, a lathe's `r` and `sides` or a `path`'s drawn outline; a mesh has
neither and was skipped in silence. It is now measured: the geometry is cut at the sheet's plane
and the largest contour handed to the same tracer, so a `.glb` refracts and disperses light the way
a `prism` item does. The same solid exported as a mesh and traced as a `model` reaches the polygon
`crossSectionFor` derives analytically, which is the test that pins it.

Cutting a mesh needs the item's whole pose, not the roll and centre a lathe needed, since the
contour changes with the sheet's height and with every axis the item is turned about. Only the
largest contour is traced: a plane through a pair of glasses returns the frame and both lens
openings, and the tracer keeps a single inside, so aim through solid material.

Materials Studio picks a `.glb` off disk, parsing it before it is applied so a bad file reports
why rather than silently leaving a sphere. `pnpm make:glb` writes test meshes in the encodings no
exporter hands you on request.
