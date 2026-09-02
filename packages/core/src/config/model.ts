/**
 * The Materials3D configuration schema: plain JSON that drives the renderer, the studio panel and
 * every export. A scene is a set of glass shapes, a bounded field of lamps *behind* them, a
 * camera, and a post stack — see the technique notes for why each of those is shaped this way.
 */

import { clamp, clamp01 } from "../util/math";
import { outlineFromSvg } from "../util/svg";

/** Fixed-size lamp uniform array. Twelve is what fits comfortably in a uniform block; the loop
 *  breaks at `lamps.length`, so unused slots cost nothing at runtime. */
export const MAX_LAMPS = 12;

/** Grounded-footprint slots the wall's contact shadow walks, and the most sides one may have.
 *  Shared: the GLSL engine injects them as `#define`s, the node graph unrolls to them, and the
 *  parity harness needs the same numbers to compile the chunk on its own. */
/** Bounding planes a traced solid may carry — a square prism's four sides plus two caps. */
export const PRISM_PLANES = 6;

export const GROUND_SLOTS = 4;
export const GROUND_MAX_SIDES = 8;

/** Camera far plane, and the divisor for the packed linear-depth encoding. Everything the depth
 *  pass writes is `viewZ / FAR`, so this constant is baked into both shaders and must match. */
export const FAR = 95;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** How the backdrop is painted behind the glass. */
export type BackgroundMode = "color" | "gradient" | "image" | "wall";

/** How the palette is mapped across the backdrop. */
export type GradientType = "linear" | "radial" | "conic" | "mesh";

/** How a background image is fitted to the frame. */
export type BackgroundImageFit = "cover" | "contain" | "stretch";

export const BACKGROUND_MODES: readonly BackgroundMode[] = ["color", "gradient", "image", "wall"];
export const GRADIENT_TYPES: readonly GradientType[] = ["linear", "radial", "conic", "mesh"];
export const BACKGROUND_IMAGE_FITS: readonly BackgroundImageFit[] = ["cover", "contain", "stretch"];

export const MAX_STOPS = 8;
export const MAX_MESH_POINTS = 8;

/** One colour in a gradient palette. */
export interface ColorStop {
  color: string;
  /** Position along the ramp, 0..1. */
  position: number;
}

/** One colour blob in a mesh gradient. */
export interface MeshGradientPoint {
  /** Position in frame UV, 0..1. */
  x: number;
  y: number;
  color: string;
}

/**
 * One soft Gaussian lamp in plate space — the coordinate system of the backplate that hangs
 * behind the scene, where (0,0) is one corner and (1,1) the other after `plate.scale`/`offset`.
 *
 * Lamps are *bounded*: `r` is a Gaussian radius, and the coverage gate (`lampGate`) crushes the
 * tails to zero. That gap between lamps is what makes clear glass read as clear.
 */
export interface LampConfig {
  x: number;
  y: number;
  /** Gaussian radius in plate space. */
  r: number;
  /** sRGB hex, e.g. `"#f8c852"`. */
  color: string;
  /** Weight multiplier for this lamp (1 = full). */
  intensity: number;
  /** Input→param bindings driving THIS lamp (x/y/radius/intensity) — the "lamp follows the
   *  cursor" hook. ABSENT ⇒ inert. Declared as a forward reference; see the interaction section. */
  bindings?: LampInteractionBinding[];
}

/**
 * A traced beam of white light that refracts through one shape and disperses.
 *
 * This is the one thing in the scene that is not a distortion of the plate. Everything else here
 * bends colour that already exists behind the glass; a beam has its own geometry and its own
 * wavelength-dependent path, so it is traced on the CPU into an additive ribbon mesh and drawn in
 * the main pass. See `renderer/lightSheet.ts` for the tracer.
 *
 * ABSENT ⇒ no beam, which is the case for every scene that is not built around one.
 */
export interface BeamConfig {
  /**
   * Names of the items the beam refracts THROUGH, so their cross-sections are derived from those
   * items' shapes and {@link radius}, {@link sides} and {@link rotation} are ignored.
   *
   * More than one and the beam crosses them all, in whatever ORDER it happens to reach them — the
   * order is found by the tracer, not given here, so moving a shape reroutes the light without
   * anything being re-authored. Between solids the ray travels in air carrying the direction it
   * left with, which is where the spectrum does most of its visible separating: a fan leaving one
   * prism arrives at the next already spread, and every wavelength then refracts on its own terms.
   *
   * A named item whose shape has no convex cross-section — a `ring` is an annulus, `slab` and
   * `arrow` are extrusions rather than lathes — is skipped rather than approximated by a circle.
   *
   * Those three describe the same solid as the item does, and keeping the two in step by hand is
   * the single easiest way to get a scene that is subtly wrong: change the item's kind and the
   * beam keeps refracting through the shape it used to be, with the light bending at the vertices
   * of a triangle that is no longer on screen. Naming the item makes that impossible.
   *
   * Absent, the three fields below describe the cross-section on their own, which is what a beam
   * with no glass in front of it needs.
   */
  targets?: string[];
  /** Circumradius of the cross-section the beam refracts through, in world units. Ignored when
   *  {@link target} names an item. */
  radius: number;
  /** Sides of that cross-section. 3 is the classic prism. */
  sides: number;
  /** Rotation of the cross-section in the sheet plane, in radians. The default puts a vertex at
   *  the top, matching a `prism` item rotated -90° about X. */
  rotation: number;
  /** Where the sheet sits on Z. Put it at the prism's centre so the beam runs through the body. */
  z: number;
  /**
   * Which polygon edge the beam enters through, as an index. Ignored when {@link entryAngle} is
   * set, and unusable on a round cross-section — see there.
   *
   * With `sides: 3` and the default rotation, 0 is the upper-left face.
   */
  face: number;
  /**
   * Where the beam strikes, as an angle in DEGREES around the cross-section from its centre.
   *
   * The alternative to {@link face} plus {@link entry}, and the only one that works on anything
   * round: a circle is traced as ninety-six facets under four degrees each, so a face index picks
   * one of them and `entry` then slides the impact point within it — a handle with nothing to
   * drive. An angle is continuous, means the same thing on a triangle and on a circle, and does
   * not change what it points at when the subdivision does.
   *
   * Absent, `face` and `entry` are used, which stay the natural handles on a faceted solid.
   */
  entryAngle?: number;
  /**
   * How far {@link entry} swings {@link entryAngle}, in DEGREES either side. Default 90.
   *
   * Ninety degrees is the right width for a single solid, where the beam can walk most of a face
   * and still leave through the same one. A chain of solids is far more delicate: the route that
   * threads all of them survives only a few degrees of aim, and past that the light misses the
   * second shape entirely and the effect collapses to one prism. A scene that has arranged such a
   * route narrows this until the whole sweep keeps it.
   */
  entrySweep?: number;
  /**
   * Angle of incidence on that face, in DEGREES from its normal.
   *
   * Measured from the normal rather than from world X, and that is what makes the beam drivable:
   * an angle in world space couples how steeply the beam strikes to where it strikes, so sweeping
   * it slides the entry point off the face within a degree or two. From the normal the two are
   * independent — {@link entry} moves the point of impact and this moves the angle, and the pointer
   * can drive them on separate axes.
   *
   * Past the critical angle the beam totally internally reflects and bounces inside the glass
   * instead of leaving cleanly. That is a real optical regime, not a failure: it is what the light
   * visibly doing something INSIDE the prism looks like, and the tracer follows the bounces.
   */
  incidence: number;
  /** Where along that face the beam lands, 0–1. Inset automatically so the beam's full width
   *  stays on the face — the footprint grows as 1/cos(incidence), so the inset does too. */
  entry: number;
  /** How far back along the beam the source sits, in world units. Only has to clear the frame. */
  distance: number;
  /** Ribbon half-width, in world units. */
  width: number;
  /** Cauchy base index — the index at infinite wavelength, NOT at 550nm. Across the visible band
   *  the real index sits well above this; `BEAM_DISPERSION` in `presets.ts` carries matched
   *  base/strength pairs for stylised, crown and flint glass. */
  ior: number;
  /** Cauchy strength term — how wide the rainbow fans. 0 still bends the beam but leaves it
   *  white. */
  dispersion: number;
  /** Wavelength vertices. The fan is a connected sheet spanning adjacent wavelengths, so this
   *  controls smoothness of the CURVE rather than banding; 128 matches the reference. */
  samples: number;
  /** Additive sheets integrating the finite width of the beam. Raising this softens the beam's
   *  edge and costs geometry linearly. */
  slices: number;
  /** Display exposure for the spectral integral the mesh represents. This is the main brightness
   *  knob; the reference uses 88 at its scale. */
  exposure: number;
  /** Gaussian tightness across the beam's width. Higher is a harder-edged beam. */
  edgeFalloff: number;
  /**
   * Seconds the beam takes to OPEN from its centre line on mount. 0 draws it whole immediately.
   *
   * Opening outward rather than fading up in brightness, because the two read as different events:
   * a fade is a lamp being switched on, and this scene is about a beam arriving.
   */
  revealSeconds: number;
  /**
   * Geometric dilution along the outgoing fan: `1 / (1 + rate·t)^power`, with `t` running 0 at the
   * glass to 1 at the wall.
   *
   * This is most of what makes a fan read as light spreading out rather than as a painted stripe.
   * At the reference's 3.8 / 3.7 it is roughly a 280× falloff across the frame — the spectrum is
   * brilliant leaving the prism and nearly gone by the far edge. A plain exponential was tried in
   * the reference and rejected for putting a second abrupt fade near the wall.
   */
  falloffRate: number;
  falloffPower: number;
  /**
   * The caustic: the beam drawn a second time as light landing on the wall.
   *
   * 0 strength turns it off. Its own falloff scales are deliberately far gentler than the beam's,
   * so it is still going where the beam's glow has died — which is the relationship between a
   * light and the surface it lights.
   */
  causticStrength: number;
  causticCoverage: number;
  /** How far the caustic washes toward neutral as it travels, and how much it lifts. */
  causticFarDesaturation: number;
  causticFarBrightness: number;
  /** Multipliers on `falloffRate` / `falloffPower` for the caustic alone. */
  causticRateScale: number;
  causticPowerScale: number;
  /** How much the wall's relief modulates it, and the incident elevation in degrees. */
  causticNormalInfluence: number;
  causticNormalElevation: number;
  /** Overall radiance multiplier applied in the shader, so changing it never forces a retrace. */
  intensity: number;
}

/**
 * Sparse airborne dust, lit only where light already is.
 *
 * ABSENT ⇒ no dust. It needs `post.bloomMode: "pyramid"`, because what lights each grain is the
 * broadest level of that pyramid: without it there is no light field to sample and the whole field
 * stays black.
 */
export interface DustConfig {
  /** Grains in the field. Cost is linear; a few thousand is plenty. */
  count: number;
  /** Half-extents of the volume they occupy, in world units. */
  extent: Vec3;
  /** Multiplier on every grain's pixel diameter. */
  size: number;
  /** Overall brightness. */
  intensity: number;
  /** Vertical drift, in world units per second. */
  drift: number;
  /**
   * How sharply a grain's brightness falls with the light reaching it, and the gain applied after.
   *
   * The power is what keeps a field sparse: dust is only visible where light actually is, and a
   * linear response paints a faint haze over the whole frame that reads as a dirty lens. Raising
   * it concentrates the field into the brightest regions; lowering it spreads the grains out.
   */
  falloffPower: number;
  response: number;
  /** Seed for the deterministic layout, so a render is reproducible. */
  seed: number;
}

