---
"@materials3d/core": minor
---

Traced light beams, spectral colour, tone mapping and HDR colour targets — plus a `prism` preset
built on all four.

Everything this renderer did until now was a distortion of the plate: colour that already exists
behind the glass, sampled in screen space and bent by the surface normal. A beam is not that. It
has its own geometry, its exit angle differs per wavelength, and it keeps travelling after it
leaves the glass, so there is nothing behind it to sample.

**`SceneConfig.beam`** adds one. Set it and the renderer traces a ray per wavelength from the
source, refracts it into the cross-section, across it and out, and emits the result as an additive
mesh drawn in the main pass. Absent, nothing changes.

The optics are physical rather than decorative, and adapted from Vercel's `vgpu` prism background
(MIT — see `THIRD-PARTY-NOTICES.md`):

- **Fresnel transmittance** at both boundaries, folded into vertex intensity, so a beam nearing the
  critical angle dims into total internal reflection instead of vanishing.
- **CIE 1931 colorimetry** weighted by the D65 daylight spectrum and the eye's photopic response.
  Green is inherently brighter than violet, as in a real spectrum; a hue ramp gives every
  wavelength the same peak energy and reads as a cartoon rainbow.
- **A connected fan.** The outgoing sheet spans adjacent wavelengths rather than stacking
  independent ribbons, so colour interpolates in the rasterizer and cannot band.
- **Spectral density.** Vertex brightness is flux over the angular-spread Jacobian, so the fan
  brightens where wavelengths crowd and dims where they spread, and total energy is invariant
  under subdivision.

**`PostConfig.toneMap`** (`"none"` | `"neutral"` | `"aces"`) is new and useful well beyond the
beam. `"none"` is the default and clamps per channel, which is what every preset predating this was
calibrated against. It is also the wrong answer for any scene carrying additive light above 1:
clamping independently drives bright colour to a primary, so a spectrum clips into magenta/cyan/
yellow bars. `"neutral"` is the Khronos PBR curve — it compresses the peak and desaturates toward
it, keeping hue.

**`MaterialConfig.absorption`** — optional per-channel Beer-Lambert absorption. Absent, nothing
changes and glass keeps taking its chroma from the lamp field behind it. Present, the transmitted
colour becomes `exp(-absorption · path)` per channel.

The default model has two limits this lifts. It cannot express the most recognisable property of
coloured glass — thick parts more saturated than thin ones — because the tint does not depend on
the optical path at all. And a shape in a dark scene has nothing to take colour FROM, so the scene
has to invent lamps purely to give the glass something to borrow. The `prism` preset now runs with
`lamps: []`, which was not previously expressible.

Absent stays absent deliberately: zero absorption is a real material (perfectly clear), so a
default would make "clear" and "not asked for" the same thing and silently switch every existing
preset off its lamp-derived tint.

**A `wall` background mode.** A lit surface rather than a painted ramp, adapted from the
reference's `wall-common.wgsl`: a value-noise material with derived normals, a global light term
shaped by their pivoting contrast curve, their exposure composition, and a contact shadow where the
glass meets the wall. Their constants are ported (`shadowContrast 6.85`, `shadowPivot 0.9`,
`shadowFloor 0.87`, `normalStrength 0.6`, `ambientFill 0.42`).

Two inputs are NOT ported and are analytic stand-ins: the reference samples a baked material
texture and a GPU-baked global light mask, neither of which is portable without its bake pipeline.
Worth knowing when tuning — the contrast curve pivots at 0.9 and crushes everything below it, so a
mask that falls off quickly lights nothing at all.

**`SceneConfig.tracedRefraction`.** Refract the view into a convex solid and trace it against the
solid's own faces to find where it really leaves, then project THAT point and sample there —
instead of displacing the sample by a rim-weighted surface normal. Adapted from `glass.wgsl`.

The offset it replaces is very nearly exact for a rod, whose surface curves smoothly and whose exit
is always roughly opposite the entry. For flat faces meeting at hard edges it is not: the refracted
ray can leave through a different face entirely. Tracing also returns the true optical path length,
so Beer-Lambert stops guessing a chord. Off by default; only convex lathes qualify.

