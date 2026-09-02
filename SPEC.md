# Materials3D — technique notes, prior art, and packaging plan

Working notes for turning the refractive-glass renderer into a published package,
structured to mirror `wave3d` (pnpm monorepo, `core` / `react` / `element`, a
browser studio, poster-first loading).

Two things this document tries to do honestly: record _why_ each technique is the
way it is — including the several approaches that looked right and weren't — and
place the work against what already exists, so the README can make a claim that
survives contact with someone who knows the field.

---

## 1. What it is

A real-time renderer for scenes made of refractive glass shapes, where the colour
comes from bounded light sources _behind_ the glass rather than from tint applied
to the glass itself. Built for hero sections and product visuals: near-white
studio backdrop, shallow depth of field, saturated cores against genuinely clear
regions.

The reference behaviour it was reverse-engineered from: a row of flat-ended glass
rods threaded on a single horizontal axis, rolling in a staggered wave, with a
warm-through-magenta light field behind them and their bases lost in haze.

---

## 2. Prior art

### 2.1 three.js built-ins

`MeshPhysicalMaterial` covers a large part of this natively now, and any honest
README has to say so.

- **Transmission** with `thickness`, `ior`, `roughness` — the standard PBR glass path.
- **Dispersion** — a `dispersion` property was added to `MeshPhysicalMaterial` in three.js r164, implementing `KHR_materials_dispersion`. Before that, per-channel IOR splitting had to be hand-rolled, which is what Materials3D still does.
- **`attenuationColor` / `attenuationDistance`** — three's Beer–Lambert volume absorption. This is _exactly_ the effect Materials3D implements manually, and users hit the same conceptual wall: the expectation is colour that is clear near the edges and stronger toward the centre of a volume, which only behaves that way for closed geometry with real thickness.

**Implication for the package:** Materials3D should not pretend to invent volume
absorption or dispersion. Its claim is the _scene-level composition_ — the lamp
field, the multi-pass inter-object refraction, and the calibrated post stack —
not the BSDF.

### 2.2 drei's `MeshTransmissionMaterial`

The closest thing to a direct competitor, and worth studying because its API
documents the real trade-offs.

- Each material can own a private FBO, or share three's global transmission sampler. With the shared sampler, transmissive materials cannot see other transparent or transmissive objects — which is precisely the limitation Materials3D's two-pass approach exists to work around.
- It offers an optional **backside** pass: render into the backside buffer first, then prepare the material for the main render using that buffer. Same structural idea as Materials3D's plate pass, applied per-mesh rather than per-scene.
- Refraction samples default to 6, with separate resolution controls for the main and backside buffers.

**Implication:** the "render the scene twice so glass can see glass" idea is
established art. Materials3D's variation — one shared scene-wide plate pass plus
depth-validated sampling — should be described as a trade (cheaper with many
objects, less accurate per-object) rather than as novel.

### 2.3 The "Liquid Glass" family

After WWDC 2025 a large cluster of libraries appeared. Nearly all of them are
**2D UI-layer effects over DOM content**, not 3D scene renderers:

