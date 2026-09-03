# Technique notes

How Materials3D renders, where it sits against existing work, and how it was calibrated. The API
is in the package READMEs; the studio in [apps/studio/README.md](../apps/studio/README.md).

## 1. Scope

A real-time renderer for scenes of shaped materials: glass, frosted, glitter, liquid, metal,
ceramic and plastic. Colour comes from bounded light sources behind the shapes, not from paint
applied to them. The reference behaviour: a row of
flat-ended glass rods on one horizontal axis, rolling in a staggered wave, with a warm-through-
magenta light field behind them and their bases lost in haze.

## 2. Prior art

### three.js

`MeshPhysicalMaterial` covers the standard PBR glass path: transmission with `thickness`, `ior`
and `roughness`; `dispersion` (r164, `KHR_materials_dispersion`); `attenuationColor` and
`attenuationDistance` for Beer-Lambert volume absorption. Materials3D hand-rolls all three inside
its own shader because its refraction source is the plate field rather than three's transmission
sampler. For one physically grounded glass material, use three's.

### drei `MeshTransmissionMaterial`

The closest neighbour. With three's shared transmission sampler, transmissive materials cannot see
other transparent objects, so drei offers a per-mesh backside buffer: render into it first, then
sample it in the main render. Materials3D applies the same idea per scene rather than per mesh: one
shared plate pass plus depth-validated sampling. Cheaper with many objects, less accurate per
object.

### Liquid-glass libraries

The libraries that followed WWDC 2025 are 2D effects over DOM content:

| project                           | approach                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZeroxyDev/liquid-glass-js`       | SVG displacement maps and native `backdrop-filter`, plus a spring-mass system; Chromium takes the native path, Firefox and Safari clone the content behind the glass |
| `rizroze/liquid-glass`            | three `feDisplacementMap` passes at slightly different scales, isolated with `feColorMatrix` and screen-blended                                                      |
| `PallavAg/liquid-glass-web-react` | a generated displacement map (red and green encode bend distance, blue a baked highlight, alpha the lens shape) sampled at three offsets for the chromatic fringe    |
| `ybouane/liquidglass`             | a WebGL fragment shader per element: refraction, chromatic aberration, Fresnel, specular, layered so an element sees the one below it                                |

All of them refract the page. Materials3D refracts a scene and does not sample the DOM. Two
choices are shared across that family and this renderer: three-tap channel-split refraction and
rim-loaded displacement.

### Hero-background packages

Vanta.js is the shape-of-product reference: drop-in animated WebGL backgrounds, roughly 120 kB
gzipped counting three, with guidance to use one or two per page and to set a fallback image or
colour. Materials3D borrows the ergonomics (`mountMaterials`, `handle.destroy()`) and not the
global `window.THREE` or the pinned three version.

## 3. Render passes

| #   | pass  | target    | contents                                                                        |
| --- | ----- | --------- | ------------------------------------------------------------------------------- |
| 1   | depth | `depthRT` | linear view depth packed across two channels; backdrop hidden                   |
| 2   | plate | `bgRT`    | the full scene with `uPass = 0`: glass samples the lamp field; depth in alpha   |
| 3   | main  | `colorRT` | the full scene with `uPass = 1`: glass samples `bgRT`                           |
| 4   | post  | screen    | depth of field, bloom, caustics, haze, vignette, grain, then the finish effects |

`measuredThickness` adds a back-face depth pass. `post.bloomMode: "pyramid"` adds a four-level
half-resolution bloom chain. `material.bend` adds a plate pass without the glass in it.

### Depth packing

```glsl
float d = clamp(vZ / FAR, 0.0, 1.0);
vec2 e = vec2(d, fract(d * 255.0));
e.x -= e.y / 255.0;              // decode: e.x + e.y / 255.0
```

`FAR` is 95. Both engines bake it in, and the decode is `e.x + e.y / 255.0`.

### The backdrop in the depth pass

The backdrop is hidden during the depth pass and the buffer is cleared to the encoded focal depth.
A backdrop far outside the focal range has the largest circle of confusion in the frame, so every
background pixel near a shape would gather that shape's colour and the frame turns to smeared
watercolour. Backdrops are smooth gradients and need no blur; pinning them to the focal plane
removes the bleed.

### Pass switching

The refraction texture must be unbound while pass 2 renders into it, or the driver reports a
framebuffer feedback loop:

```ts
private setPass(pass: 0 | 1): void {
  for (const item of this.items) {
    item.material.uniforms.uPass.value = pass;
    item.material.uniforms.tBg.value = pass === 1 ? this.bgRT.texture : null;
    item.material.uniforms.tPlain.value = pass === 1 ? this.plainRT.texture : null;
  }
}
```

### Taps

`quality` sets the post pass's gather counts: 24 depth-of-field taps at 0.85 and above, 16 at
0.6, 10 below; 10 caustic taps at 0.6 and above, 6 below. The post shader is recompiled when the
count changes, which is why `quality` is a structural change in `setConfig`.

It also scales the scene passes' render targets, and above 1 that is supersampling: they render
larger than the canvas and the post pass resolves them back down. That is worth knowing about for
edge quality specifically. The main pass is multisampled, but the depth of field derives its blur
radius from the DEPTH target, which is packed into two channels and sampled nearest — it cannot be
multisampled, because interpolating the low byte of two depths decodes to a distance that is in
neither. The radius is pre-filtered over a 3x3 to take the worst of that off, but only rendering
the depth larger antialiases it outright.

## 4. The lamp field

```glsl
vec4 plate(vec2 p){
  vec3 c = vec3(0.0); float a = 0.0;
  for (int i = 0; i < MAX_LAMPS; i++){
    if (i >= uLampCount) break;
    vec2 d = p - uLamp[i].xy;
    float w = exp(-dot(d, d) / max(uLamp[i].z * uLamp[i].z, 1e-6)) * uLamp[i].w;
    c += uLampCol[i] * w;
    a += w;
  }
  float amt = 1.0 - exp(-a * uLampGain);
  amt = smoothstep(uLampLo, uLampHi, amt);
  return vec4(c / max(a, 1e-4), amt);
}
```

Returns a colour and a coverage. `MAX_LAMPS` is 12; the loop breaks at `uLampCount`, so unused
slots cost nothing.

The gate (`lampGate.lo`, `lampGate.hi`) cuts the Gaussian tails to zero. Without it every lamp
reaches every shape and nothing reads as clear. With it, coverage no longer has to be dialled down
globally, so the tinted regions can be more saturated.

`backdropLamps` draws the same field on the backdrop at a low weight (0.05 in the default config).
Colour that appears only inside glass reads as tint; a faint presence in the gaps reads as light
behind the glass.

## 5. Refraction into the backplate

Each fragment casts a refracted ray at a plane behind the scene and samples the lamp field where
the ray lands:

```glsl
vec4 backplate(vec3 ro, vec3 rd){
  float dz = min(rd.z, -0.04);   // never divide by a ray parallel to the plate
  vec3 h = ro + rd * ((uPlaneZ - ro.z) / dz);
  return plate(h.xy / uPlateScale + uPlateOffset);
}
```

`transmission: "simple"` casts three rays at `1/ior - dispersion`, `1/ior` and
`1/ior + dispersion` and takes one channel from each. `transmission: "cone"` casts `CONE_SAMPLES`
rays across the same spread with smooth spectral weights and widens the cone by `roughness`
squared, so frosted glass gathers from an area behind it.

`plate.z` sets the distance of that plane. Far back, each shape acts as a full lens and smears the
whole gradient across its width as rainbow banding. Close in (the default is -3) the hit point
tracks position and refraction reads as distortion of a continuous field.

## 6. Rim-loaded displacement

In the main pass the screen-space sample is displaced by the view-space normal, weighted toward the
silhouette:

```glsl
vec2 off = vec2(vVN.x / uAspect, vVN.y) * uLens * pow(1.0 - ndv, 1.35) * 3.4;
```

Uniform displacement reads as frosted. Edge-loaded displacement, a near-flat window in the middle
and hard bending at the rim, reads as cut glass.

At the centre of a convex solid the normal points at the camera and the offset is zero. That is
right for a plate and wrong for a sphere, which is thickest in the middle. Two material fields
cover that case:

`bend` refracts the view ray at the surface, walks it the measured thickness (so it needs
`measuredThickness`) and projects the exit point, then samples a plate rendered without the glass
in it, because a ray near the centre of a convex solid lands inside that solid's own silhouette:

```glsl
if (uBend > 0.0 && uThick > 0.5){
  float backZ = dec(texture2D(tBack, clamp(suv, vec2(0.0), vec2(1.0))).rg) * FAR;
  float thick = max(backZ - vVZ, 0.0);
  if (thick > 0.0){
    vec3 inside = bendDir(V, N, 1.0 / max(uIOR, 1.0));
    vec4 exitClip = uViewProj * vec4(vW + inside * thick, 1.0);
    vec2 traced = ((exitClip.xy / max(exitClip.w, 1e-5)) * 0.5 + 0.5) - suv;
    off = mix(off, traced, uBend);
    vec4 plain = texture2D(tPlain, clamp(suv + off, vec2(0.002), vec2(0.998)));
    base = mix(base, plain.rgb, 0.94 * uBend);
    bentPlate = uBend;
  }
}
```

Displacement is bounded by the solid's own size on screen, so `bend` does not magnify. `magnify`
follows the refracted ray to the lamp field instead, which does; it reads the analytic field, so it
sees no other glass:

```glsl
if (uMagnify > 0.0){
  vec3 through = bendDir(V, N, 1.0 / max(uIOR, 1.0));
  base = mix(base, backplate(vW, through).rgb, uMagnify);
}
```

`tracedRefraction` is the third path: a convex lathe of 3 or 4 sides intersects the refracted ray
against its own bounding planes, which yields the exact exit point and the exact path length.
`backGlassStrength` adds the inner interface on top, with the far faces returning studio light.

## 7. Depth-validated sampling

Plain screen-space refraction ghosts the silhouette: every fragment displaces by a similar offset,
so shapes sample other shapes in front of them and reproduce their outline. The plate pass stores
linear depth in alpha and the main pass rejects any sample nearer than the fragment:

```glsl
vec4 smp = texture2D(tBg, clamp(suv + off, vec2(0.002), vec2(0.998)));
dbgGuard = step(vVZ - 0.30, smp.a * FAR);
base = mix(base, smp.rgb, 0.94 * dbgGuard * (1.0 - bentPlate));
```

`bentPlate` is the share `bend` has already taken from the glass-free plate. Validation is what
lets the blend weight sit at 0.94; without it the usable weight was about 0.58.

## 8. Absorption

Beer-Lambert along a chord. For a cylinder the path through the glass along the view ray is
`2R · (N · V)`: longest down the barrel, zero at the rim.

```glsl
float chord;
if (tracedPath > 0.0){
  chord = tracedPath;
} else if (uThick > 0.5){
  vec2 duv = (vProj.xy / vProj.w) * 0.5 + 0.5;
  float backZ = dec(texture2D(tBack, clamp(duv, vec2(0.0), vec2(1.0))).rg) * FAR;
  chord = max(backZ - vVZ, 0.0) * pow(max(ndv, 0.02), -0.6);
} else {
  chord = 2.0 * uPath * pow(ndv, 0.40);
}
float trans = (1.0 - exp(-uSigma * chord)) * amt;
```

Three sources for the chord, in priority order: the traced path through a convex solid's faces
(`tracedRefraction`), the measured thickness from the back-face depth pass (`measuredThickness`),
and the analytic cylinder chord from `material.path`.

`pow(ndv, 0.40)` replaces the true `ndv`. The true chord falls off so fast at the silhouette that
it leaves a wide white rim and a thin coloured core; the exponent holds the path across the barrel
and collapses it only at the edge. The measured branch multiplies by `ndv^-0.6` so a rod gives the
same curve through either path.

`material.path` is half the optical path at normal incidence: the radius of a rod, half the
thickness of a disc. It was once called `radius`. Passing a disc's radius where its half-thickness
was meant saturates absorption and renders the disc as opaque plastic. `defaultPath(shape)`
derives it from the geometry (`thickness / 2` for a disc or ring, `depth / 2` for an extrusion,
`min(r, len / 2)` for a prism), so a scene has to set it to get it wrong.

`material.absorption` replaces the shared coefficient with a per-channel one:
`exp(-absorption · chord)`. Colour then deepens with the path and owes nothing to the lamps. The
`prism` preset uses it on a black wall with no lamps at all.

## 9. Colour as light

The composite `mix(white, tint, absorb)` is a pigment model: it darkens as it saturates. The shader
takes the lamp's chroma and keeps the brightness of what is behind:

```glsl
vec3 hue = lit / max(max(lit.r, max(lit.g, lit.b)), 0.001);
hue = mix(lit, hue, 0.55);
vec3 col = base * mix(vec3(1.0), hue, trans);
col += lit * trans * uEmis;
```

Full chroma normalisation turns smooth gradients into hard posterised patches. 0.55 is the blend
that does not.

## 10. Bloom

A bright-pass does nothing against a near-white backdrop, where the background is the brightest
thing in frame. The gather bloom weights by saturation:

```glsl
float sat(vec3 c){ return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
```

`bloomMode: "gather"` takes that gather at one radius in the same golden-angle loop as the depth
of field. `bloomMode: "pyramid"` thresholds highlights and blurs a four-level half-resolution
pyramid, which is what a light source looks like as opposed to a bright object. The `prism` preset
uses it, and `dust` needs it.

## 11. Colour space

The whole pass chain is authored in display (sRGB) space and three's colour management is bypassed
for it. The look was calibrated in display space; moving Beer-Lambert and the gathers into linear
changes their character. Colours are hex strings written to uniforms without conversion. A
`THREE.Color` set from a hex is linear and reads washed out. `METAL_F0` and `METAL_F82` are quoted
in 8-bit sRGB for the same reason.

## 12. Shapes

Almost every primitive is a lathe: a 2D profile swept about Y. The profile gives rods, discs,
cones, spheres, rings and droplets; the segment count gives prisms, since a hexagon is a lathe
with `sides: 6`. `arrow`, `slab` and `path` are extrusions. `blob` is a sphere with seeded
low-frequency lumps baked into its vertices. A prism with `bevel` set swaps the lathe for a mesh
that rounds every edge.

Ends are flat with a small fillet, not hemispherical. The fillet catches the rim highlight, and a
flat face reads as an ellipse when tilted, which a capsule loses.

### Outlines

`path` takes SVG path data (the `d` attribute) or a whole `.svg` document, from which every
`<path>` is read in document order. `transform` attributes are ignored.

- Y is flipped: SVG grows downward, three grows up.
- The drawing is scaled about its bounding-box centre until its longer half-extent is `r`, so `r`
  resizes it like any other kind.
- The first subpath is the outline; every later one is a hole. `cuts` apply on top.
- The default bevel is sized from the outline's narrowest limb, not its bounding box, and one
  bevel serves the whole outline. A negative `fillet` turns it off; `0` picks a proportional one.
- A `path` shape can be a `beam` target, convex or re-entrant. The tracer clips convex
  cross-sections by half-planes (Cyrus-Beck) and scans anything else edge by edge; a ray may leave
  a notch and re-enter the same solid. Outlines are simplified first (Douglas-Peucker), and a
  self-crossing outline is refused, since it has no defined inside.
- `path` gets the screen-space refraction, not the traced one: the tracer needs bounding planes,
  which only a `prism` or `hex` can supply.
- `defaultPath` is `depth / 2`, so the analytic chord resolves to the depth face-on.
- `MAX_OUTLINE` caps the `d` string at 4000 characters, because a scene travels as base64 in a
  share link.

### Carve-outs

Shapes with a flat profile take `cuts`: `rect` (a corner radius at half the short side makes it a
slot) and `circle`. Honoured by `slab`, `arrow` and `path`, and by `disc`, `prism` and `hex`, which
swap their lathe for the equivalent extrusion when they carry cuts. Ignored by `rod`, `sphere`,
`cone`, `ring`, `droplet` and `blob`, whose profiles sweep. At most `MAX_CUTS` (8).

Cuts go all the way through. Thickness is measured as back-face depth minus front-face depth, so
a hole open at both ends draws nothing, like `ring`. A blind pocket would leave both faces intact
and report the cavity as solid glass.

## 13. Motion

Motion belongs to the shape (`motion`, `phase`), not the scene. A `scatter` block stamps one
motion onto every generated shape and spaces `phase` by `stagger`.

- A lathed shape spun about its own axis of symmetry is invisible: the normal distribution is the
  same every frame. `skewer` rolls about X while the profile sweeps about Y.
- Rotation about a horizontal axis should read as foreshortening. At a wide field of view
  off-centre shapes lean and the motion reads as tumbling. The reference framing is 12° from 44
  units.
- `stagger × count` must span a full turn. At `stagger ≈ 2π / count` the phases distribute evenly
  and the trough of the wave travels; well below that the phases cluster and the trough sits still.
- `loopSeconds` snaps every rate to a whole number of cycles over the loop, with a floor of one
  cycle, so a recorded clip closes.

## 14. Calibration

Art-directing by eye overshot repeatedly, so the measurement ships as a tool:

```bash
pnpm calibrate reference.png render.png [--box x0,y0,x1,y1] [--step n]
```

PNG only, 8-bit and non-interlaced, which is what `canvas.toBlob("image/png")` writes. The
default box is the middle 70% of the frame, sampled every 5 pixels.

Clear-glass ratio: the fraction of sampled pixels with saturation below 0.18 and lightness above
0.72, which reads as clear glass. The reference measured 43%; successive builds measured 27%, 34%,
37% and 44%, and each had looked about right by eye. When the ratio is off, the lamp gate is the
first knob to move, then density.

Hue histogram of the saturated pixels (saturation at or above 0.25, lightness between 0.15 and
0.92), as measured on the reference:

| hue      | share |
| -------- | ----: |
| 0-20°    | 10.0% |
| 20-40°   | 19.3% |
| 40-60°   |  9.9% |
| 60-80°   |  1.8% |
| 220-280° |   21% |
| 300-320° |  7.3% |
| 320-340° | 13.2% |
| 340-360° |  8.7% |

No cyan. The palette was derived from that distribution; a cosine palette sweeping the full hue
circle was wrong on the evidence. The studio's lamp shuffle draws from the same bands.

## 15. Known limits

Listed in the [README](../README.md#known-limits): no cast shadows between shapes (the wall mode
has a contact shadow), refraction bounded by the frame, screen-space caustics, 12 lamps, four
passes per frame, no CSG, no DOM refraction, display-space colour.