/** The plane the refracted ray is cast at, and how plate space maps onto it. */
export interface PlateConfig {
  /**
   * Distance of the backplate behind the scene. **A critical parameter, not a detail.** Far back,
   * each shape acts as a full lens and smears the whole gradient across its own width as rainbow
   * banding; close in (z ≈ -3) the hit point tracks position and refraction reads as distortion
   * of a continuous field.
   */
  z: number;
  /** World units per unit of plate space. */
  scale: Vec2;
  /** Plate-space coordinate at world origin. */
  offset: Vec2;
}

/**
 * How the authored framing is reconciled with a canvas whose aspect differs from {@link FRAME_ASPECT}.
 *
 * - `cover`   — fill both axes and crop the overflow. The default and the hero look: a square or
 *               portrait export keeps the shapes at their authored size and loses the ends of a
 *               wide row.
 * - `contain` — show the whole authored frame, revealing world beyond it on the long axis. What
 *               you want when a wide arrangement has to survive a square crop intact. Reveals more
 *               of the backplate, so check `plate.scale` still covers the frame.
 * - `width`   — hold the horizontal composition identical at every aspect.
 * - `height`  — hold the vertical composition identical. Three's own behaviour for a perspective
 *               camera, and what Materials3D did before `fit` existed.
 */
export type CameraFit = "cover" | "contain" | "width" | "height";

/** Runtime whitelist for {@link CameraFit} (validating imported/serialized configs). */
export const CAMERA_FITS: readonly CameraFit[] = ["cover", "contain", "width", "height"];

/**
 * The aspect the presets are composed against — every `fit` is a policy for reconciling a canvas
 * against THIS rectangle, and at this aspect all four fits are identical.
 */
export const FRAME_ASPECT = 16 / 9;

export interface CameraConfig {
  /**
   * Vertical field of view in degrees. Long lenses matter here: rotation about a horizontal axis
   * should read as foreshortening, and at a wide FOV off-centre shapes lean instead, so the
   * motion reads as tumbling. 12° from 44 units is the reference framing.
   *
   * This is the fov at {@link FRAME_ASPECT}; off that aspect the renderer derives an effective fov
   * from it per {@link CameraConfig.fit}.
   */
  fov: number;
  distance: number;
  lookAt: Vec3;
  height: number;
  /**
   * Camera roll in DEGREES — tilting the camera body, so the whole composition rotates in frame.
   *
   * Degrees rather than radians to match `fov` in this same object; the rest of the config uses
   * radians, but a camera's numbers are conventionally degrees and mixing units inside one object
   * is worse than differing between them.
   */
  roll?: number;
  /** Framing policy off {@link FRAME_ASPECT}. Default `cover`. */
  fit?: CameraFit;
  /**
   * Floor on how much of the authored frame WIDTH must stay visible, as a fraction. A pure zoom
   * ceiling layered on the fit: it can only widen the view, never tighten it, so it is inert for
   * `contain`/`width` and bites exactly where the crop hurts — `cover`/`height` on a canvas
   * narrower than {@link FRAME_ASPECT}. 0 disables it.
   */
  minVisibleWidth?: number;
}

export interface PostConfig {
  /** Focal distance in world units (matched against the packed linear depth). */
  focus: number;
  /** Depth range either side of `focus` that stays sharp. */
  range: number;
  /** Maximum circle of confusion, in pixels. */
  aperture: number;
  /** Saturation-weighted bloom. A brightness-weighted bright-pass does nothing against a
   *  near-white backdrop — the background is the brightest thing in frame. */
  bloom: number;
  /** Downward saturation-weighted gather. A screen-space approximation, not light transport. */
  caustics: number;
  haze: number;
  hazeTop: number;
  hazeColor: string;
  vignette: number;
  grain: number;
  /** Bloom gather radius in full-resolution pixels. */
  bloomRadius: number;
  /** Saturation a sample must exceed before it blooms. 0 blooms everything with any colour. */
  bloomThreshold: number;
  /**
   * How over-range colour is brought back into gamut.
   *
   * `"none"` clamps each channel independently, which is what every preset predating the beam
   * tracer was calibrated against — hence the default. It is also the wrong answer the moment a
   * scene carries additive light above 1: clamping per channel drives bright colour to a primary
   * or secondary, so a spectrum clips into magenta / cyan / yellow bars. `"neutral"` compresses
   * the peak and desaturates toward it, keeping hue; `"aces"` is punchier with more hue shift.
   */
  toneMap: ToneMap;
  /**
   * How bloom is produced.
   *
   * `"gather"` is the original: a golden-angle gather at one radius, taken in the same loop as the
   * depth of field, weighted by SATURATION so it works against a near-white backdrop. Cheap, and
   * the right answer for a pale studio. `"pyramid"` thresholds highlights and blurs a four-level
   * half-resolution pyramid instead — several octaves of halo at once, which is what a light
   * SOURCE looks like as opposed to a bright object. Costs eight render targets.
   */
  bloomMode: BloomMode;
  /** Pyramid only: shifts weight from the tight scale to the broad one, 0–1. */
  bloomSpread: number;

  // -- Light shafts ---------------------------------------------------------
  /**
   * Volumetric light streaks radiating from ({@link innerLightX}, {@link innerLightY}). A
   * screen-space ray march over the composited frame — glass is what emits, so the shafts pick up
   * the tint the light picked up passing through it.
   */
  innerLight: number;
  /** Ray length / spread. */
  innerLightDensity: number;
  /** Per-sample falloff along a ray, below 1. */
  innerLightDecay: number;
  /** Source position in UV, 0..1 across the frame. */
  innerLightX: number;
  innerLightY: number;

  // -- Stylisation ----------------------------------------------------------
  // These deliberately break the photoreal read. They run last, over the finished frame.
  /** Ordered (Bayer) dithering, mixed back toward the original. */
  dither: number;
  /** Dither block size in device pixels. */
  ditherScale: number;
  /** Dither quantization levels. */
  ditherSteps: number;
  /** Rotated dot screen. */
  halftone: number;
  /** Dot cell size in device pixels. */
  halftoneCell: number;
  /** Screen rotation in radians. */
  halftoneAngle: number;
  /** Four-colour process halftone — cyan/magenta/yellow/black screens at print angles. */
  halftoneCmyk: number;
  halftoneCmykCell: number;
  /** Fibrous paper substrate shading, multiplied over the frame. */
  paperTexture: number;
  paperTextureScale: number;
}

/**
 * What shading model a shape uses.
 *
 * The first four are TRANSMISSIVE and share the whole four-pass path — they refract the plate,
 * absorb along a chord, and differ only in what happens at the surface. `liquid` is glass whose
 * surface carries travelling waves: the same optics, with the normal perturbed by an animated
 * ripple field before the ray is bent. The last three are OPAQUE and take a separate branch that
 * never samples the refraction at all.
 *
 * The kind IS the model, which is why there is no separate "metalness" knob: `metal` with metalness
 * turned down would just be `plastic`, and two controls that can contradict each other is worse UI
 * than one that cannot.
 */
export type MaterialKind =
  | "glass"
  | "frosted"
  | "glitter"
  | "liquid"
  | "metal"
  | "ceramic"
  | "plastic";

/**
 * What a reflective surface sees where the lamp plate does not reach.
 *
 * `"gradient"` is the original bright-ceiling/dark-floor ramp — enough to draw a horizon across a
 * metal cylinder in a pale studio, and what every preset predating this was built against.
 * `"softbox"` is a sparse three-panel room (back wall, centre fill, cool key) that also feeds
 * GLASS reflections. On a dark backdrop that is the difference between a block of glass and a flat
 * silhouette, because the plate covers almost none of the hemisphere there.
 */
export type StudioKind = "gradient" | "softbox";
/**
 * How the room a surface reflects is evaluated.
 *
 * `"analytic"` answers "what is in this direction" exactly, per fragment, which is right for a
 * mirror and wrong for everything else — a rough surface reflects a cone, and roughness therefore
 * had to fake the difference by fading the reflection toward flat grey. That reads as chalk rather
 * than as a blurred room.
 *
 * `"baked"` rasterizes the same room once into an equirectangular texture and blurs it into a mip
 * chain, so roughness becomes a mip level and a rough metal reflects a genuinely soft version of
 * what a polished one reflects. Costs one texture and a handful of passes at startup, and is
 * CHEAPER per fragment than the analytic room it replaces.
 *
 * Default `"analytic"`, because every preset predating this was calibrated against it.
 */
/**
 * How a transmissive material gathers what is behind it.
 *
 * `"simple"` casts three rays at three indices and takes one channel from each. It is cheap and it
 * is what every preset predating this was tuned against.
 *
 * `"cone"` casts a spread of rays instead, each with its own index and a smooth spectral weight.
 * Dispersion stops being three bins — which fringe wherever refraction moves faster than a bin is
 * wide — and roughness finally SCATTERS, gathering light from an area behind the surface rather
 * than blurring whatever one ray happened to land on.
 */
export const TRANSMISSION_MODES = ["simple", "cone"] as const;
export type TransmissionMode = (typeof TRANSMISSION_MODES)[number];

export const ENVIRONMENT_MODES = ["analytic", "baked"] as const;
export type EnvironmentMode = (typeof ENVIRONMENT_MODES)[number];

export const STUDIO_KINDS: readonly StudioKind[] = ["gradient", "softbox"];

export type BloomMode = "gather" | "pyramid";
export const BLOOM_MODES: readonly BloomMode[] = ["gather", "pyramid"];

export type ToneMap = "none" | "neutral" | "aces";
export const TONE_MAPS: readonly ToneMap[] = ["none", "neutral", "aces"];

export const MATERIAL_KINDS: readonly MaterialKind[] = [
  "glass",
  "frosted",
  "glitter",
  "liquid",
  "metal",
  "ceramic",
  "plastic",
];

/** Whether a kind refracts. The opaque kinds ignore path/density/ior/dispersion/lens/tint. */
export function isTransmissive(kind: MaterialKind): boolean {
  return kind === "glass" || kind === "frosted" || kind === "glitter" || kind === "liquid";
}

/**
 * Measured normal-incidence reflectance (F0) for real conductors, as display-space sRGB.
 *
 * From Adobe's Substance metal reference tables, which publish the same measured values the
 * Lagarde / MERL data sets do. They are quoted here in 8-bit sRGB rather than linear because
 * Materials3D authors every colour in display space on purpose — see the colour note in the renderer.
 *
 * For a conductor this is not a "tint" applied to a grey highlight: F0 IS the surface's colour,
 * and it is why gold reflects gold at every angle instead of reflecting white with a yellow wash
 * over it. Guessing these is exactly the kind of thing that reads as "video-game metal".
 */
export const METAL_F0: Record<string, string> = {
  silver: "#fefdfb",
  aluminium: "#f5f6f6",
  gold: "#ffdb98",
  copper: "#ffd3c0",
  chromium: "#c4c5c4",
  iron: "#f3f1e9",
  nickel: "#dad1c5",
  platinum: "#faf7ea",
  titanium: "#b2a9a2",
  zinc: "#f1f0ee",
};

/**
 * Measured reflectance at ~82° (the "specular edge colour"), from the same Adobe tables.
 *
 * Schlick's approximation is derived for dielectrics and overshoots for conductors near the
 * silhouette; real metals dip below it, most sharply around 82°, which is what {@link METAL_F82}
 * pins down. The visible consequence is desaturation: gold's F0 is (1.00, 0.86, 0.60) but its
 * edge is very nearly neutral, so a gold cylinder goes pale at its rim instead of staying gold all
 * the way round. Plain Schlick cannot do that, and "gold that is uniformly gold" is one of the
 * things that reads as CG.
 *
 * These are ABSOLUTE reflectances, not multiplicative tints — OpenPBR reparameterizes the same
 * model multiplicatively, but Adobe publishes the direct values, and transforming published data
 * to fit a different parameterization is a good way to introduce an error nobody can later find.
 */