One trap worth knowing: three declares `projectionMatrix` in its VERTEX shader prefix only, so a
fragment shader that names it fails to compile — and the shapes then vanish while every other
material keeps drawing. The view-projection is passed explicitly.

**Caustics.** The beam drawn a SECOND time over the same geometry, as light landing on the wall.
Adapted from `caustic.wgsl`, and three details make it read as a lit surface rather than a doubled
beam: the response saturates (`1 - exp(-energy·strength)`) so it approaches full coverage instead of
blowing out; its falloff scales are 0.12 on the rate and 0.5 on the power, so it is still going
where the beam's own glow has died; and it washes toward neutral with distance, because a real
caustic loses its separation as it spreads. Drawn at the same depth as the beam deliberately — the
reference notes that splitting the depths tears the mesh, since shared entry and exit vertices then
project to different pixels under perspective.

**`SceneConfig.studio`** (`"gradient"` | `"softbox"`) is also new and general. `"gradient"` is the
existing bright-ceiling/dark-floor ramp that metals fall back on, and stays the default.
`"softbox"` is a sparse analytic three-panel room — back wall, centre fill, cool key — and it now
feeds GLASS reflections too, which it never did before. On a dark backdrop the lamp plate reaches
almost none of the hemisphere a surface sees, so without a room to reflect, glass renders as a flat
silhouette with no faces. `studioGain` scales it.

**`PostConfig.bloomMode`** (`"gather"` | `"pyramid"`) and `bloomSpread`. `"gather"` is the original
saturation-weighted golden-angle gather taken inside the DOF loop — cheap, single-radius, and the
right answer for a pale studio. `"pyramid"` thresholds highlights with a soft knee and blurs a
four-level half-resolution pyramid separably, then recombines. A real halo spans several octaves at
once and a single-radius gather has to pick one of them; this is the difference between a bright
object and a light SOURCE. Costs eight render targets, so it is opt-in.

**`SceneConfig.dust`.** Sparse airborne dust: screen-facing quads whose seed selects one of four
progressively rarer populations (powder, flakes, motes, defocused bokeh), sized in PIXELS rather
than world units so near and far grains behave the way real dust does. Requires
`bloomMode: "pyramid"` — that pyramid is the light field it reads.

Four details of the reference's `dust.wgsl` are load-bearing, and three of them are about WHERE in
the frame it draws rather than what it draws:

- **Drawn after the tone map,** over the finished frame, and each grain tone mapped and encoded on
  its own. A mote is a point of light in its own right, not part of the scene beneath it: mapping
  the sum instead compresses every grain together with whatever it lands on, which crushes exactly
  the motes sitting on the beam — where they are brightest and most worth seeing — and puts them
  through the depth of field besides, smearing specks that should be pixel-sharp.
- **Lit by an UNTHRESHOLDED field,** an 8×8 area filter reducing the scene straight to a sixteenth
  in one step rather than a walk down the bloom chain. Everything in that chain has been through
  the bright-pass, so it is sparse and dim, and the response raises it to the 5.5th power — which
  takes a diluted 0.2 down to 0.00007 and lights nothing. Reducing in one step also leaves the
  intermediate levels alone, and the composite still needs them.
- **The field is linearized as it is built,** per tap, before the average. This renderer's working
  space is display-referred — a preset's sRGB hex is used as-is and written out as-is — and the
  reference's is linear radiance. `1 - exp(-b · 82)` has its knee around 0.012, and an ordinary
  near-black backdrop sits at 0.03 display, which lands _above_ it: without the decode the backdrop
  itself lights every grain in the frame. The decode applies on the display range ONLY, since the
  target is HDR and the curve is defined on [0,1] — feeding a beam value of 500 to the transfer
  function returns 2.6 million, and the blur then spreads a number that size everywhere.
- **Hue from a mid bloom level, brightness from the field.** Two textures on purpose: the field is
  broad enough to say whether light reaches a grain and far too broad to say what colour it is, so
  taking hue from it smears a mote's tint across everything nearby.
- **A saturating response, `1 - exp(-b · 82)`, with no threshold,** so weak samples fade off
  continuously rather than drawing a hard particle halo at the edge of the light volume.