| Project                           | Approach                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZeroxyDev/liquid-glass-js`       | Refractive displacement maps plus a spring-mass system, built on SVG filters and native `backdrop-filter`; Chromium uses the native path while Firefox and Safari fall back to cloning the content behind the glass |
| `rizroze/liquid-glass`            | Three separate `feDisplacementMap` passes at slightly different scale values, each isolated with `feColorMatrix` and blended back with screen mode                                                                  |
| `PallavAg/liquid-glass-web-react` | Generates a displacement map on the fly where red/green encode bend distance, blue carries a baked specular highlight, and alpha is the lens shape; three displacement taps produce the chromatic fringe            |
| `ybouane/liquidglass`             | WebGL fragment shader per element doing refraction, chromatic aberration, Fresnel reflection and specular highlights, with layered compositing so a glass element above sees the one below it in its refraction     |
| kube.io writeup                   | A hands-on derivation of the effect from first principles using CSS, SVG displacement maps and physics-based refraction calculations                                                                                |

Every one of these refracts **the page**. None of them refracts **a 3D scene**.

**This is the positioning gap.** The sentence for the README: _the liquid-glass
libraries bend your DOM; Materials3D bends a scene._ Worth also noting the
convergent evolution — those libraries independently arrived at three-tap
channel-split refraction and rim-loaded displacement, which is reassurance that
those two choices are correct rather than idiosyncratic.

### 2.4 Hero-background packages

`Vanta.js` is the shape-of-product reference: drop-in animated WebGL backgrounds,
roughly 120kb minified and gzipped counting three.js, with explicit guidance to use no more than one or two per page and to set a background image or colour as a fallback. Its ergonomics (`VANTA.WAVES('#el')`, `effect.destroy()`) are worth borrowing;
its weakness — a global `window.THREE`, pinned to old three versions — is worth
not borrowing.

`wave3d` already solves the packaging half of this properly: poster-first,
code-split three, peer dependency range, framework wrappers. Materials3D should
reuse that skeleton wholesale.

### 2.5 Summary positioning

> Scene-level refractive glass for the web. Not a DOM filter, not a BSDF —
> a small renderer where colour lives behind the glass and the glass bends it.

---

## 3. The technique

### 3.1 Render passes

Four passes per frame:

```
1. depth   → depthRT   linear depth, 2-channel packed
2. plate   → bgRT      full scene, glass falls back to the lamp field
3. main    → colorRT   full scene, glass refracts bgRT
4. post    → screen    DOF + bloom + caustics + haze
```

**Pass 1 — depth.** Linear view depth packed across two channels for ~16-bit
precision:

```glsl
float d = clamp(vZ / FAR, 0.0, 1.0);
vec2 e = vec2(d, fract(d * 255.0));
e.x -= e.y / 255.0;          // decode: e.x + e.y/255.0
```

The backdrop is **hidden** during this pass and the buffer is cleared to the
encoded focal depth. This matters more than it sounds — see §4.1.

**Pass 2 — plate.** The scene with `uPass = 0`, so glass samples the procedural
lamp field instead of a texture. Writes linear depth into **alpha**.

**Pass 3 — main.** Same scene with `uPass = 1`, sampling pass 2. This is what
makes tubes refract other tubes.

The refraction texture must be **unbound** while pass 2 renders into it, or the
driver reports a framebuffer feedback loop:

```js
function setPass(n) {
  for (const it of items) {
    it.mat.uniforms.uPass.value = n;
    it.mat.uniforms.tBg.value = n === 1 ? bgRT.texture : null;
  }
}
```

**Pass 4 — post.** 24-tap golden-angle spiral DOF, saturation-weighted bloom,
caustics, haze, vignette, grain.

### 3.2 The lamp field

Colour is a **bounded** field behind the glass — a handful of soft Gaussian lamps
with empty space between them — returning both a colour and a coverage amount:

```glsl
vec4 plate(vec2 p){
  vec3 c = vec3(0.0); float a = 0.0;
  for (int i = 0; i < MAX_LAMPS; i++){
    vec2 d = p - uLamp[i].xy;
    float w = exp(-dot(d,d) / (uLamp[i].z * uLamp[i].z)) * uLamp[i].w;
    c += uLampCol[i] * w; a += w;
  }
  float amt = 1.0 - exp(-a * uLampGain);
  amt = smoothstep(uLampLo, uLampHi, amt);   // gate tails to fully clear
  return vec4(c / max(a, 1e-4), amt);
}
```

Two non-obvious details:

**The coverage gate is what makes clear glass clear.** Without
`smoothstep(lo, hi, amt)`, every lamp's Gaussian tail extends everywhere, so
every shape has _some_ tint and nothing reads as transparent. Gating the tails to
zero is what produces genuinely clear regions — and, counterintuitively, also what
lets the tinted regions be more saturated, since coverage no longer has to be
dialled down globally to keep things light.

**The backdrop samples the same lamps at ~5%.** If colour appears _only_ inside
glass, the eye reads it as tint no matter how it was computed. A faint presence in
the gaps is what sells "behind."

### 3.3 Refraction into the backplate

Each fragment casts a refracted ray at a plane hanging behind the scene and
samples where it lands:

```glsl
vec4 backplate(vec3 ro, vec3 rd){
  float dz = min(rd.z, -0.04);
  vec3 h = ro + rd * ((uPlaneZ - ro.z) / dz);
  return plate(h.xy / uPlateScale + uPlateOffset);
}
```

Three rays at three IORs give dispersion.

**Plane distance is a critical parameter, not a detail.** Far back, each shape
acts as a full lens and smears the entire gradient across its own width as rainbow
banding. Close in (`z ≈ -3`), the hit point tracks position and refraction reads
as distortion of a continuous field. This is the single knob that decides whether
the result looks like one gradient behind everything or like coloured plastic.

### 3.4 Rim-loaded displacement

The screen-space displacement is weighted toward the silhouette rather than
applied uniformly:

```glsl
vec2 off = vec2(vVN.x / uAspect, vVN.y) * uLens * pow(1.0 - ndv, 1.35) * 3.4;
```

Uniform displacement reads as frosted. Edge-loaded displacement — a near-flat
window in the middle, hard bending at the rim — is what reads as _cut_ glass. This
is the same conclusion the Liquid Glass libraries reached independently.

### 3.5 Beer–Lambert with an analytic chord

For a cylinder, the path length through the glass along the view ray is
`2R·(N·V)` — maximum down the barrel, zero at the rim:

```glsl
float thick = 2.0 * uR * pow(ndv, 0.40);
float trans = (1.0 - exp(-uSigma * thick)) * amt;
```

The `pow(ndv, 0.40)` is a deliberate cheat: the true chord falls off too fast and
produces a wide white rim that eats most of the shape's width, leaving only a thin
coloured core. The exponent holds the path across the barrel and collapses it only
near the silhouette.

### 3.6 Colour as light, not pigment

The naive composite is `mix(white, tint, absorb)` — a pigment model, which darkens
as it saturates and looks muddy. Instead, take the lamp's _chroma_ and keep the
_brightness_ of what is behind:

```glsl
vec3 hue = lit / max(max(lit.r, max(lit.g, lit.b)), 0.001);
hue = mix(lit, hue, 0.55);                    // full normalization posterizes
vec3 col = base * mix(vec3(1.0), hue, trans);
col += lit * trans * uEmis;                   // small emissive term
```

The 0.55 blend matters: full chroma normalization turns smooth gradients into hard
posterized patches.

---

## 4. Pitfalls

Each of these produced a wrong result that looked plausible enough to ship.

### 4.1 Backdrop at max blur bleeds colour outward

**Symptom:** everything looks like smeared watercolour; no crisp edges anywhere.

**Cause:** the backdrop sits far outside the focal range, so its circle of
confusion is maximal. Every background pixel near a shape gathers ~14px of that
shape's colour.

**Fix:** hide the backdrop during the depth pass and clear the depth buffer to the
encoded focal depth. Backgrounds are smooth gradients — they don't need blurring,
and pinning them to the focal plane eliminates the bleed entirely.

This was the single largest visual improvement in the whole build.

### 4.2 Screen-space refraction ghosts the silhouette

**Symptom:** a faint duplicate outline of the whole cluster.

**Cause:** every fragment displaces by a similar offset, so shapes sample _other
shapes in front of them_ and reproduce their silhouette.

**Fix:** stash linear depth in the plate pass's alpha channel and reject any
sample nearer than the current fragment:

```glsl
float valid = step(vVZ - 0.30, smp.a * FAR);
return mix(fieldColour, smp.rgb, 0.94 * valid);
```

With validation the real-frame blend can go from ~0.58 to ~0.94 — i.e. the
validation is what _buys_ the accuracy, not a cosmetic patch on it.

### 4.3 `radius` is an optical path, not a size

**Symptom:** flat discs render as opaque plastic.

**Cause:** `radius` feeds the Beer–Lambert chord. For a rod it's the tube radius;
for a disc the optical path is its **thickness**. Passing a disc's 3.4-unit radius
instead of its 0.38-unit half-thickness saturates absorption completely.

**Fix:** rename the parameter to `path` in the public API. The name `radius`
invites the mistake.

### 4.4 Rotational symmetry makes rotation invisible

A lathed shape spun about its own axis of symmetry is _literally_ invisible — the
same normal distribution every frame. Early versions looked static for this reason.
Either break symmetry (elliptical cross-section) or rotate about a different axis.
The reference does the latter: one shared horizontal axis, shapes rolling on it.

### 4.5 Long lens or it reads as tumbling

Rotation about a horizontal axis should read as _foreshortening_ — the shape stays
vertical in projection and just gets shorter. At a wide FOV (22°) off-centre shapes
lean instead, and the motion reads as tumbling. At 12° from 44 units it reads
correctly. Perspective is doing more work here than the animation curve.

### 4.6 Stagger must span a full turn

With `stagger × count` well under 2π, all shapes cluster in phase and the trough
of the wave sits as a static bald patch. At `stagger ≈ 2π / count` the phases
distribute evenly and the trough _travels_.

### 4.7 Bloom weighted by brightness does nothing on white

A standard bright-pass is useless against a near-white backdrop — the background
is the brightest thing in frame. Weight the bloom by **saturation** instead:

```glsl
float sat(vec3 c){ return max(max(c.r,c.g),c.b) - min(min(c.r,c.g),c.b); }
```

---

## 5. Calibration

Art-directing this by eye repeatedly overshot. Measuring against a reference frame
was faster and more reliable — worth shipping as a `scripts/calibrate` tool.

The metric that turned out to matter most is the **clear-glass ratio**: fraction of
pixels in the subject band that are near-neutral but bright.

```python
# saturation < 0.18 and luminance > 0.72  ==>  reading as clear glass
def clear_pct(path, box):
    im = Image.open(path).convert('RGB'); n = tot = 0
    x0, y0, x1, y1 = box
    for x in range(x0, x1, 5):
        for y in range(y0, y1, 5):
            r, g, b = im.getpixel((x, y))
            _, l, s = colorsys.rgb_to_hls(r/255, g/255, b/255)
            tot += 1
            if s < 0.18 and l > 0.72: n += 1
    return 100 * n / tot