export const METAL_F82: Record<string, string> = {
  silver: "#feffff",
  aluminium: "#f5f8fa",
  gold: "#f8fbf5",
  copper: "#fcf8f7",
  chromium: "#dfe1e9",
  iron: "#eef1f3",
  nickel: "#e9ecf0",
  platinum: "#f9f9f8",
  titanium: "#eff4f9",
  zinc: "#f1f4f7",
};

/**
 * Characteristic surface parameters per kind.
 *
 * Applied when the kind is switched, so picking "ceramic" gives you a ceramic rather than a
 * ceramic wearing the last material's roughness. Only the fields that BELONG to the surface are
 * touched — the transmissive optics (ior, density, dispersion…) are left alone, so glass → metal →
 * glass still comes back to the glass you had.
 */
export const MATERIAL_PRESETS: Record<
  MaterialKind,
  { roughness: number; albedo?: string; edgeTint?: string }
> = {
  // Inert for glass: it has no microfacet term.
  glass: { roughness: 0 },
  // Ground glass — enough spread to lose the image behind, not so much it turns to fog.
  frosted: { roughness: 0.42 },
  glitter: { roughness: 0.12 },
  // The ripple field is what makes it liquid; roughness stays inert as on glass.
  liquid: { roughness: 0 },
  metal: { roughness: 0.22, albedo: METAL_F0.aluminium, edgeTint: METAL_F82.aluminium },
  // Unglazed clay: matte, and the wrapped diffuse term does the rest.
  ceramic: { roughness: 0.62, albedo: "#e8e2d9" },
  plastic: { roughness: 0.24, albedo: "#cf5b52" },
};

/** Per-shape optical properties. */
export interface MaterialConfig {
  /**
   * Half the optical path at normal incidence, in world units — the tube radius for a rod, half
   * the *thickness* for a disc. It feeds the Beer–Lambert chord, so passing a disc's radius
   * instead of its half-thickness saturates absorption completely and the shape turns to opaque
   * plastic. (It was called `radius` once; the name invited exactly that mistake.)
   */
  path: number;
  /** Absorption coefficient σ, applied equally to every channel. */
  density: number;
  /**
   * Per-channel Beer-Lambert absorption. ABSENT ⇒ the lamp-derived tint above.
   *
   * The default model gives glass no colour of its own: it takes chroma from whatever lamps sit
   * behind it, keeping the brightness of what is there. That is right for a pale studio full of
   * coloured light, and it has two limits. It cannot express the most recognisable property of
   * coloured glass — thick parts more saturated than thin ones — because the tint does not depend
   * on the optical path. And a shape in a dark scene has nothing to take colour from, so the scene
   * has to invent lamps purely to give the glass something to borrow.
   *
   * Setting this switches that fragment to `exp(-absorption · path)` per channel, so the colour
   * deepens with the distance light actually travelled through the solid and owes nothing to the
   * lamps. Coefficients are per world unit: `{ x: 1, y: 1, z: 0.54 }` takes red and green about
   * twice as hard as blue and reads as faintly cool glass.
   */
  absorption?: Vec3;
  /** Give a shape its own colour instead of borrowing the lamps behind it. Empty = borrow. */
  tint: string;
  ior: number;
  /** Per-channel IOR split. Hand-rolled rather than three's `dispersion` property, because the
   *  whole point is the plate field — see the notes on `MeshPhysicalMaterial`. */
  dispersion: number;
  /** Rim-weighted screen-space displacement. Uniform displacement reads as frosted; edge-loaded
   *  displacement — a near-flat window in the middle, hard bending at the rim — reads as cut. */
  lens: number;
  /**
   * Rim highlight strength — the bright edge that sells "glass" at the silhouette.
   *
   * MEANS TWO DIFFERENT THINGS by kind, which is worth knowing before you reach for it. On the
   * opaque kinds it is a wide `pow(1 - N·V, 3)` falloff over most of the shape; on the
   * transmissive ones it mixes toward the thin-film colour inside a band near the silhouette. It
   * therefore reads strongest on a shape with real grazing area (a prism's flat facets, a ring's
   * two silhouettes) and softest on a smooth convex one, and with `iridescence` at 0 it is mixing
   * toward near-white — so it shows on a saturated shape and barely at all on a pale one.
   */
  rim: number;
  /**
   * Specular highlight strength from the key lights.
   *
   * Two of them: one nearly overhead and one low, near the lens axis. The second exists because a
   * highlight is a mirror image of the light and one light overhead is unreachable for any shape
   * whose normals are all horizontal — an upright rod or prism could never show one at all.
   */
  specular: number;
  /** Chroma boost applied to the refracted colour (1 = as sampled). */
  saturation: number;
  /**
   * Rotation of the refracted colour around the hue wheel, in turns (0.5 = the opposite hue,
   * ±1 = all the way around). It moves what the glass TRANSMITS — the borrowed lamp light or the
   * tint — and leaves reflection, rim and film alone, so the surface still reads as the same
   * glass. 0 (the default) is a true no-op. Mostly a binding target: hover-shifts a shape's
   * refracted colour without touching the lamps every other shape shares.
   */
  hueShift: number;
  /** Self-glow added on top of what the shape transmits or reflects. */
  emission: number;

  /** Which shading model. See {@link MaterialKind}. */
  kind: MaterialKind;
  /**
   * Wave amplitude on the surface of a `liquid` — how far the ripple field tilts the normal
   * before the ray is bent. 0 is dead calm (indistinguishable from `glass`). Inert elsewhere.
   */
  ripple: number;
  /** Ripple spatial frequency, in waves per world unit. Lower reads as slow open water, higher
   *  as fine shimmer. `liquid` only. */
  rippleScale: number;
  /**
   * Ripple travel speed, in radians per second. Snapped to whole cycles over
   * {@link SceneConfig.loopSeconds} exactly as motion rates are, so a looping clip closes.
   * 0 freezes the waves in place. `liquid` only.
   */
  flow: number;
  /**
   * Thin-film interference strength on the Fresnel reflection — the soap-bubble / oil-slick
   * rainbow. 0 disables it. Transmissive kinds only.
   */
  iridescence: number;
  /** Optical thickness of the film, in nanometres. ~300–500 is the classic soap-bubble band;
   *  what it controls is how many colour bands sweep across the shape as it turns. */
  filmNm: number;
  /**
   * Surface scatter. On `frosted` it spreads the refracted ray, turning the plate behind into a
   * diffuse glow; on the opaque kinds it broadens the specular highlight. Inert for `glass`.
   */
  roughness: number;
  /** Micro-facet sparkle density — `glitter` only. */
  sparkle: number;
  /** Sparkle grain frequency. Higher is finer. */
  sparkleScale: number;
  /** Base colour for the opaque kinds. Unlike `tint`, which is an absorption colour, this is
   *  what the surface actually reflects. For a metal this is F0 — see {@link METAL_F0}. */
  albedo: string;
  /**
   * A conductor's measured reflectance at ~82°, applying the Hoffman F82 correction to Schlick.
   * Empty disables it and leaves plain Schlick, which is the right default for a hand-picked
   * albedo that has no measured edge to go with it. See {@link METAL_F82}.
   */
  edgeTint: string;
}

/**
 * Almost every primitive is a lathe: a 2D profile swept about Y. Change the profile for rods,
 * discs, cones, spheres, rings and droplets; change the *segment count* for prisms, since a
 * hexagon is just a lathe with `sides: 6`. `arrow` (a swept 2D path) and `blob` (a sphere with
 * seeded low-frequency lumps baked into its vertices) are the exceptions.
 *
 * `path` is the escape hatch: an arbitrary outline given as SVG path data and extruded, for the
 * silhouettes none of the above can reach. See {@link ShapeConfig.outline}.
 */
export type ShapeKind =
  | "rod"
  | "disc"
  | "prism"
  | "hex"
  | "cone"
  | "sphere"
  | "ring"
  | "arrow"
  | "droplet"
  | "blob"
  | "slab"
  | "path";

export const SHAPE_KINDS: readonly ShapeKind[] = [
  "rod",
  "disc",
  "prism",
  "hex",
  "cone",
  "sphere",
  "ring",
  "arrow",
  "droplet",
  "blob",
  "slab",
  "path",
];

/**
 * One carve-out, subtracted from a shape's profile before it is extruded.
 *
 * There is no `slot` kind because a slot is a `rect` whose corner radius has reached half its
 * short side — the same economy that makes a hexagon a lathe with `sides: 6`. Two primitives cover
 * round holes, square windows, stadium slots and everything between.
 *
 * Cuts go ALL THE WAY THROUGH, and that is a constraint on the renderer, not a missing feature.
 * Glass thickness is measured as (back-face depth − front-face depth), so a hole that opens on
 * both sides simply draws no fragment — exactly like `ring`, and exactly as correct. A blind
 * pocket would leave the front and back faces intact and report the empty cavity as solid glass,
 * so the shape would light as though the pocket were not there.
 */
export type CutKind = "rect" | "circle";

export const CUT_KINDS: readonly CutKind[] = ["rect", "circle"];

export interface CutConfig {
  kind: CutKind;
  /** Centre in the shape's own profile plane, in shape units, origin at the shape's centre. */
  x: number;
  y: number;
  /** Rect: width and height. Circle: `w` is the diameter and `h` is ignored. */
  w: number;
  h: number;
  /** Corner radius (rect). Clamped to half the short side, which is where a rect becomes a slot. */
  r: number;
  /** Rotation within the profile plane, in radians. */
  rotation: number;
}

/** Enough to slot a plate several ways over; past this the shape is a grille, not a carve-out. */
export const MAX_CUTS = 8;

/**
 * Longest `d` a {@link ShapeConfig.outline} may carry.
 *
 * A cap rather than trust, because this string is the one field in the whole model whose size is
 * unbounded by its meaning: a scene travels as base64 in a URL hash, and one traced photograph
 * pasted in would take the share link past what a browser will follow. Four thousand characters
 * is a few hundred curve commands — far more detail than survives being extruded and rendered at
 * the size these shapes appear.
 */
export const MAX_OUTLINE = 4000;

/**
 * What a `path` shape draws before anything has been authored into it.
 *
 * A five-pointed star: recognizably arbitrary — no other kind here can make one — and non-convex,
 * so the triangulator and the bevel clamp are both exercised by the default rather than only by
 * whatever a user happens to paste in first.
 */
export const DEFAULT_OUTLINE =
  "M50 0 L61.8 33.8 L97.6 34.5 L69 56.2 L79.4 90.5 L50 70 L20.6 90.5 L31 56.2 L2.4 34.5 L38.2 33.8 Z";

export function createCut(kind: CutKind = "rect"): CutConfig {
  return { kind, x: 0, y: 0, w: 0.6, h: 2.4, r: 0.3, rotation: 0 };
}

/** A shape spec. Fields not meaningful for a `kind` are ignored, so the studio can keep one
 *  editable object while you flip between kinds. */
