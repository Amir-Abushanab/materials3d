---
"@materials3d/core": patch
---

Make the dev probes trustworthy: bypass post, and add two calibration probes.

Probe values were substituted into the material and then run through the whole post chain — tone
mapping, bloom, haze, vignette, grain. None of that is linear, so a probe read at the end was not
the number the material computed. Three different probes were observed reading identically at one
pixel, and probe deltas carried a constant level shift that reads convincingly as a geometric
offset. This produced several confident wrong conclusions.

Both engines now blit the colour target straight to the screen whenever a probe is active. Two new
probes make the result checkable rather than assumed:

- `calib` is a constant, so on a crop lying entirely inside the shape it must read exactly zero.
  Anything else means the crop caught background or a silhouette edge and everything measured on it
  is contaminated.
- `rampX` is a horizontal ramp of the fragment's own x — identical in both engines by construction
  but _varying_, so unlike a constant it can expose interpolation, MSAA resolve and target
  precision. It also reads exactly zero, which is what establishes there is no noise floor: on a
  validated crop, any nonzero difference is real.

Both were needed. Writing the bypass introduced a vertical flip on the node side that inverted
every y-bearing probe against its twin — invisible to a constant, and caught only once a varying
quantity could be compared.

Also adds `--shift dx,dy` to `tsl-compare` for checking registration between the two engines, and
`dotKey`, which is the specular lobe's argument before its exponent — at `pow(·, 40)` a difference
too small to see in the argument is a factor of three in the result.

Debug-only: every probe compiles out when unset.
