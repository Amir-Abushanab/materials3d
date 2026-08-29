---
"@materials3d/core": minor
---

Five ports from Vercel's `vgpu` examples (MIT — see `THIRD-PARTY-NOTICES.md`): a prefiltered
environment map, cone transmission, paired bloom taps, a two-scale wall normal field and a beam
reveal.

**`SceneConfig.environment`** (`"analytic"` | `"baked"`) is the substantial one, adapted from their
`environment-map` example.

The room a surface reflects has always been evaluated analytically, per fragment, which answers
"what is in this direction" exactly. That is the right answer for a mirror and the wrong one for
everything else: a rough surface reflects a CONE, not a ray. Roughness therefore had to fake the
difference by fading the sharp reflection toward a flat grey — so a rough metal reflected _less_
room rather than a blurred one, which reads as chalk rather than as brushed steel.

`"baked"` rasterizes the same room once into a 512×256 equirectangular HDR texture and blurs it
into an eight-level mip chain, so roughness becomes a mip level. It is also CHEAPER per fragment
than the analytic room it replaces — one texture fetch instead of a loop over panels.

Three details are load-bearing:

- **The horizontal blur is compensated by `1/sin(θ)`.** A row near a pole covers far less solid
  angle than one at the equator, so a blur of constant texel width is a blur of wildly varying
  ANGLE — the poles smear into streaks while the middle barely moves. The vertical pass gets no
  such correction, and applying it there would pull the poles apart instead.
- **The level is the max of the roughness cone and the reflected direction's screen footprint.**
  The cone alone leaves a mirror-smooth surface aliasing wherever it curves away and compresses the
  whole room into a few pixels.
- **An explicit level, not a bias.** The three-argument `texture2D` is a bias in both GLSL ES
  versions, and a bias is applied on top of the footprint the hardware derives — which is exactly
  what the LOD already accounted for. three rewrites every non-raw `ShaderMaterial` to GLSL ES 3.00
  and defines `texture2DLodEXT` as `textureLod`, so that spelling is available unconditionally.

Default `"analytic"`, because every preset predating this was calibrated against it; `prism` and
`cascade` render byte-identically with it.

**Bloom taps are read in PAIRS**, from their `bloom-blur-paired.wgsl`. A sample placed between
texels _i_ and _i+1_ comes back from a linear sampler as `(1-f)·T(i) + f·T(i+1)`; choosing
`f = w(i+1)/(w(i)+w(i+1))` makes that precisely the two weighted taps the loop would otherwise have
fetched separately. The eighteen-tap level goes from thirty-five fetches to nineteen, and the frame
comes back identical to within half-float rounding — the sampler does the arithmetic either way,
and it does it for free.

It relies on the source being LINEAR filtered and the offsets being in texel units from a texel
centre. Both hold for the pyramid; a nearest-filtered source would silently snap every pair to one
of its two taps and narrow the kernel without any other sign.

**The wall gets two normal fields instead of one**, adapted from their `wall-normal.wgsl`. A single
field has to choose between being coarse enough to shape light across the wall and fine enough to
break up the specular, and it cannot be both. The large scale bends the diffuse over hand-sized
areas; a micro field seven times faster and nearly five times stronger is what stops the sheen
reading as a mirror sheet. Their constants (`0.22` / `7` / `1.05`), and the micro field is offset
so it does not correlate with the large one — sampling both at the same place makes them reinforce
at the same points, which is one field with an odd profile rather than two scales.

The specular reads the micro normal ALONE. It mirrors a small solid angle, so what it responds to
is the finest structure present; giving it the combined normal lets the large scale drag the whole
highlight around and the wall looks warped rather than rough.

Their slope limiter comes with it: `normalize(vec3(xy, 1))` silently rescales z, so a strong field
flattens itself and past a point more strength stops tilting the normal at all. Clamping the XY to
unit length and solving z from it keeps strength meaning something all the way up.

**`BeamConfig.revealSeconds`** opens the beam from its centre line on mount, from their
`beam-reveal.wgsl`. Opening outward rather than fading up in brightness, because the two read as
different events — a fade is a lamp being switched on, and these scenes are about a beam arriving.
The two uniform branches keep the ends exact: at zero the mask is zero rather than a residual
hairline down the axis, and at one it is one rather than a smoothstep that never quite closes. The
feather has a floor because the outgoing fan carries one flat profile per slice, so `fwidth` is zero
across a cell's interior and adjacent slices would otherwise step against each other.

Driven by SCENE time, so a still export stays reproducible — which does mean a scene that opts in
renders empty at `t = 0`. Default 0, so no preset changes.

**`SceneConfig.transmission`** (`"simple"` | `"cone"`), from their `transmission` example.

`"simple"` casts three rays at three indices and takes one channel from each — cheap, and what
every preset predating this was tuned against. `"cone"` casts eleven instead, on a golden-angle
spiral, each with its own index and a smooth RGB weight from three overlapping Gaussians.

Two things follow that three bins cannot express. Dispersion becomes a continuum rather than three
samples, so it stops fringing wherever refraction moves faster than a bin is wide. And roughness
SCATTERS: the spread goes as roughness squared, so a rough surface gathers light from an area
behind it instead of blurring whatever one ray happened to land on — the difference between
frosting and a dirty window. The disk rotation is hashed from the PIXEL, not from time, so the
pattern is stable frame to frame instead of boiling.

Worth knowing before turning it on: **its benefit scales with how much detail sits behind the
glass, and against a smooth plate it is very nearly inert.** Measured on `skewer` at dispersion
0.6 the two modes differ by 3/255 at the single worst pixel and not at all anywhere else, because
the lamp field it refracts is a soft gradient and eleven samples of a smooth function average to
what three samples of it already gave. On a busy plate the same test moves 32,000 pixels. The
reference gets more from it because it refracts a fully rendered scene; here the win arrives only
once the backdrop carries structure.

Default `"simple"`, and `prism` renders byte-identically with it.