export interface ShapeConfig {
  kind: ShapeKind;
  /** Outer radius (rod, disc, prism, hex, cone, sphere, ring) — and the CORNER radius of a slab. */
  r: number;
  /** Length along the sweep axis (rod, prism, hex, cone) — the shaft length of an arrow, and the
   *  WIDTH of a slab. */
  len: number;
  /** Thickness (disc, ring) — and the HEIGHT of a slab. */
  thickness: number;
  /**
   * Corner fillet. Flat ends with a small fillet, not hemispheres: the fillet catches the rim
   * highlight and the flat face reads as an ellipse when tilted, which a capsule loses.
   *
   * Positive is a literal radius in world units and `0` asks for a proportional one. A NEGATIVE
   * value means no fillet at all, and only `path` honours it — see the note in `normalizeShape`
   * for why a lathe cannot. It is there because a drawn silhouette is the one shape here whose
   * fine detail a bevel can visibly fatten.
   */
  fillet: number;
  /**
   * Radius of a fillet on ALL of a prism's edges, in world units. 0 keeps the lathe.
   *
   * `fillet` above rounds only where the side faces meet the caps — a lathe cannot round the
   * vertical corners between them. This swaps in a purpose-built mesh that rounds every edge, so a
   * narrow bevel strip runs right around the solid. It sits at an angle to both surfaces it joins,
   * catches the environment differently from either, and is what makes a block of glass read as
   * faceted instead of as a flat silhouette.
   */
  bevel: number;
  /** Lathe segments. Six is a hexagonal prism. */
  sides: number;
  /** Inner radius (ring). */
  hole: number;
  /** Arrow shaft width. */
  shaft: number;
  /** Arrow head width. */
  head: number;
  /** Extrusion depth (arrow, slab). */
  depth: number;
  /** Deterministic lump layout (blob). Same seed, same blob. */
  seed: number;
  /** Lumpiness, 0–1 (blob): how far the surface departs from the underlying sphere. */
  bump: number;
  /**
   * The silhouette of a `path` shape, as SVG path data — the `d` attribute of a `<path>`.
   *
   * This is the one shape that is not described by numbers, because the shapes it is for cannot
   * be: a pair of spectacles has no radius. `d` is chosen over a point list for three reasons that
   * all point the same way — it is what a vector tool puts on the clipboard, it carries curves
   * without the author pre-tessellating them, and it is several times more compact, which matters
   * because a scene travels as base64 JSON in a share link.
   *
   * Accepts a whole `<svg>` document or fragment as well as a bare `d`: every `<path>` in it is
   * read, in document order, which lands on the outline-then-holes rule below because that is the
   * order a vector tool writes a shape and its counters. Nothing but `<path>` is read, and
   * `transform` attributes are ignored — a translate or scale is absorbed by the refit, a rotate
   * is not.
   *
   * Read in SVG's own conventions and then normalized, which is what makes a pasted path simply
   * work: Y points DOWN in the source and is flipped, and the outline is scaled about its own
   * bounding-box centre until its larger half-extent is {@link r}. So a path authored in a
   * 0–1000 viewBox and one authored in a unit square render at the same size, and `r` is the
   * handle that resizes either.
   *
   * The FIRST subpath is the outline; every later one is a hole. {@link cuts} still apply on top,
   * and are the better tool for a round or slotted opening since they are numeric and animatable.
   *
   * ABSENT ⇒ {@link DEFAULT_OUTLINE}, so a shape switched to `path` in the studio has something
   * to show before anything has been typed into it.
   */
  outline?: string;
  /**
   * Through-cuts in the profile plane. ABSENT ⇒ solid (the common case), which is also why this
   * is optional rather than an empty array: every scene ever exported stays byte-identical.
   *
   * Honoured by the shapes with a flat profile to carve — `slab` and `arrow`, plus the plates
   * (`disc`, `prism`, `hex`), which swap their lathe for the equivalent extrusion when they carry
   * cuts. Ignored by `rod`, `sphere`, `cone`, `ring`, `droplet` and `blob`, whose profiles sweep.
   */
  cuts?: CutConfig[];
}

/**
 * A set of shapes that select and transform as one — the studio's grouping.
 *
 * Membership lives on the SHAPES ({@link ItemConfig.group}), not as a nested tree, and a group has
 * no transform of its own: turning a group writes the result into each member's own pose. That is
 * a deliberate choice, and it is what keeps every other contract in this file intact —
 * `resolveItems(config)[i] === config.items[i]` still holds, a motion still owns the components it
 * drives, and an exported scene still renders identically in a consumer that has never heard of a
 * group. Grouping is an AUTHORING convenience; nothing reads it at render time.
 *
 * Groups are flat. Nesting would need an "active group" context in the UI — which level a click
 * selects at — and a scene of a few dozen shapes does not earn that.
 */
/** A group of one is not a group: {@link ensureSceneConfig} dissolves anything smaller. */
export const MIN_GROUP_SIZE = 2;

export interface GroupConfig {
  /** Stable identity, referenced by {@link ItemConfig.group}. Renaming never touches it. */
  id: string;
  /** Optional label. Absent means the studio shows a positional fallback ("Group 2"). */
  name?: string;
}

export interface ItemConfig {
  /**
   * An optional label for this shape, shown in the studio's config panel.
   *
   * Purely for the author's benefit — nothing reads it at render time. A scene of sixteen rods is
   * far easier to navigate as "front left" and "the tall one" than as "rod 7".
   */
  name?: string;
  /**
   * The {@link GroupConfig.id} this shape belongs to, if any.
   *
   * An id no group declares is not an error: {@link ensureSceneConfig} synthesizes the missing
   * group, so writing `"group": "rods"` on three shapes by hand simply works.
   */
  group?: string;
  shape: ShapeConfig;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  material: Partial<MaterialConfig>;
  /** This shape's own motion. */
  motion: MotionConfig;
  /** This shape's input→param bindings. ABSENT ⇒ inert (the common case). */
  interaction?: ItemInteractionConfig;
  /**
   * Where this shape sits in its motion's cycle, in radians.
   *
   * This is what makes a row of shapes read as a travelling wave rather than a rigid block, and it
   * has to spread across a full turn: cluster the phases and the trough of the wave sits still as
   * a bald patch instead of moving.
   */
  phase: number;
}

export type MotionKind = "none" | "skewer" | "spin" | "drift" | "wobble";

export const MOTION_KINDS: readonly MotionKind[] = ["none", "skewer", "spin", "drift", "wobble"];

export type Axis = "x" | "y" | "z";

/**
 * How one shape moves. Motion belongs to the SHAPE, not the scene: a composition is usually a few
 * things doing different things, and a single scene-wide driver can only express "everything does
 * the same". The studio's "apply to all shapes" covers the case where you did want them uniform.
 *
 * Note there is no `stagger` here. Offsetting successive shapes is a property of the *arrangement*,
 * not of a motion — it lives on {@link ItemConfig.phase} per shape, and {@link ScatterConfig.stagger}
 * for generated ones.
 */
export interface MotionConfig {
  kind: MotionKind;
  axis: Axis;
  rate: number;
  /** Displacement amount (drift), or squash amplitude (wobble). */
  amount: number;
}

export function createMotion(kind: MotionKind = "none"): MotionConfig {
  return { kind, axis: "x", rate: 0.34, amount: 0.16 };
}

// ---------------------------------------------------------------------------------------------
// Interaction layer (optional, additive, default-off) — the trigger system ported from wave3d.
// The SHARED inputs (one cursor + scroll + touch opt-in) and scene-param bindings live on
// SceneConfig.interaction; a shape's response lives on ItemConfig.interaction, a lamp's directly
// on LampConfig.bindings. What deliberately did NOT port is wave3d's pointer FIELD (hover
// swell / drag-wake / click ripples) — those deform a membrane, and these shapes are rigid.
// ABSENT blocks mean fully off: no listeners attach and the rendered pixels are byte-identical.
// ---------------------------------------------------------------------------------------------

/** The built-in interaction input names (the open-ended `custom:*` family is handled separately).
 *  Kept in sync by hand with the {@link InteractionSource} union below. */
export const INTERACTION_SOURCE_NAMES = [
  "scroll",
  "hover",
  "hoverSelf",
  "pointerX",
  "pointerY",
  "pointerSpeed",
  "press",
  "pressSelf",
  "scrollVelocity",
  "appear",
] as const;

/**
 * An interaction INPUT: a normalized signal that can smoothly drive config params through a
 * binding. Every source is exponentially smoothed before it is applied.
 */
export type InteractionSource =
  | "scroll" // container progress through the viewport, 0 (entering) .. 1 (scrolled past)
  | "hover" // smoothed pointer presence over the container, 0..1
  | "hoverSelf" // smoothed pointer-over-THIS-shape, 0..1 (renderer raycasts; item bindings only — reads 0 on scene/lamp bindings)
  | "pointerX" // smoothed pointer X across the container, 0..1; relaxes to 0.5 on leave
  | "pointerY" // smoothed pointer Y across the container, 0..1; relaxes to 0.5 on leave
  | "pointerSpeed" // normalized smoothed pointer speed, 0..1
  | "press" // pointer button / touch held, smoothed 0..1
  | "pressSelf" // press that BEGAN on this shape, held 0..1 (raycast at pointerdown; item bindings only)
  | "scrollVelocity" // normalized smoothed |d(scroll progress)/dt|, 0..1
  | "appear" // one-shot 0→1 latch on first visibility (entrance choreography)
  | `custom:${string}`; // developer-fed each frame via renderer.setInteractionInput(name, value)

/** Per-SHAPE params a binding may drive. Single source of truth for ITEM_APPLIERS in
 *  renderer/interaction.ts (checked via `satisfies`) and validated by the binding cleaner. */
export const ITEM_TARGET_NAMES = [
  "density",
  "ior",
  "dispersion",
  "lens",
  "rim",
  "specular",
  "saturation",
  "hueShift",
  "emission",
  "ripple",
  "iridescence",
  "filmNm",
  "positionX",
  "positionY",
] as const;
/** A per-shape param an {@link ItemInteractionBinding} can drive. */
export type ItemInteractionTarget = (typeof ITEM_TARGET_NAMES)[number];

/** Per-LAMP params a binding may drive — `x`/`y` are plate-space 0..1, which is exactly what
 *  pointerX/pointerY produce, so a lamp that follows the cursor is a two-binding config. */
export const LAMP_TARGET_NAMES = ["x", "y", "radius", "intensity"] as const;
export type LampInteractionTarget = (typeof LAMP_TARGET_NAMES)[number];

/** SCENE params a binding may drive (post / camera / time / lamp field — shared, not per shape). */
export const SCENE_TARGET_NAMES = [
  "timeOffset",
  "cameraZoom",
  "lampGain",
  "aperture",
  "bloom",
  "haze",
  "vignette",
  "grain",
  "caustics",
  /** Angle of incidence on the entry face, in degrees. Unlike every other scene target these two
   *  do NOT write a uniform: the beam's geometry is traced on the CPU, so driving them forces a
   *  retrace. See {@link BeamConfig} and the note in `interaction.ts`. */
  "beamIncidence",
  /** Point of impact along the entry face, 0–1. The other pointer axis. */
  "beamEntry",
  /** Camera yaw offset in DEGREES, added to whatever a drag-orbit has set. A few degrees is the
   *  useful range: the point is parallax against what sits behind the subject, not a new view. */
  "cameraYaw",
  /** Camera pitch offset in degrees, likewise additive. */
  "cameraPitch",
] as const;
export type SceneInteractionTarget = (typeof SCENE_TARGET_NAMES)[number];

/** Shared fields of an input→param binding: per frame `value = mix(from ?? authoredBase, to,
 *  smoothedSource)`, written straight to uniforms — never mutates config, so any refresh restores
 *  the authored base (removal needs no undo step). */
export interface InteractionBindingBase {
  /** The input signal driving this binding. */
  source: InteractionSource;
  /** Value at source = 0. OMITTED = the authored base value, so at rest the authored look shows. */
  from?: number;
  /** Value at source = 1. */
  to: number;
  /** Exponential smoothing time constant, seconds (default 0.25); also shapes the `appear` ramp. */
  smoothing?: number;
}
/** A binding on a shape, driving one of that shape's params. */
export interface ItemInteractionBinding extends InteractionBindingBase {
  target: ItemInteractionTarget;
}
/** A binding on a lamp, driving that lamp's position / size / intensity. */
export interface LampInteractionBinding extends InteractionBindingBase {
  target: LampInteractionTarget;
}
/** A scene-level binding, driving a shared scene param. */
export interface SceneInteractionBinding extends InteractionBindingBase {
  target: SceneInteractionTarget;
}