One trap specific to porting a WGSL shader to GLSL: a screen uv and a texture uv share an origin
at the top left in WGSL, and `texture2D` has it at the bottom left. Handing the grain's screen uv
straight to the sampler reads the light field mirrored about the horizontal midline, so grains
light up in the _reflection_ of the beam — the dark half of the frame fills with specks while the
lit half stays bare. It looks like a tuning problem and is not one.

Grains are also clipped against the glass — per fragment, not per grain, so a large defocused bokeh
straddling the silhouette is cut along the edge instead of being kept or dropped whole on where its
centre lands.

**Multisampled colour targets.** `antialias: true` on the renderer covers the default framebuffer
only; render targets get none unless asked. Invisible for glass, whose silhouettes are large and
smooth — and ruinous for a beam, whose fan is made of long sub-pixel wedges near the exit face.
Enabled on the same switch as HDR.

**HDR colour targets.** When `toneMap` is not `"none"`, `colorRT` and `bgRT` are allocated as
half-float. Without this the tone map is applied too late to matter: the main pass writes into an
8-bit target and over-range colour is destroyed before post ever samples it. Byte targets remain
the default, so existing presets are untouched.

The beam's geometry, falloff and scale are ported from the reference rather than re-derived, and
three of those details are load-bearing in ways that are invisible until they are wrong:

- **Rays terminate on a WALL rectangle** (`rayToWallBoundary`) whose half-extents are walked from
  the frustum, not after a fixed distance. The exposure that balances the picture is a function of
  how far the light travels before it stops, so the reference's constant only means anything
  against a wall of a particular size.
- **Spectral density is measured one world unit DOWNSTREAM** of the exit face, never at it.
  Adjacent wavelengths leave from nearly the same point and differ in angle, so the spread at the
  face is ~0 and the density that divides by it diverges.
- **Longitudinal falloff.** `1 / (1 + 3.8·t)^3.7` over a travel normalized 0 at the glass to 1 at
  the wall — around a 280× dilution across the frame. This is most of what makes a fan read as
  light spreading out rather than as a painted stripe.

**The beam follows a SHAPE, not a copy of one.** `BeamConfig.target` names the item the beam
refracts through, and the cross-section is derived from that item — `radius`, `sides` and
`rotation` are then ignored. They described the same solid the item did, and keeping the two in
step by hand is the easiest way to get a scene that is quietly wrong: change the item's kind and
the beam keeps refracting through the shape it used to be, with the light bending at the vertices
of a triangle no longer on screen.

The tracer was always shape-agnostic — it refracts against edges, and a circle is a polygon with
enough of them — so this is all a sphere needed to disperse light properly. What it could not do
is guess: `sides` counts FACES on a prism and radial SEGMENTS everywhere else, so `crossSectionFor`
reads the two kinds differently and everything round becomes a smooth ring.

**A chain of solids.** `targets` takes a LIST, and the beam crosses all of them — in whatever
order it happens to reach them, since the tracer finds the next solid rather than being told. What
arrives at the second shape is therefore not a white beam but a fan that has already separated, and
every wavelength then refracts on its own terms: the spectrum widens at each crossing instead of
being made once and carried. Each solid brings its own index of refraction from its material, so a
scene can stand flint next to crown.

The mesh had to learn the same distinction. Up to the first exit every wavelength still overlaps
every other, so the beam is one white-summing ribbon per wavelength; past it they have visibly
separated, and the air gaps between solids and the interiors of the later ones alike are drawn as
fans spanning adjacent wavelengths — the only topology that interpolates a spectrum instead of
banding it. With one solid that reduces exactly to what it always drew, byte for byte.

**`crossSectionFor` no longer guesses.** It returned a circle for six of eleven shape kinds, and
for a `ring`, `slab`, `arrow` or `blob` that is not a rough approximation but a different solid —
an annulus has a hole the light should cross, and the extrusions are not lathes at all. It now
returns undefined for those and the renderer skips them, which matters more than tidiness: the
tracer's clipping assumes convexity, so a non-convex outline does not merely look wrong, it reports
crossings that are not there. A `cone` is sliced at its half-height rather than its base.

