---
"@materials3d/core": minor
---

Fix `rim` and `specular` doing nothing on most shape kinds.

An audit rendering every material parameter against every shape kind at its low and high value, and
measuring the pixel difference, found two parameters that were not merely subtle but **inert**:

- `rim` was dead on 8 of 11 shape kinds — swung from 0 to 3, the frame came back bit-identical for
  a rod, disc, cone, sphere, arrow, droplet, blob and slab. The transmissive rim band was gated at
  `1 - N·V > 0.90`, the last six degrees before edge-on, which on a smooth convex surface is
  thinner than a pixel. It survived only on `prism` and `hex`, whose flat facets hold a whole face
  near grazing. The gate is now `0.62`.
- `specular` was dead on 7 of 11. The lobe was `pow(…, 140)` against a single key light pointing
  nearly straight up, so it only fired where a fragment's mirror direction landed almost exactly on
  it — unreachable for any shape whose normals are all horizontal, which is every upright lathe.
  Pushing `specular` to 30 did not rescue them, because the term it multiplied was exactly zero.
  The lobe is now `pow(…, 40)` and there is a second, lower fill key at 0.55 weight.

Both now register on every shape kind. Two knock-on effects: `ripple` also reads far better (it was
modulating a highlight that did not exist), and `createMaterial().specular` drops from `0.95` to
`0.35`, because a unit of specular now delivers several times what it used to — at 0.95 the
reference scene's rods came out with blown white streaks. Scenes that set `specular` explicitly are
unchanged in code and brighter on screen; if one is now too hot, scale it by about a quarter.