/** Per-shape interactivity: input→param bindings driving THIS shape's optics or position. */
export interface ItemInteractionConfig {
  bindings?: ItemInteractionBinding[];
}

/** Scene-level interactivity: the SHARED inputs (one cursor + scroll, touch) plus bindings that
 *  drive shared scene params. ABSENT ⇒ inputs use defaults; `enabled: false` is the master OFF
 *  switch for the whole layer. */
export interface SceneInteractionConfig {
  /** Master switch for the whole interaction layer. Default true (only `false` turns it all off). */
  enabled?: boolean;
  /** Follow coarse (touch) pointers. Default false — touch is ignored unless this is true. */
  touch?: boolean;
  /** Input→param bindings driving SCENE params (time / camera / post / lamp gain). */
  bindings?: SceneInteractionBinding[];
}

/** True for a valid interaction source string: a built-in name or a non-empty `custom:<name>`. */
export function isInteractionSource(v: unknown): v is InteractionSource {
  return (
    typeof v === "string" &&
    ((INTERACTION_SOURCE_NAMES as readonly string[]).includes(v) ||
      (v.startsWith("custom:") && v.length > "custom:".length))
  );
}

/** Rebuild an untrusted bindings array into valid bindings for `valid` targets (loaded share-links
 *  / presets are untrusted JSON; validate source/target/to and rebuild clean objects). */
export function cleanBindings<T extends string>(
  raw: unknown,
  valid: readonly string[],
): Array<InteractionBindingBase & { target: T }> {
  const out: Array<InteractionBindingBase & { target: T }> = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const b = entry as Record<string, unknown>;
    if (!isInteractionSource(b.source)) continue;
    if (!valid.includes(b.target as string)) continue;
    const to = Number(b.to);
    if (!Number.isFinite(to)) continue;
    const clean: InteractionBindingBase & { target: T } = {
      source: b.source,
      target: b.target as T,
      to,
    };
    if (b.from !== undefined) {
      const from = Number(b.from);
      if (Number.isFinite(from)) clean.from = from;
    }
    if (b.smoothing !== undefined) clean.smoothing = clamp(num(b.smoothing, 0.25), 0, 2);
    out.push(clean);
  }
  return out;
}

/** Present-only normalizer for a shape's interaction block. NEVER called when the block is
 *  absent — absence is inert and stays absent, so a non-interactive scene is byte-identical. */
export function normalizeItemInteraction(raw: ItemInteractionConfig): ItemInteractionConfig {
  const out: ItemInteractionConfig = {};
  if (raw.bindings !== undefined) {
    out.bindings = cleanBindings<ItemInteractionTarget>(raw.bindings, ITEM_TARGET_NAMES);
  }
  return out;
}

/** Present-only normalizer for the scene interaction block. */
export function normalizeSceneInteraction(raw: SceneInteractionConfig): SceneInteractionConfig {
  const out: SceneInteractionConfig = {};
  if (raw.enabled !== undefined) out.enabled = raw.enabled !== false;
  if (raw.touch !== undefined) out.touch = raw.touch === true;
  if (raw.bindings !== undefined) {
    out.bindings = cleanBindings<SceneInteractionTarget>(raw.bindings, SCENE_TARGET_NAMES);
  }
  return out;
}

/**
 * Procedural item generation. Present = the renderer builds `items` from this, deterministically
 * from `seed`, and `items` is ignored. That keeps a 16-rod scene a dozen lines of JSON and gives
 * the studio a live `count` slider. Set it to `undefined` (or pass an `items` array) to author
 * every shape by hand instead.
 */
export interface ScatterConfig {
  count: number;
  seed: number;
  /** Template every generated shape starts from; `r` and `len` are then varied. */
  shape: ShapeConfig;
  material: Partial<MaterialConfig>;
  /** The motion every generated shape gets. */
  motion: MotionConfig;
  /**
   * Phase step between successive generated shapes. It has to span a full turn — at
   * `stagger ≈ 2π / count` the phases distribute evenly and the trough of the wave travels; well
   * below that they cluster and it sits still.
   */
  stagger: number;
  /** Items are laid out along X across this span, centred on `position`. */
  spanX: number;
  position: Vec3;
  /** Random depth spread along Z. */
  spread: number;
  /** Fraction by which a shape's length may be cut (0 = every shape full length). */
  lengthVariance: number;
  /** Absolute radius jitter added to the template's `r`. */
  radiusVariance: number;
  /** Random per-item phase, in radians. */
  phaseJitter: number;
  /**
   * Reactions every generated shape gets — each shape receives its OWN copy of these bindings,
   * so per-shape sources (`hoverSelf` / `pressSelf`) resolve and smooth per shape: the rod under
   * the cursor answers, its neighbours don't. Absent = the generated shapes are inert, exactly
   * as an item with no `interaction` block is.
   */
  interaction?: ItemInteractionConfig;
}

export interface SceneConfig {
  /** Backdrop base colour (sRGB hex). Still used when {@link transparentBackground} is on: it is
   *  what the frame fades toward, so blurred glass edges dissolve into something sensible
   *  instead of into black. */
  background: string;
  /**
   * Drop the backdrop and render the scene over transparency, so the glass composites onto
   * whatever is behind the canvas.
   *
   * Note what this does and does not mean. The gaps between shapes become transparent, and haze
   * fades the shapes out toward the page rather than toward a painted colour. The glass itself
   * still refracts the **lamp field**, not the page — sampling the DOM is the one thing this
   * renderer deliberately does not do (see the positioning notes). Where no lamp sits behind a
   * shape it falls back to {@link clearGlass}, so pick that to suit the surface you are over.
   *
   * Setting `background: "transparent"` is sugar for turning this on.
   */
  transparentBackground: boolean;
  /** What glass looks like where no lamp sits behind it — a hair off white, never pure white. */
  clearGlass: string;
  lamps: LampConfig[];
  /** The room reflections fall back on. See {@link StudioKind}. */
  studio: StudioKind;
  /** See {@link ENVIRONMENT_MODES}. */
  environment: EnvironmentMode;
  /** See {@link TRANSMISSION_MODES}. */
  transmission: TransmissionMode;
  /** Brightness of the `softbox` studio. Ignored by `gradient`. */
  studioGain: number;
  /** Scales total lamp coverage before the gate. */
  lampGain: number;
  /** Coverage gate. Without it every lamp's Gaussian tail extends everywhere, so every shape
   *  carries *some* tint and nothing reads as transparent. Gating the tails to zero is what
   *  produces genuinely clear regions — and, counterintuitively, what lets the tinted regions be
   *  *more* saturated, since coverage no longer has to be dialled down globally. */
  lampGate: { lo: number; hi: number };
  /** How much of the lamp field shows on the backdrop itself. If colour appears *only* inside
   *  glass the eye reads it as tint however it was computed; a faint presence in the gaps is
   *  what sells "behind". ~0.05 is the reference. */
  backdropLamps: number;
  plate: PlateConfig;
  camera: CameraConfig;
  post: PostConfig;
  /** Drag to orbit, wheel to dolly. Off for a pure background. */
  orbit: boolean;
  /**
   * Measure each shape's optical path from a back-face depth pass instead of assuming a cylinder.
   *
   * Costs one extra full-scene render. Worth it for discs, spheres, cones, rings and arrows, whose
   * thickness the analytic fallback can only approximate with a single per-shape constant.
   *
   * OFF by default, which is not laziness: for a rod seen across its axis the fallback is the
   * EXACT chord, so on a rod scene this pass buys nothing and costs a pass — and because the
   * measurement comes from a 16-bit packed depth buffer, its quantisation actually moves the
   * result about 1% away from the analytic answer. Defaulting it on would make the calibrated
   * reference scene very slightly worse in order to fix scenes that do not use rods. Presets built
   * from other shapes turn it on themselves.
   */
  /**
   * Trace the refracted ray against a convex solid's own faces instead of displacing the sample in
   * screen space.
   *
   * The offset it replaces bends the sample by the surface normal, weighted toward the rim. For a
   * rod that is very nearly exact — the surface curves smoothly and the exit is always roughly
   * opposite the entry. For flat faces and hard edges it is not: a refracted ray can leave through
   * a different face entirely, and no rim weighting reproduces that. Tracing also yields the true
   * path length, so the Beer-Lambert term stops guessing a chord.
   *
   * Only convex lathes of 3 or 4 sides qualify; everything else keeps the offset.
   */
  tracedRefraction: boolean;
  /** Brightness of the inner-interface pass. 0 turns it off; needs `tracedRefraction`. */
  backGlassStrength: number;

  measuredThickness: boolean;

  /**
   * Length of a seamless loop in seconds. 0 disables it.
   *
   * Every motion's rate is snapped to a whole number of cycles over this window, so a clip
   * recorded at exactly this duration cuts back to its first frame without a jump. Without it a
   * recording ends wherever the motion happened to be — which is what every export did before.
   */
  loopSeconds: number;
  /**
   * Ease animation in over ~1s on load rather than starting at full speed.
   *
   * Affects live playback only. `seek()` sets an absolute time, so exports, posters and thumbnails
   * are untouched and stay reproducible.
   */
  introRamp: boolean;

  /** Flip the finished frame horizontally / vertically. */
  mirrorH: boolean;
  mirrorV: boolean;

  // -- Backdrop -------------------------------------------------------------
  /**
   * What the backdrop is painted with. `color` is the original behaviour — a gentle vertical ramp
   * derived from {@link SceneConfig.background}.
   *
   * Worth knowing: the backdrop is not merely composited behind the glass. It is rendered into the
   * plate pass, which every shape samples as its refraction source, so whatever goes here is bent,
   * dispersed and blurred through the glass rather than sitting flat behind it.
   */
  backgroundMode: BackgroundMode;
  /** Palette for the non-mesh gradients. */
  backgroundPalette: ColorStop[];
  backgroundGradientType: GradientType;
  /** Ramp direction in radians. Ignored by `radial` and `mesh`. */
  backgroundGradientAngle: number;
  backgroundMeshPoints: MeshGradientPoint[];
  /** Blob falloff for the mesh gradient — larger is softer. */
  backgroundMeshSoftness: number;
  /** A still image, as a URL or data URI. */
  backgroundImageUrl?: string;
  /** A video, as a URL or object URL. Takes precedence over the image when both are set. */
  backgroundVideoUrl?: string;
  backgroundImageFit: BackgroundImageFit;
  backgroundImageZoom: number;
  /** Pan, in fractions of the frame. */
  backgroundImagePosition: Vec2;
  items: ItemConfig[];
  /** Shape groupings. Derived from the shapes' own `group` ids, so this is a name registry rather
   *  than the source of truth — see {@link GroupConfig}. */
  groups: GroupConfig[];
  scatter?: ScatterConfig;
  /** A traced, dispersing light beam. ABSENT ⇒ no beam. See {@link BeamConfig}. */
  beam?: BeamConfig;
  /** Airborne dust lit by the bloom pyramid. ABSENT ⇒ none. See {@link DustConfig}. */
  dust?: DustConfig;
  /** Shared interaction inputs (one cursor + scroll) + scene-param bindings. Per-shape response
   *  lives on each ItemConfig.interaction, per-lamp on LampConfig.bindings. ABSENT = off unless a
   *  shape or lamp carries bindings; `enabled: false` disables the whole layer. */
  interaction?: SceneInteractionConfig;
  /** Render-target scale (0.5–1) for the depth/plate/main passes. The post pass always runs at
   *  full canvas resolution, so dropping this softens the glass without softening the grain. */
  quality: number;
  /** Ceiling on devicePixelRatio. Four passes per frame is a real cost — this is the main knob. */
  dprMax: number;
  paused: boolean;
  /** Animation-time offset, in seconds. Scrubs to a chosen still frame. */
  timeOffset: number;
}