**`BeamConfig.entryAngle`** is the aiming handle that goes with it: where the beam strikes, in
degrees around the cross-section. `face` plus `entry` stay the natural handles on a faceted solid
and are useless on a round one — a circle is traced as ninety-six facets under four degrees each,
so a face index picks one of them and `entry` slides the impact point within it, leaving the
pointer nothing to drive. An angle is continuous, means the same thing on a triangle and a circle,
and does not change what it points at when the subdivision does. Both parameterizations produce a
byte-identical frame for the `prism` preset.

Aiming by angle can land exactly ON a vertex — 30° is one on a hexagon at this rotation — and a
beam striking a corner physically splits between two faces, which the tracer does not model: it
follows one and the other half goes missing. The impact point is therefore held clear of both
corners by the beam's own footprint, which grows as 1/cos(incidence).

**`defaultSides`.** `sides` means faces on a `prism` and radial segments everywhere else, and a
three-segment sphere is a triangular bipyramid rather than a low-poly sphere. `createShape` now
picks per kind, and the studio re-derives the field when a kind change crosses the faceted/round
boundary — only then, so a deliberate eight-segment sphere survives a trip through `rod` and back.
Items also gained a `sides` slider, which they never had: the field was editable on scattered
shapes only, so the carry-over could not be undone by hand.

Traced refraction had the same confusion. `applyPrismPlanes` read `shape.sides` for a `hex`, whose
builder ignores the field and always lathes six — so the glass refracted a triangle inside a
visible hexagon.

**Two interaction targets, `beamIncidence` and `beamEntry`**, so the pointer drives the beam on
both axes: vertical swings the source, horizontal slides the point of impact along the entry face.
They are the only scene targets that are not uniform writes — the beam is solved on the CPU, so
driving them forces a retrace, guarded by a key so a still pointer costs a string compare.

Those two axes are independent only because incidence is measured **from the entry face's normal**
rather than from world space. A world-space angle couples them: sweeping it slides the entry point
along the face, and the usable range collapses to about a degree and a half. From the normal, the
prism stays put, the source swings around it on a fixed radius, and the range opens to the whole
face. `BeamConfig` therefore takes `face`, `incidence` and `entry` instead of a position and an
angle.

The incidence range deliberately crosses the critical angle. Below it the beam cannot leave through
the exit face and totally internally reflects, bouncing inside the glass; above it the full spectrum
leaves as a fan. Fresnel makes the handover continuous rather than a snap. The tracer follows the
bounces, so the shallow half of the sweep renders light visibly moving _inside_ the prism.

**`cameraYaw` and `cameraPitch`** join them: the same pointer position swings the view a few
degrees. Additive over the drag-orbit rather than replacing it, so a scene can have both. The light
sheet is fixed in world space, so this changes only its projection — which is the point, since what
reads is the parallax between the beam, the prism and the dark behind them. Both are in degrees;
`pitch` is a height factor internally and the conversion happens at the edge, because degrees are
the only unit anyone can choose a range in.

**`SceneConfigInput`.** `ensureSceneConfig` took `Partial<SceneConfig>`, which makes the optional
blocks optional but still demands them complete — so `{ beam: { incidence: 41 } }`, the obvious
thing to write and something the normalizer has always accepted, did not typecheck. The input type
now deep-partials `beam` and `dust`.

**Retrace cost, and why a round shape used to be worse.** A retrace casts `samples × (slices + 2)`
rays — 3,328 at the shipped settings — and each walks the outline two to four times. On a triangle
that is nothing. A sphere is traced as seventy-two edges, and the same walk is then twenty-four
times as long, which is why switching the shape made the pointer feel heavy. Measured on
`buildLightSheet` alone, a 72-gon went from 11.1ms to about 3.7ms and the triangle from 5.0ms to
about 1.9ms, with the `prism` preset rendering byte-identically throughout. Four changes, in
descending order of what they were worth:

- **An angular fast path.** The cross-sections are regular polygons about the origin, so where a
  ray crosses the CIRCUMCIRCLE — a two-term quadratic — bounds where it can cross the polygon
  inscribed in it. Five edges are tested either side of each crossing instead of seventy-two. It is
  exact when the window holds the right edge: at the true entry the ray is inside every half-plane,
  so no other edge can report a larger `t`, and a max over any subset containing the right one is
  the max over all of them. Whether it did is checked by asking if the crossing lands between that
  edge's endpoints, which is cheaper than proving the window's bounds; a miss falls back to the
  full scan, so correctness never depends on the window being right. `preparePolygon` takes an
  opt-out purely so the two paths can be tested against each other.
- **Typed vertex scratch, kept between retraces.** The mesh was built by nine `Array.push` calls
  per vertex into five growing arrays — around 170,000 per retrace. Written by index into buffers
  that outlive the call, a steady pointer sweep now allocates nothing there.
- **Loop-invariant work hoisted.** `tracePrism` derived the winding sign per RAY, an O(edges) pass
  in front of an O(edges) trace, and normalized each candidate edge normal on every hit test. Both
  are properties of the outline, and `preparePolygon` computes them once per sheet.
- **In-place Snell and mirror**, and one fresh position per surface rather than two, which halved
  what the garbage collector had to chase.

Two things made the retrace affordable. The tracer fills slice boundaries lazily — the full-width
internal strip needs two of them, not twenty-five — and the mesh writes into its existing buffers
instead of allocating a `BufferGeometry` per frame. Measured at 1600×900: a frame with the pointer
moving went from 32.7ms to 5.0ms, against 4.6ms for a static frame.

**A `cascade` preset** is the demonstration of the chain: one beam threaded through a hexagon, a
sphere and a triangle, dispersing further at each. Three kinds on purpose — a face count, a segment
count and a rotation are the three cases the outline code has to get right, and a mistake in any of
them is obvious here in a way it is not with a single shape, because the light has to arrive
somewhere specific to keep going.

Worth knowing before retuning it: a chain is FRAGILE where one prism is not. Aim a single prism a
few degrees differently and the fan moves; aim a chain a few degrees differently and the light
misses the second shape entirely, and the effect collapses back to one prism with nothing to
indicate it. The scene is arranged around that rather than despite it — the solids are large and
close enough that the beam cannot fall between them, and **`BeamConfig.entrySweep`** narrows the
pointer's travel from the default 90° to the 26° this arrangement tolerates. `lightSheet.test.ts`
pins the route across the whole sweep, and pins that the wavelengths stay on one topology, which is
what lets the fan interpolate.

It also carries a key, a rim and a fill, where `prism` has no lamps at all. That preset can do
without them because it is ONE solid on the camera axis, described entirely by the studio
reflecting off faces nearly square to the view; three solids strung across the frame are seen at a
glance, overlap in depth, and with only the studio to go on the sphere in the middle is a black
disc against a black wall. The cool key sits up and left, away from where the fan opens, so it
lights the prism's near edge without competing with the spectrum; the warm rim sits low and right,
behind the solid the light enters. `backdropLamps` stays at a whisper — much more and the black
stops being black, and the dust, which reads the scene's own brightness to decide where a grain is
lit, starts glowing in the empty corners instead of along the beam.

Its glass also runs `rim: 0.15` where the `prism` preset runs 1.35. That preset's shape sits on the
camera axis and presents its faces almost square to the view; these sit out at the edges of the
frame and are seen at a glance, where a strong Fresnel rim covers most of their width and every
solid reads as a white cutout instead of as glass. The brightness climbs smoothly with the
off-axis angle — measured 63 to 135 mean over a 0 to 0.9 sweep — so it is the view, not a defect.

One genuine bug found alongside it: `applyPrismPlanes` ran BEFORE the item's pose was copied onto
its mesh, so the traced-refraction planes were derived from the shape's previous transform. It
never showed with a single static shape at the origin and would have with anything moving.

The `prism` preset is the demonstration. Worth knowing if you retune it: the entry angle is eight
degrees above horizontal and that is load-bearing. Level or downward puts the internal ray past the
critical angle at the exit face, so the violet half of the spectrum reflects out through the base
while the red half leaves normally and the rainbow splits into two unrelated streaks.
`lightSheet.test.ts` pins it, along with the subdivision-invariance of the density term.