```

Reference measured **43%**. Successive builds measured 27% → 34% → 37% → 44%.
Every one of those had looked "about right" by eye.

A second useful measurement is the **hue histogram** of saturated pixels, which
is how the palette was derived rather than guessed:

```
20–40°  19.3%   0–20°  10.0%   40–60°  9.9%     (warm ≈ 39%)
320–340° 13.2%  340–360° 8.7%   300–320° 7.3%   (pink/magenta ≈ 36%)
220–280° ≈ 21%                                   (blue-violet)
60–80°   1.8%                                    (green — nearly absent)
```

No cyan at all. A cosine palette sweeping full hue was wrong on the evidence.

Ship both as `pnpm calibrate <reference.png> <render.png>`.

---

## 6. API

Current vanilla surface, to be ported to TypeScript:

```ts
const stage = Materials3D.stage(canvas, {
  background, clearGlass, lamps, lampGain, lampGate,
  plate:  { z, scale, offset },
  camera: { fov, distance, lookAt, height },
  post:   { focus, range, aperture, bloom, caustics, haze, hazeTop, hazeCol },
  orbit
});

stage.add(geometry, { position, rotation, scale, material, data });
stage.onFrame((t, dt, items) => {}).start();
stage.setLamps([...]); stage.post({...}); stage.clear(); stage.dispose();
```

### Shapes

Almost everything is a lathe — a 2D profile swept about Y. Change the profile for
rods, discs, cones, spheres, rings; change the **segment count** for prisms, since
a hexagon is just a lathe with `sides: 6`. That one observation covers most of the
geometry in this visual language.

| builder                                          | notes                                  |
| ------------------------------------------------ | -------------------------------------- |
| `rod({ r, len, fillet, sides })`                 | flat-ended cylinder with corner fillet |
| `disc({ r, thickness, fillet })`                 | same primitive, squat                  |
| `prism({ r, len, sides })` / `hex()`             | low segment count                      |
| `cone`, `sphere`, `ring({ r, hole, thickness })` |                                        |
| `pathShape({ outline, r, depth })`               | arbitrary silhouette, as SVG path data |
| `extrude({ shape, depth, bevel })`, `arrow()`    | **not** lathes — swept 2D paths        |

Flat ends with a small fillet, not hemispheres. The fillet catches the rim
highlight and the flat face reads as an ellipse when tilted — that ellipse is a
strong glass cue and a capsule loses it.

### Material

| option                                      | meaning                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `path` (was `radius`)                       | half the optical path at normal incidence — see §4.3               |
| `density`                                   | absorption coefficient (σ)                                         |
| `tint`                                      | own colour instead of borrowing lamps behind                       |
| `ior`, `dispersion`                         | dispersion splits the three channels                               |
| `lens`                                      | rim-weighted displacement strength                                 |
| `rim`, `specular`, `saturation`, `emission` |                                                                    |
| `hueShift`                                  | refracted-hue rotation in turns; reflections keep the lamp colours |

### Motions

`skewer({ axis, rate, stagger, jitter })`, `spin`, `drift`, or a raw `onFrame`.

---

## 7. Package plan

Mirroring `wave3d`:

```
materials3d/
├── packages/
│   ├── core/          @materials3d/core     — renderer, shapes, motions, presets
│   ├── react/         @materials3d/react    — <Materials3D preset="..." poster="..." />
│   └── element/       @materials3d/element  — <glass-kit> custom element
├── apps/studio/       browser studio (Vite + Tweakpane)
├── gallery/           presets as JSON
├── scripts/           calibrate, poster generation
├── .changeset/  .github/workflows/  pnpm-workspace.yaml
```

**Peer dependency:** `three >= 0.180 < 1`, matching wave3d. See §8 — the current
code is r128 and this is not a free upgrade.

**Poster-first.** Same contract as wave3d: render a still, upgrade to WebGL only
when the browser can handle it, fall back on no-WebGL, Save-Data,
`prefers-reduced-motion`, or lost context. This matters more here than for a
gradient — four passes at high DPR is a real cost. Clamp DPR, pause offscreen, and
consider forcing the poster below a viewport threshold.

**Config-driven.** One JSON config drives renderer, studio panel, and every export.
Studio exports: code snippet per framework, PNG/WebP still, WebM/MP4/GIF,
self-contained embed HTML, and the raw config.

**Presets** are the actual product for most users: the reference scene ("Skewer"),
an exploded shapes composition ("Assembly"), a glass spiral staircase
("Staircase"), a set of gooey liquid blobs ("Slimes"), a dispersion rig
("Prism"), two overlapping lenses in one beam ("Doublet"), a glass sphere refracting along its real
optical path ("Orb"), a hover legend for the
interaction layer ("Reactions"), and a swatch
grid of every material against every shape ("Materials").

**Arbitrary silhouettes.** `path` takes an SVG `d` and extrudes it, for the shapes that cannot be
described by numbers. Y is flipped and the drawing is refitted so its longer half-extent is `r`, so a
path pasted from any tool arrives right way up at a findable size; the first subpath is the outline
and later ones are holes, and a whole `.svg` may be pasted in place of a bare `d`. The bevel is
sized off the outline's narrowest limb rather than its bounding box, and a negative `fillet`
removes it. A drawn outline may also be a beam target, convex or re-entrant: the tracer clips a
convex cross-section by half-planes (Cyrus-Beck, one pass) and scans anything else edge by edge,
and the multi-solid walk already allows a ray to re-enter a solid it left. Only a SELF-CROSSING
outline is refused — "inside" is undefined for one, so there is nothing for the trace to be right
about. It gets the screen-space refraction rather than the traced one — the
tracer wants bounding planes, which only a faceted lathe can supply (§3.5). `measuredThickness` is
optional, as it is for the other extrusions: `defaultPath` is `depth / 2`, so the analytic chord
resolves to the depth face-on, which is the true path through a plate.

**Carve-outs.** Shapes with a flat profile take a list of through-cuts, so a plate can be slotted.
Implemented as holes in the extruded profile rather than as a boolean solver: `THREE.Shape` already
carries `holes`, which keeps the geometry manifold and adds no dependency. Cuts are restricted to
through-cuts because thickness is measured as (back − front) depth (§3.5) — a hole open at both
ends draws nothing and is exactly correct, whereas a blind pocket would report itself as solid.

---

## 8. Porting from r128 to three ≥ 0.180

The prototype targets r128 and this is the main body of work. Known items:

- **Colour management.** r152+ enables colour management by default. Every hand-authored palette value here is effectively sRGB assumed-linear. Expect the whole palette to shift and plan to re-derive it against the reference rather than patch it.
- **`outputColorSpace`** replaces `outputEncoding`.
- **WebGLRenderTarget** options and `.texture` colour space need review.
- **Consider deleting hand-rolled dispersion** in favour of the built-in property (r164+) if switching to `MeshPhysicalMaterial` — though that forfeits the plate-field architecture, which is the actual point. More likely: keep the custom shader, use the built-in only in a "simple" material mode.
- **Evaluate `attenuationColor` / `attenuationDistance`** as a replacement for the manual Beer–Lambert. Likely keeps behaviour and deletes code, but loses the `pow(ndv, 0.40)` rim cheat (§3.5), which is doing real aesthetic work.
- **WebGPU / TSL** is where three is heading. The four-pass structure ports conceptually; the GLSL does not. Out of scope for v1, but don't over-invest in WebGL1 idioms — the `MAX_LAMPS` fixed uniform array exists only because of WebGL1 constant-bound loops and should become a texture or storage buffer.

---

## 9. Known limits

State these in the README rather than let people discover them:

- **No shadows.** Every shape floats. For a hero with objects resting on each other this is the most visible gap and the top roadmap item. Contact shadows (SSAO or a cheap projected blob) would close most of it.
- **Screen-space refraction** is bounded by what is on screen; shapes near frame edges refract clamped samples.
- **Caustics are a screen-space approximation**, not light transport — a downward saturation-weighted gather, not refracted photons.
- **Max 12 lamps**, fixed-size uniform array (WebGL1).
- **Four passes per frame.** Heavy at high DPR on mobile; poster-first is not optional.
- **No CSG.** Intersecting/boolean shapes (as in some hero compositions) need a real boolean library or pre-authored geometry.

---

## 10. Roadmap

1. TypeScript port + three ≥ 0.180 + colour-management re-derivation
2. Contact shadows
3. Studio (Tweakpane), config schema, share links
4. React + element wrappers, poster pipeline
5. Preset gallery
6. `pnpm calibrate` as a shipped tool
7. WebGPU/TSL engine — SHIPPED as experimental behind `renderer: "webgpu"`; not yet at parity (see WEBGPU.md)

---

## 11. Naming — checked, cleared

`materials3d`, parallel to `wave3d`. Checks run 22 Aug 2026:

| Check                            | Result                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| npm `materials3d`                | free (404)                                                                                          |
| npm `materials-3d`               | free (404)                                                                                          |
| npm `@materials3d` scope         | no published packages; registry search returns 0                                                    |
| npm search "materials3d"         | 0 results                                                                                           |
| GitHub repos named `materials3d` | 7, all 0–1 stars, all physical **glass 3D printing** (subsurface laser engraving, glass printers)   |
| Software/graphics trademark      | none found; `3D Glass Solutions` and similar are glass _substrate manufacturing_, a different class |
| GitHub user login `glass3D`      | **taken** — an org of that exact name is unavailable                                                |

Two notes worth carrying into the README:

**The GitHub org login is gone.** Irrelevant if the repo lives under a personal
account, as `wave3d` does. If an org is wanted later, `materials3d-dev` or similar.

**"materials3d" as a search term belongs to glass 3D printing.** Real, but it's a
different vertical — nobody searching for a WebGL library will be confused by a
glass printer. This is a much better position than `glass` + web, which now
collides head-on with the liquid-glass DOM-filter cluster (§2.3).

Rejected: `glasskit` — taken on npm by a React UI component library, an active
frontend package, i.e. a direct collision in exactly the wrong space.
`glass-shape-kit` — free, but "shape" names the input, and the shapes are the
easy part.

Unchecked: `materials3d.dev` / `materials3d.com`, and the Cloudflare Pages subdomain
(`materials-studio.pages.dev` to match `wave-studio.pages.dev`).

## Credits & licence

Technique derived by reverse-engineering a public hero animation frame-by-frame;
no code was copied. Built on three.js. Prior art in §2 is referenced for
positioning, not derived from. MIT, matching wave3d.