/** The defaults every shape spec starts from; `kind` decides which fields are read. */
/**
 * The natural `sides` for a kind, because the field means two different things.
 *
 * On `prism` and `hex` it counts FACES, and 3 and 6 are the whole point of those kinds. Everywhere
 * else it counts radial SEGMENTS and is a smoothness knob, where the same 3 is degenerate — a
 * three-segment sphere is a triangular bipyramid, not a low-poly sphere. Carrying a value across
 * that boundary is what makes a prism preset render every other kind as a triangle, so anything
 * switching a shape's kind should re-derive this rather than keep the old number.
 *
 * `hex` is fixed at 6 by its geometry and ignores the field; it is listed so a switch away from it
 * starts somewhere sensible.
 */
export function defaultSides(kind: ShapeKind): number {
  if (kind === "prism") return 3;
  if (kind === "hex") return 6;
  return 72;
}

export function createShape(kind: ShapeKind = "rod"): ShapeConfig {
  return {
    kind,
    // Only on the kind that reads it: an outline on a rod would be dead weight in every export.
    ...(kind === "path" ? { outline: DEFAULT_OUTLINE } : {}),
    r: 0.4,
    len: 8,
    thickness: 0.5,
    fillet: 0,
    bevel: 0,
    sides: defaultSides(kind),
    hole: 1,
    shaft: 0.35,
    head: 1,
    depth: 0.5,
    seed: 1,
    bump: 0.5,
  };
}

export function createMaterial(): MaterialConfig {
  return {
    path: 0.4,
    density: 3.4,
    tint: "",
    ior: 1.45,
    dispersion: 0.03,
    lens: 0.055,
    rim: 0.45,
    // 0.35, not the 0.95 this shipped with. The highlight term was widened (a softer lobe, plus a
    // fill key that flat and cylindrical shapes can actually reach), so a unit of `specular` now
    // delivers several times what it used to: at 0.95 the reference scene's rods came out with
    // blown white streaks down them. Same look, smaller number.
    specular: 0.35,
    saturation: 1.12,
    hueShift: 0,
    emission: 0.08,
    kind: "glass",
    ripple: 0.45,
    rippleScale: 1.4,
    flow: 0.9,
    iridescence: 0,
    filmNm: 380,
    roughness: 0.35,
    sparkle: 0.5,
    sparkleScale: 26,
    albedo: "#c9c6cf",
    edgeTint: "",
  };
}

/**
 * A new shape. Pass `from` to clone an existing one — everything it has (shape, material, motion,
 * phase, name, group; the `shape` argument is ignored) except its position, which is nudged along
 * X so the new shape lands beside its source rather than inside it. Adding a shape almost always
 * means "another one of those", so copying is the useful default and starting from scratch is the
 * special case.
 */
export function createItem(shape: ShapeConfig = createShape(), from?: ItemConfig): ItemConfig {
  if (from) {
    const clone = structuredClone(from);
    clone.position = { ...from.position, x: from.position.x + Math.max(1, from.shape.r * 2.5) };
    return clone;
  }
  return {
    shape,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    material: {},
    motion: createMotion(),
    phase: 0,
  };
}

export function createLamp(x = 0.5, y = 0.3, color = "#f8c852"): LampConfig {
  return { x, y, r: 0.1, color, intensity: 1 };
}

export function createDefaultConfig(): SceneConfig {
  return {
    background: "#efedeb",
    transparentBackground: false,
    clearGlass: "#f2f1f0",
    studio: "gradient",
    environment: "analytic",
    transmission: "simple",
    studioGain: 1,
    lamps: [
      { x: 0.5, y: 0.12, r: 0.128, color: "#f8c852", intensity: 1 },
      { x: 0.39, y: 0.26, r: 0.09, color: "#f59d3e", intensity: 1 },
      { x: 0.53, y: 0.35, r: 0.096, color: "#ef5a4d", intensity: 1 },
      { x: 0.63, y: 0.22, r: 0.094, color: "#ea4776", intensity: 1 },
      { x: 0.29, y: 0.19, r: 0.096, color: "#e55392", intensity: 1 },
      { x: 0.75, y: 0.34, r: 0.098, color: "#d45cb4", intensity: 1 },
      { x: 0.86, y: 0.19, r: 0.088, color: "#b461cb", intensity: 1 },
      { x: 0.19, y: 0.37, r: 0.09, color: "#8a72d6", intensity: 1 },
      { x: 0.68, y: 0.45, r: 0.076, color: "#c4d368", intensity: 1 },
      { x: 0.34, y: 0.44, r: 0.076, color: "#719cdd", intensity: 1 },
    ],
    lampGain: 1.75,
    lampGate: { lo: 0.12, hi: 0.9 },
    backdropLamps: 0.05,
    plate: { z: -3, scale: { x: 26, y: 20 }, offset: { x: 0.5, y: 0.52 } },
    camera: {
      fov: 12,
      distance: 44,
      lookAt: { x: 0, y: -2.9, z: 0 },
      height: -1.9,
      roll: 0,
      fit: "cover",
      minVisibleWidth: 0,
    },
    post: {
      focus: 44,
      range: 4.4,
      aperture: 18,
      bloom: 0.03,
      caustics: 0.55,
      haze: 0.85,
      hazeTop: 0.36,
      hazeColor: "#fcfaf6",
      vignette: 0.18,
      grain: 0.014,
      bloomRadius: 9,
      bloomThreshold: 0,
      toneMap: "none",
      bloomMode: "gather",
      bloomSpread: 0.5,
      innerLight: 0,
      innerLightDensity: 0.5,
      innerLightDecay: 0.94,
      innerLightX: 0.5,
      innerLightY: 0.15,
      dither: 0,
      ditherScale: 2,
      ditherSteps: 4,
      halftone: 0,
      halftoneCell: 6,
      halftoneAngle: 0.4,
      halftoneCmyk: 0,
      halftoneCmykCell: 6,
      paperTexture: 0,
      paperTextureScale: 2,
    },
    orbit: true,
    tracedRefraction: false,
    backGlassStrength: 0,
    measuredThickness: false,
    loopSeconds: 0,
    introRamp: true,
    mirrorH: false,
    mirrorV: false,
    backgroundMode: "color",
    backgroundPalette: [
      { color: "#efedeb", position: 0 },
      { color: "#d9d5f0", position: 1 },
    ],
    backgroundGradientType: "linear",
    backgroundGradientAngle: Math.PI / 2,
    backgroundMeshPoints: [
      { x: 0.25, y: 0.3, color: "#f3d9e8" },
      { x: 0.75, y: 0.35, color: "#d7e0f6" },
      { x: 0.5, y: 0.8, color: "#f7f0e4" },
    ],
    backgroundMeshSoftness: 0.55,
    backgroundImageFit: "cover",
    backgroundImageZoom: 1,
    backgroundImagePosition: { x: 0.5, y: 0.5 },
    items: [],
    groups: [],
    scatter: {
      count: 16,
      seed: 11,
      shape: { ...createShape("rod"), r: 0.36, len: 12 },
      material: { density: 3.4 },
      motion: { kind: "skewer", axis: "x", rate: 0.34, amount: 0.16 },
      stagger: 0.393,
      spanX: 16.6,
      position: { x: 0, y: -4.6, z: 0 },
      spread: 3.2,
      lengthVariance: 0.38,
      radiusVariance: 0.15,
      phaseJitter: 0.45,
    },
    quality: 1,
    dprMax: 1.75,
    paused: false,
    timeOffset: 0,
  };
}

/** Spellings of "no backdrop" accepted in the `background` field. */
const TRANSPARENT_KEYWORDS = new Set(["transparent", "none", ""]);

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function vec3(value: Partial<Vec3> | undefined, fallback: Vec3): Vec3 {
  return {
    x: num(value?.x, fallback.x),
    y: num(value?.y, fallback.y),
    z: num(value?.z, fallback.z),
  };
}

function vec2(value: Partial<Vec2> | undefined, fallback: Vec2): Vec2 {
  return { x: num(value?.x, fallback.x), y: num(value?.y, fallback.y) };
}

/**
 * What {@link normalizeShape} accepts: a spec off disk, out of a URL or from a hand edit, where
 * any field may be missing or wrong — including any field of a cut. `Partial<ShapeConfig>` alone
 * would make the `cuts` array optional but still demand six complete numbers from every entry it
 * did contain, which is precisely the input this function exists to not trust.
 */
export type ShapeInput = Partial<Omit<ShapeConfig, "cuts">> & {
  cuts?: readonly Partial<CutConfig>[];
};

export function normalizeShape(shape: ShapeInput | undefined): ShapeConfig {
  const base = createShape(
    SHAPE_KINDS.includes(shape?.kind as ShapeKind) ? (shape?.kind as ShapeKind) : "rod",
  );
  const out: ShapeConfig = {
    kind: base.kind,
    r: Math.max(0.001, num(shape?.r, base.r)),
    len: Math.max(0.001, num(shape?.len, base.len)),
    thickness: Math.max(0.001, num(shape?.thickness, base.thickness)),
    // Three states, not two. Positive is a literal radius; `0` means "pick a proportional one"
    // (see resolveFillet); NEGATIVE means none at all, which only `path` can honour — every other
    // kind reads a negative exactly as it reads 0, because `resolveFillet` tests `> 0`. That
    // asymmetry is deliberate: a lathe with no fillet collapses its corner arc onto a single point
    // and hands the mesh a fan of degenerate triangles, the defect `cone` goes out of its way to
    // avoid. An extrusion just turns the bevel off.
    fillet: num(shape?.fillet, base.fillet),
    bevel: Math.max(0, num(shape?.bevel, base.bevel)),
    sides: Math.round(clamp(num(shape?.sides, base.sides), 3, 256)),
    hole: Math.max(0, num(shape?.hole, base.hole)),
    shaft: Math.max(0.001, num(shape?.shaft, base.shaft)),
    head: Math.max(0.001, num(shape?.head, base.head)),
    depth: Math.max(0.001, num(shape?.depth, base.depth)),
    seed: Math.round(num(shape?.seed, base.seed)),
    bump: clamp01(num(shape?.bump, base.bump)),
  };
  // A ring whose hole swallows its outer radius produces degenerate (inside-out) geometry.
  if (out.kind === "ring") out.hole = Math.min(out.hole, out.r * 0.98);
  // The outline is kept whatever the kind, not just on `path`. The studio edits one shape object
  // and lets the kind decide what it reads, so dropping it on a switch away would silently
  // destroy the only field here a user has to type by hand rather than drag.
  // Markup first, cap second. A pasted `.svg` document is far longer than the cap, so capping the
  // raw string would truncate the markup and leave the extractor nothing to find.
  const outline =
    typeof shape?.outline === "string" ? outlineFromSvg(shape.outline, MAX_OUTLINE) : "";
  if (outline) out.outline = outline;
  else if (out.kind === "path") out.outline = DEFAULT_OUTLINE;
  const cuts = normalizeCuts(shape?.cuts);
  if (cuts.length > 0) out.cuts = cuts;
  return out;
}

