/**
 * The light-sheet materials — beam, caustic and dust — as node graphs.
 *
 * These are the passes whose GEOMETRY carries most of the meaning: the beam mesh is traced on the
 * CPU and arrives with per-vertex colour, profile and travel, so the fragment stage only has to
 * shape what the tracer already decided. That is why so little of the optics appears here.
 */
import { TSL } from "three/webgpu";

type Vec = any;

const { Fn, float, vec3, vec4 } = TSL;
const select = (cond: Vec, ifTrue: Vec, ifFalse: Vec): Vec => TSL.select(cond, ifTrue, ifFalse);
const mix = (a: Vec, b: Vec, t: Vec): Vec => TSL.mix(a, b, t);

/**
 * Open the bundle from its CENTRE LINE outward.
 *
 * A beam that fades up in brightness reads as a lamp being turned on; one that opens from the
 * middle reads as a beam arriving, which is what these scenes are about. The two branches keep it
 * honest at the ends: at zero the mask is exactly zero rather than a residual hairline down the
 * axis, and at one it is exactly one rather than a smoothstep that never quite closes.
 *
 * The feather has a FLOOR because the outgoing fan carries one flat profile per slice, so the
 * derivative is zero across a cell's interior and adjacent slices would step against each other.
 */
export const widthReveal = Fn(([profile, reveal]: [Vec, Vec]) => {
  const antialias = TSL.fwidth(profile).mul(1.5).max(0.04);
  const open = float(1).sub(
    profile.abs().smoothstep(reveal.sub(antialias).max(0), reveal.add(antialias).min(1)),
  );
  return select(
    reveal.lessThanEqual(0),
    float(0),
    select(reveal.greaterThanEqual(1), float(1), open),
  );
});

export interface BeamUniforms {
  intensity: Vec;
  edgeFalloff: Vec;
  falloffRate: Vec;
  falloffPower: Vec;
  reveal: Vec;
}

/**
 * The beam, shaped across its width and along its travel.
 *
 * The longitudinal term is most of what makes a fan read as light spreading out rather than as a
 * painted stripe — around a 280-fold dilution across the frame at the shipped constants. Alpha is
 * ZERO: an additive layer must not add coverage, or a premultiplied compositor darkens exactly the
 * pixels it was meant to brighten.
 */
export const beamPass = (u: BeamUniforms) =>
  Fn(([color, profile, travel]: [Vec, Vec, Vec]) => {
    const r = profile.abs();
    const radial = r
      .mul(r)
      .mul(u.edgeFalloff)
      .negate()
      .exp()
      .mul(float(1).sub(r.smoothstep(0.55, 1)))
      .mul(widthReveal(profile, u.reveal));
    const longitudinal = float(1).div(
      travel.max(0).mul(u.falloffRate.max(0)).add(1).pow(u.falloffPower.max(0.0001)),
    );
    return vec4(color.mul(radial).mul(longitudinal).mul(u.intensity), 0);
  });

export interface DustUniforms {
  intensity: Vec;
  response: Vec;
  falloffPower: Vec;
  exposure: Vec;
  /** The broad unthresholded field a grain reads to decide how much light reaches it. */
  light: (uv: Vec) => Vec;
  /** A mid bloom level, read for HUE only. */
  color: (uv: Vec) => Vec;
  linearToSrgb: (c: Vec) => Vec;
  srgbToLinear: (c: Vec) => Vec;
  tonemapAces: (c: Vec) => Vec;
}

/**
 * One grain of dust.
 *
 * Hue comes from the bloom and brightness from the light field, and they are two different textures
 * on purpose: the field is a heavy sixteenth-resolution blur, broad enough to say whether light
 * reaches a grain and far too broad to say what colour it is.
 *
 * The response SATURATES — `1 - exp(-b·response)` — rather than clamping, so weak samples fade off
 * continuously instead of drawing a hard particle halo at the edge of the light volume. And the
 * grain is tone mapped IN ISOLATION because it draws over the finished frame: a mote is a point of
 * light in its own right, and mapping the sum instead crushes every grain sitting on the beam,
 * which is exactly where they are brightest.
 */
export const dustPass = (u: DustUniforms) =>
  Fn(([corner, lightUv, softness, sparkle, opacity]: [Vec, Vec, Vec, Vec, Vec]) => {
    const r2 = corner.dot(corner);
    const colorLight = u.srgbToLinear(u.color(lightUv).rgb.max(vec3(0)));
    const light = u.light(lightUv).rgb.max(vec3(0));
    const brightness = light.r.max(light.g).max(light.b);

    const illumination = float(1)
      .sub(brightness.mul(u.response).negate().exp())
      .clamp(0, 1)
      .pow(u.falloffPower);

    // Core plus halo, not a single taper: a grain has a tight centre and a faint surround, and
    // softness widens the core rather than only blurring the edge.
    const edgeFade = float(1).sub(r2.smoothstep(0.62, 1));
    const core = r2
      .mul(mix(float(6.5), float(1.8), softness))
      .negate()
      .exp();
    const halo = r2.mul(1.25).negate().exp().mul(softness).mul(0.2);
    const radial = core.add(halo).mul(edgeFade);

    const colorBrightness = colorLight.r.max(colorLight.g).max(colorLight.b);
    const hueSource = select(colorBrightness.greaterThan(1e-7), colorLight, light);
    const hueBrightness = hueSource.r.max(hueSource.g).max(hueSource.b);
    const lightColor = u.linearToSrgb(hueSource.div(hueBrightness.max(1e-6)).clamp(0, 1));

    const energy = illumination.mul(radial).mul(sparkle).mul(u.exposure).mul(u.intensity);
    const displayEnergy = u.linearToSrgb(u.tonemapAces(vec3(energy))).r;
    return vec4(lightColor.mul(displayEnergy).mul(opacity), 0);
  });