/**
 * Clean a cut list. Anything that would extrude into broken geometry is clamped, not rejected:
 * a zero-width rect collapses its walls into a crease that shows through the refraction as a
 * black seam, and a corner radius past half the short side inverts the fillet arcs.
 *
 * Empty in, empty out — the caller drops the field entirely rather than storing `[]`.
 */
function normalizeCuts(input: unknown): CutConfig[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_CUTS).map((raw: Partial<CutConfig> | undefined) => {
    const kind: CutKind = CUT_KINDS.includes(raw?.kind as CutKind)
      ? (raw?.kind as CutKind)
      : "rect";
    const base = createCut(kind);
    const w = Math.max(0.01, num(raw?.w, base.w));
    // A circle is defined by `w` alone, so its height has to follow rather than be believed:
    // an authored `h` would silently turn it into an ellipse the `kind` does not describe.
    const h = kind === "circle" ? w : Math.max(0.01, num(raw?.h, base.h));
    return {
      kind,
      x: num(raw?.x, base.x),
      y: num(raw?.y, base.y),
      w,
      h,
      r: kind === "circle" ? w / 2 : clamp(num(raw?.r, base.r), 0, Math.min(w, h) / 2),
      rotation: num(raw?.rotation, base.rotation),
    };
  });
}

/** Fill in a partial material, clamping the values that can produce a broken frame rather than
 *  an ugly one (a negative σ inverts Beer–Lambert; an IOR below 1 flips the refraction). */
export function resolveMaterial(material: Partial<MaterialConfig> | undefined): MaterialConfig {
  const base = createMaterial();
  return {
    path: Math.max(0.001, num(material?.path, base.path)),
    density: Math.max(0, num(material?.density, base.density)),
    // Absent stays absent: an absorption of zero is a real, meaningful material (perfectly clear),
    // so it must not be confused with "not asked for".
    ...(material?.absorption
      ? {
          absorption: {
            x: Math.max(0, num(material.absorption.x, 0)),
            y: Math.max(0, num(material.absorption.y, 0)),
            z: Math.max(0, num(material.absorption.z, 0)),
          },
        }
      : {}),
    tint: typeof material?.tint === "string" ? material.tint : base.tint,
    kind: MATERIAL_KINDS.includes(material?.kind as MaterialKind)
      ? (material?.kind as MaterialKind)
      : base.kind,
    ripple: clamp01(num(material?.ripple, base.ripple)),
    rippleScale: clamp(num(material?.rippleScale, base.rippleScale), 0.05, 20),
    flow: clamp(num(material?.flow, base.flow), 0, 6),
    iridescence: clamp01(num(material?.iridescence, base.iridescence)),
    filmNm: clamp(num(material?.filmNm, base.filmNm), 50, 1500),
    roughness: clamp01(num(material?.roughness, base.roughness)),
    sparkle: clamp01(num(material?.sparkle, base.sparkle)),
    sparkleScale: clamp(num(material?.sparkleScale, base.sparkleScale), 2, 200),
    albedo: typeof material?.albedo === "string" ? material.albedo : base.albedo,
    edgeTint: typeof material?.edgeTint === "string" ? material.edgeTint : base.edgeTint,
    ior: clamp(num(material?.ior, base.ior), 1.0001, 4),
    dispersion: clamp(num(material?.dispersion, base.dispersion), 0, 0.4),
    lens: Math.max(0, num(material?.lens, base.lens)),
    rim: clamp01(num(material?.rim, base.rim)),
    specular: Math.max(0, num(material?.specular, base.specular)),
    saturation: Math.max(0, num(material?.saturation, base.saturation)),
    // Hue rotation is periodic; one turn either way covers every colour it can reach.
    hueShift: clamp(num(material?.hueShift, base.hueShift), -1, 1),
    emission: Math.max(0, num(material?.emission, base.emission)),
  };
}

export function normalizeMotion(motion: Partial<MotionConfig> | undefined): MotionConfig {
  const base = createMotion();
  return {
    kind: MOTION_KINDS.includes(motion?.kind as MotionKind) ? (motion?.kind as MotionKind) : "none",
    axis: motion?.axis === "y" || motion?.axis === "z" ? motion.axis : "x",
    rate: num(motion?.rate, base.rate),
    amount: num(motion?.amount, base.amount),
  };
}

export function normalizeItem(item: Partial<ItemConfig> | undefined): ItemConfig {
  const shape = normalizeShape(item?.shape);
  return {
    shape,
    position: vec3(item?.position, { x: 0, y: 0, z: 0 }),
    rotation: vec3(item?.rotation, { x: 0, y: 0, z: 0 }),
    scale: vec3(item?.scale, { x: 1, y: 1, z: 1 }),
    name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : undefined,
    group: typeof item?.group === "string" && item.group.trim() ? item.group.trim() : undefined,
    material: item?.material ?? {},
    motion: normalizeMotion(item?.motion),
    phase: num(item?.phase, 0),
    // Present-only: absence is inert and stays absent, so a non-interactive scene round-trips
    // byte-identical.
    ...(item?.interaction && typeof item.interaction === "object"
      ? { interaction: normalizeItemInteraction(item.interaction) }
      : {}),
  };
}

function normalizeLamp(lamp: Partial<LampConfig> | undefined): LampConfig {
  return {
    x: num(lamp?.x, 0.5),
    y: num(lamp?.y, 0.3),
    r: Math.max(0.001, num(lamp?.r, 0.1)),
    color: typeof lamp?.color === "string" ? lamp.color : "#ffffff",
    intensity: Math.max(0, num(lamp?.intensity, 1)),
    ...(lamp?.bindings !== undefined
      ? { bindings: cleanBindings<LampInteractionTarget>(lamp.bindings, LAMP_TARGET_NAMES) }
      : {}),
  };
}

function normalizeBeam(beam: Partial<BeamConfig>): BeamConfig {
  const out: BeamConfig = {
    radius: Math.max(0.01, num(beam.radius, 2)),
    // Two sides is not a polygon and the tracer would find no interior to refract into.
    sides: Math.max(3, Math.round(num(beam.sides, 3))),
    rotation: num(beam.rotation, Math.PI / 2),
    z: num(beam.z, 0),
    face: Math.max(0, Math.round(num(beam.face, 0))),
    incidence: num(beam.incidence, 52),
    entry: clamp01(num(beam.entry, 0.5)),
    distance: Math.max(0.01, num(beam.distance, 18)),
    width: Math.max(1e-3, num(beam.width, 0.06)),
    // Below 1 the ray bends the wrong way at every surface and the beam turns inside out.
    ior: Math.max(1, num(beam.ior, 1.245)),
    dispersion: Math.max(0, num(beam.dispersion, 0.06)),
    // Capped: the mesh is retraced whenever the beam moves, and the cost is samples × slices.
    samples: clamp(Math.round(num(beam.samples, 128)), 8, 256),
    slices: clamp(Math.round(num(beam.slices, 24)), 1, 64),
    exposure: Math.max(0, num(beam.exposure, 88)),
    edgeFalloff: Math.max(0, num(beam.edgeFalloff, 16)),
    revealSeconds: Math.max(0, num(beam.revealSeconds, 0)),
    falloffRate: Math.max(0, num(beam.falloffRate, 3.8)),
    falloffPower: Math.max(0.0001, num(beam.falloffPower, 3.7)),
    causticStrength: Math.max(0, num(beam.causticStrength, 1.9)),
    causticCoverage: clamp01(num(beam.causticCoverage, 0.86)),
    causticFarDesaturation: Math.max(0, num(beam.causticFarDesaturation, 0.04)),
    causticFarBrightness: Math.max(0, num(beam.causticFarBrightness, 0.02)),
    causticRateScale: Math.max(0, num(beam.causticRateScale, 0.12)),
    causticPowerScale: Math.max(0, num(beam.causticPowerScale, 0.5)),
    causticNormalInfluence: clamp01(num(beam.causticNormalInfluence, 1)),
    causticNormalElevation: clamp(num(beam.causticNormalElevation, 35), 5, 85),
    intensity: Math.max(0, num(beam.intensity, 1)),
  };
  // Absent stays absent: an empty `target` means "no item", not "the item called nothing", and an
  // `entryAngle` of 0 is a real angle that must not be confused with not having asked for one.
  const targets = (Array.isArray(beam.targets) ? beam.targets : []).filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );
  if (targets.length > 0) out.targets = targets;
  if (Number.isFinite(beam.entryAngle)) out.entryAngle = num(beam.entryAngle, 0);
  if (Number.isFinite(beam.entrySweep)) out.entrySweep = Math.max(0, num(beam.entrySweep, 90));
  return out;
}

function normalizeDust(dust: Partial<DustConfig>): DustConfig {
  return {
    count: clamp(Math.round(num(dust.count, 2400)), 0, 40000),
    extent: vec3(dust.extent, { x: 26, y: 16, z: 12 }),
    size: Math.max(0, num(dust.size, 1)),
    intensity: Math.max(0, num(dust.intensity, 1)),
    drift: num(dust.drift, 0.25),
    falloffPower: Math.max(0.01, num(dust.falloffPower, 5.5)),
    response: Math.max(0, num(dust.response, 82)),
    seed: Math.floor(num(dust.seed, 7)),
  };
}

function normalizeScatter(scatter: Partial<ScatterConfig>): ScatterConfig {
  const d = createDefaultConfig().scatter as ScatterConfig;
  return {
    // The cap is geometry budget, not a shader limit: 200 lathed shapes × 4 passes is already
    // more than a hero section should ask of a phone.
    count: Math.round(clamp(num(scatter.count, d.count), 0, 200)),
    seed: Math.round(num(scatter.seed, d.seed)),
    shape: normalizeShape(scatter.shape ?? d.shape),
    material: scatter.material ?? d.material,
    motion: normalizeMotion(scatter.motion ?? d.motion),
    stagger: num(scatter.stagger, d.stagger),
    spanX: num(scatter.spanX, d.spanX),
    position: vec3(scatter.position, d.position),
    spread: num(scatter.spread, d.spread),
    lengthVariance: clamp01(num(scatter.lengthVariance, d.lengthVariance)),
    radiusVariance: Math.max(0, num(scatter.radiusVariance, d.radiusVariance)),
    phaseJitter: Math.max(0, num(scatter.phaseJitter, d.phaseJitter)),
    // Present-only, like an item's block: absence stays absent so an inert scatter round-trips
    // byte-identically.
    ...(scatter.interaction !== undefined
      ? { interaction: normalizeItemInteraction(scatter.interaction) }
      : {}),
  };
}

/** Clamp a palette to the shipped maximum and sort it, so the shader can walk it in order. */
function normalizeStops(input: unknown, fallback: ColorStop[]): ColorStop[] {
  if (!Array.isArray(input) || input.length === 0) return fallback.map((s) => ({ ...s }));
  return (
    input
      .slice(0, MAX_STOPS)
      .map((stop: Partial<ColorStop> | undefined) => ({
        color: typeof stop?.color === "string" ? stop.color : "#ffffff",
        position: clamp01(num(stop?.position, 0)),
      }))
      // Not `.toSorted()`: that is ES2023 (Safari ≥ 16.4) and would quietly raise the package's
      // stated es2022 floor. The `.map()` above already made a fresh array, so `.sort()` in place
      // mutates nothing the caller owns.
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((a, b) => a.position - b.position)
  );
}

function normalizeMeshPoints(input: unknown, fallback: MeshGradientPoint[]): MeshGradientPoint[] {
  if (!Array.isArray(input) || input.length === 0) return fallback.map((p) => ({ ...p }));
  return input.slice(0, MAX_MESH_POINTS).map((point: Partial<MeshGradientPoint> | undefined) => ({
    x: num(point?.x, 0.5),
    y: num(point?.y, 0.5),
    color: typeof point?.color === "string" ? point.color : "#ffffff",
  }));
}

/**
 * Reconcile the group registry against what the shapes actually claim.
 *
 * The shapes are the source of truth, so this both directions: an id declared here but claimed by
 * nobody is dropped, and an id claimed by shapes but never declared is synthesized. That makes the
 * `groups` array optional in authored JSON, and it means the registry can never drift into
 * referencing shapes that a hand edit deleted.
 *
 * A group of fewer than two shapes is dissolved — its member simply loses the reference. A group
 * of one is not a group, and leaving them behind would accumulate ghosts every time a scene was
 * pruned down.
 */
function normalizeGroups(
  input: Partial<SceneConfig>["groups"],
  items: ItemConfig[],
): GroupConfig[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.group) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count >= MIN_GROUP_SIZE) continue;
    counts.delete(id);
    for (const item of items) {
      if (item.group === id) item.group = undefined;
    }
  }

  const out: GroupConfig[] = [];
  const seen = new Set<string>();
  for (const group of Array.isArray(input) ? input : []) {
    const id = typeof group?.id === "string" ? group.id.trim() : "";
    if (!id || seen.has(id) || !counts.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof group.name === "string" && group.name.trim() ? group.name.trim() : undefined,
    });
  }
  // Declared by a shape but not by the registry — keep the shapes' claim and give it a home.
  for (const id of counts.keys()) {
    if (!seen.has(id)) out.push({ id });
  }
  return out;
}

/**
 * Fill a partial/imported config out to a complete one, clamping anything that could produce a
 * broken frame. Idempotent — the renderer runs it on every `setConfig`, and the studio round-trips
 * user-edited JSON through it.
 */
/**
 * What {@link ensureSceneConfig} accepts.
 *
 * `Partial<SceneConfig>` is not quite right: it makes the optional blocks optional but still
 * demands them COMPLETE, so `{ beam: { incidence: 41 } }` — the obvious thing to write, and what
 * the normalizer has always accepted at runtime — fails to typecheck. These are the blocks whose
 * normalizers fill in every field, so the type should say so.
 */
export type SceneConfigInput = Partial<Omit<SceneConfig, "beam" | "dust">> & {
  beam?: Partial<BeamConfig>;
  dust?: Partial<DustConfig>;
};

export function ensureSceneConfig(input: SceneConfigInput): SceneConfig {
  const d = createDefaultConfig();
  const lamps = (Array.isArray(input.lamps) ? input.lamps : d.lamps)
    .slice(0, MAX_LAMPS)
    .map(normalizeLamp);
  const gate = input.lampGate ?? d.lampGate;
  const lo = clamp01(num(gate.lo, d.lampGate.lo));
  const post = input.post ?? d.post;
  const camera = input.camera ?? d.camera;
  const plate = input.plate ?? d.plate;

  // `background: "transparent"` is a natural thing to reach for, so accept it and normalize it
  // into the flag. Keeping the colour separate means toggling transparency off restores whatever
  // backdrop you had, and one field stays the source of truth after normalization.
  // Note the `typeof` guard: an ABSENT `background` must fall through to the default, not be read
  // as the empty-string spelling of "transparent". Conflating the two made every share link that
  // dropped a default-valued `background` reopen with no backdrop at all.
  const wantsTransparent =
    input.transparentBackground === true ||
    (typeof input.background === "string" && TRANSPARENT_KEYWORDS.has(input.background));

  // Hoisted, because the group registry is reconciled against these very objects — and MUTATES
  // them, dissolving a group that no longer has two members.
  const items = (Array.isArray(input.items) ? input.items : []).map(normalizeItem);

  return {
    background:
      typeof input.background === "string" &&
      input.background &&
      !TRANSPARENT_KEYWORDS.has(input.background)
        ? input.background
        : d.background,
    transparentBackground: wantsTransparent,
    clearGlass: typeof input.clearGlass === "string" ? input.clearGlass : d.clearGlass,
    lamps,
    studio: STUDIO_KINDS.includes(input.studio as StudioKind)
      ? (input.studio as StudioKind)
      : d.studio,
    environment: ENVIRONMENT_MODES.includes(input.environment as EnvironmentMode)
      ? (input.environment as EnvironmentMode)
      : d.environment,
    transmission: TRANSMISSION_MODES.includes(input.transmission as TransmissionMode)
      ? (input.transmission as TransmissionMode)
      : d.transmission,
    studioGain: Math.max(0, num(input.studioGain, d.studioGain)),
    lampGain: Math.max(0, num(input.lampGain, d.lampGain)),
    // hi must stay above lo or the smoothstep inverts and the gate turns every clear region opaque.
    lampGate: { lo, hi: Math.max(lo + 1e-3, clamp01(num(gate.hi, d.lampGate.hi))) },
    backdropLamps: clamp01(num(input.backdropLamps, d.backdropLamps)),
    plate: {
      z: num(plate.z, d.plate.z),
      scale: vec2(plate.scale, d.plate.scale),
      offset: vec2(plate.offset, d.plate.offset),
    },
    camera: {
      fov: clamp(num(camera.fov, d.camera.fov), 1, 120),
      distance: Math.max(0.1, num(camera.distance, d.camera.distance)),
      lookAt: vec3(camera.lookAt, d.camera.lookAt),
      height: num(camera.height, d.camera.height),
      roll: num(camera.roll, d.camera.roll ?? 0),
      fit: CAMERA_FITS.includes(camera.fit as CameraFit)
        ? (camera.fit as CameraFit)
        : (d.camera.fit ?? "cover"),
      minVisibleWidth: clamp01(num(camera.minVisibleWidth, d.camera.minVisibleWidth ?? 0)),
    },
    post: {
      focus: num(post.focus, d.post.focus),
      range: Math.max(0.01, num(post.range, d.post.range)),
      aperture: Math.max(0, num(post.aperture, d.post.aperture)),
      bloom: Math.max(0, num(post.bloom, d.post.bloom)),
      caustics: Math.max(0, num(post.caustics, d.post.caustics)),
      haze: clamp01(num(post.haze, d.post.haze)),
      hazeTop: num(post.hazeTop, d.post.hazeTop),
      hazeColor: typeof post.hazeColor === "string" ? post.hazeColor : d.post.hazeColor,
      vignette: Math.max(0, num(post.vignette, d.post.vignette)),
      grain: Math.max(0, num(post.grain, d.post.grain)),
      bloomRadius: Math.max(0, num(post.bloomRadius, d.post.bloomRadius)),
      bloomThreshold: clamp01(num(post.bloomThreshold, d.post.bloomThreshold)),
      toneMap: TONE_MAPS.includes(post.toneMap as ToneMap)
        ? (post.toneMap as ToneMap)
        : d.post.toneMap,
      bloomMode: BLOOM_MODES.includes(post.bloomMode as BloomMode)
        ? (post.bloomMode as BloomMode)
        : d.post.bloomMode,
      bloomSpread: clamp01(num(post.bloomSpread, d.post.bloomSpread)),
      innerLight: Math.max(0, num(post.innerLight, d.post.innerLight)),
      innerLightDensity: Math.max(0, num(post.innerLightDensity, d.post.innerLightDensity)),
      innerLightDecay: clamp(num(post.innerLightDecay, d.post.innerLightDecay), 0.5, 1),
      innerLightX: num(post.innerLightX, d.post.innerLightX),
      innerLightY: num(post.innerLightY, d.post.innerLightY),
      dither: clamp01(num(post.dither, d.post.dither)),
      ditherScale: Math.max(1, num(post.ditherScale, d.post.ditherScale)),
      ditherSteps: clamp(num(post.ditherSteps, d.post.ditherSteps), 1, 32),
      halftone: clamp01(num(post.halftone, d.post.halftone)),
      halftoneCell: Math.max(2, num(post.halftoneCell, d.post.halftoneCell)),
      halftoneAngle: num(post.halftoneAngle, d.post.halftoneAngle),
      halftoneCmyk: clamp01(num(post.halftoneCmyk, d.post.halftoneCmyk)),
      halftoneCmykCell: Math.max(2, num(post.halftoneCmykCell, d.post.halftoneCmykCell)),
      paperTexture: clamp01(num(post.paperTexture, d.post.paperTexture)),
      paperTextureScale: Math.max(0.5, num(post.paperTextureScale, d.post.paperTextureScale)),
    },
    orbit: input.orbit ?? d.orbit,
    tracedRefraction: input.tracedRefraction ?? d.tracedRefraction,
    backGlassStrength: Math.max(0, num(input.backGlassStrength, d.backGlassStrength)),
    measuredThickness: input.measuredThickness ?? d.measuredThickness,
    loopSeconds: Math.max(0, num(input.loopSeconds, d.loopSeconds)),
    introRamp: input.introRamp ?? d.introRamp,
    mirrorH: input.mirrorH ?? d.mirrorH,
    mirrorV: input.mirrorV ?? d.mirrorV,
    backgroundMode: BACKGROUND_MODES.includes(input.backgroundMode as BackgroundMode)
      ? (input.backgroundMode as BackgroundMode)
      : d.backgroundMode,
    backgroundPalette: normalizeStops(input.backgroundPalette, d.backgroundPalette),
    backgroundGradientType: GRADIENT_TYPES.includes(input.backgroundGradientType as GradientType)
      ? (input.backgroundGradientType as GradientType)
      : d.backgroundGradientType,
    backgroundGradientAngle: num(input.backgroundGradientAngle, d.backgroundGradientAngle),
    backgroundMeshPoints: normalizeMeshPoints(input.backgroundMeshPoints, d.backgroundMeshPoints),
    backgroundMeshSoftness: clamp(
      num(input.backgroundMeshSoftness, d.backgroundMeshSoftness),
      0.05,
      2,
    ),
    backgroundImageUrl:
      typeof input.backgroundImageUrl === "string" ? input.backgroundImageUrl : undefined,
    backgroundVideoUrl:
      typeof input.backgroundVideoUrl === "string" ? input.backgroundVideoUrl : undefined,
    backgroundImageFit: BACKGROUND_IMAGE_FITS.includes(
      input.backgroundImageFit as BackgroundImageFit,
    )
      ? (input.backgroundImageFit as BackgroundImageFit)
      : d.backgroundImageFit,
    backgroundImageZoom: clamp(num(input.backgroundImageZoom, d.backgroundImageZoom), 0.1, 8),
    backgroundImagePosition: vec2(input.backgroundImagePosition, d.backgroundImagePosition),
    items,
    groups: normalizeGroups(input.groups, items),
    // An input that mentions neither gets the default scene's scatter — `{}` should render
    // something. Passing an `items` array (even an empty one) or an explicit `scatter: undefined`
    // is how you opt out, and both survive a JSON round trip.
    scatter: input.scatter
      ? normalizeScatter(input.scatter)
      : Array.isArray(input.items) || "scatter" in input
        ? undefined
        : normalizeScatter(d.scatter as ScatterConfig),
    // Unlike `scatter`, an absent beam stays absent: a beam is a deliberate composition, never
    // something a bare `{}` should conjure.
    ...(input.beam && typeof input.beam === "object" ? { beam: normalizeBeam(input.beam) } : {}),
    ...(input.dust && typeof input.dust === "object" ? { dust: normalizeDust(input.dust) } : {}),
    ...(input.interaction && typeof input.interaction === "object"
      ? { interaction: normalizeSceneInteraction(input.interaction) }
      : {}),
    quality: clamp(num(input.quality, d.quality), 0.35, 1),
    dprMax: clamp(num(input.dprMax, d.dprMax), 0.5, 4),
    paused: input.paused ?? d.paused,
    timeOffset: num(input.timeOffset, d.timeOffset),
  };
}
