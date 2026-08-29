/**
 * The transmissive materials — glass, frosted and liquid — as node graphs.
 *
 * The parts here that are pure functions of their inputs: the cone of refracted rays, the spectral
 * weighting that makes dispersion a continuum, and the Beer-Lambert chord. The assembly that wires
 * them to the plate and the screen-space displacement stays in the renderer, because it depends on
 * pass state rather than only on the surface.
 */
import { TSL } from "three/webgpu";

type Vec = any;

const { Fn, float, vec3 } = TSL;
const select = (cond: Vec, ifTrue: Vec, ifFalse: Vec): Vec => TSL.select(cond, ifTrue, ifFalse);
const mix = (a: Vec, b: Vec, t: Vec): Vec => TSL.mix(a, b, t);
const normalize = (v: Vec): Vec => TSL.normalize(v);
const cross = (a: Vec, b: Vec): Vec => TSL.cross(a, b);
const cos = (v: Vec): Vec => TSL.cos(v);
const sin = (v: Vec): Vec => TSL.sin(v);

const GOLDEN_ANGLE = 2.39996323;

/**
 * Refract the view into the surface, given an index RATIO rather than an index.
 *
 * Expressed as a ratio because the caller varies it per spectral sample, and a ratio is what the
 * dispersion sweep actually perturbs.
 */
export const bendDir = Fn(([view, normal, eta]: [Vec, Vec, Vec]) => {
  const cosI = normal.dot(view).clamp(-1, 1);
  const k = float(1).sub(eta.mul(eta).mul(float(1).sub(cosI.mul(cosI))));
  // Below zero the ray is past the critical angle; the mirror direction is the honest answer, and
  // returning a zero vector instead puts a black hole in the middle of the shape.
  return select(
    k.lessThan(0),
    TSL.reflect(view.negate(), normal),
    view
      .negate()
      .mul(eta)
      .add(normal.mul(eta.mul(cosI).sub(k.max(0).sqrt()))),
  );
});

/**
 * A per-pixel rotation for the sample disk, so N taps do not lie on the same N bearings across the
 * whole surface. Hashed from the PIXEL rather than from time: the pattern has to be stable frame to
 * frame, or the scatter boils.
 */
export const coneRotation = Fn(([pixel]: [Vec]) =>
  pixel
    .floor()
    .dot(TSL.vec2(12.9898, 78.233))
    .sin()
    .mul(43758.5453)
    .fract()
    .mul(2 * Math.PI),
);

/**
 * The i-th of `samples` directions spread around `dir` on a golden-angle spiral.
 *
 * The square root of the index spaces the samples by equal AREA rather than equal radius, so the
 * disk is evenly covered instead of crowded at the centre; the golden angle keeps successive
 * samples from lining up into spokes at any count.
 */
export const coneDirection = (samples: number) =>
  Fn(([dir, index, radius, rotation]: [Vec, Vec, Vec, Vec]) => {
    const axis = select(dir.y.abs().greaterThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0));
    const tangent = normalize(cross(axis, dir));
    const bitangent = cross(dir, tangent);
    const r = index.add(0.5).div(samples).sqrt();
    const a = index.mul(GOLDEN_ANGLE).add(rotation);
    return normalize(dir.add(cos(a).mul(tangent).add(sin(a).mul(bitangent)).mul(r).mul(radius)));
  });

/** Three overlapping Gaussians across the sample sweep — the reference's spectral weights. */
export const spectralWeight = Fn(([t]: [Vec]) =>
  vec3(
    t.sub(0.05).div(0.45).pow(2).negate().exp(),
    t.sub(0.5).div(0.38).pow(2).negate().exp(),
    t.sub(0.95).div(0.45).pow(2).negate().exp(),
  ),
);

export interface ConeUniforms {
  samples: number;
  ior: Vec;
  dispersion: Vec;
  roughness: Vec;
  /** Samples the field behind the surface along a direction. */
  plate: (dir: Vec) => Vec;
}

/**
 * A CONE of refracted rays rather than three, giving dispersion as a continuum and roughness as
 * genuine scatter.
 *
 * Three bins put hard colour fringes on any edge whose refraction moves faster than the bins are
 * wide, which on a faceted solid is most of them. And roughness only scatters if the rays actually
 * spread: blurring one lookup smears whatever that single ray happened to hit, which reads as a
 * dirty window rather than as frosting. The spread goes as roughness squared, so a polished surface
 * pays for the loop and nothing else.
 *
 * Returns the transmitted colour in rgb and the field's coverage in alpha.
 */
export const coneTransmission = (u: ConeUniforms) =>
  Fn(([view, normal, pixel]: [Vec, Vec, Vec]) => {
    // Pinned to this scope with `toVar`, not left as expressions. Each `u.plate(...)` below walks
    // a lamp `Loop`, and a value first reached through one of those calls has its assignment
    // written inside that loop body — recomputed per lamp, and read by the other samples from
    // whatever the last iteration left. See the note in `nodes/common`.
    const e0 = float(1).div(u.ior).toVar();
    const rotation = coneRotation(pixel).toVar();
    const radius = u.roughness.mul(u.roughness).mul(0.18).toVar();
    const spectrum = vec3(0).toVar();
    const weightSum = vec3(0).toVar();
    const cover = float(0).toVar();
    const spread = coneDirection(u.samples);

    for (let i = 0; i < u.samples; i++) {
      const t = float((i + 0.5) / u.samples);
      // The dispersion knob is an offset in ETA, and the three-ray version spanned e0±uDisp, so
      // the same authored number means the same total spread here.
      const base = bendDir(view, normal, e0.add(t.sub(0.5).mul(2).mul(u.dispersion)));
      const p = u.plate(spread(base, float(i), radius, rotation));
      const w = select(u.dispersion.greaterThan(1e-5), spectralWeight(t), vec3(1));
      spectrum.addAssign(p.rgb.mul(w));
      weightSum.addAssign(w);
      cover.addAssign(p.a);
    }
    return TSL.vec4(spectrum.div(weightSum.max(vec3(1e-4))), cover.div(u.samples));
  });

export interface SimpleUniforms {
  ior: Vec;
  dispersion: Vec;
  /** Samples the field behind the surface along a direction. */
  plate: (dir: Vec) => Vec;
}

/**
 * Three rays at three indices — the DEFAULT transmission, and the twin of the `else` branch in
 * GLASS_FRAG.
 *
 * Each channel is taken from its own ray rather than from a weighted mean across a sweep, so the
 * dispersion is three bins wide. That is visibly cruder than the cone on a faceted solid, where
 * the refraction moves faster than the bins — but it is three plate lookups against eleven, and it
 * is what every scene gets unless it asks for `transmission: "cone"`.
 */
export const simpleTransmission = (u: SimpleUniforms) =>
  Fn(([view, normal]: [Vec, Vec]) => {
    const e0 = float(1).div(u.ior);
    const r = u.plate(bendDir(view, normal, e0.sub(u.dispersion)));
    const g = u.plate(bendDir(view, normal, e0));
    const b = u.plate(bendDir(view, normal, e0.add(u.dispersion)));
    return TSL.vec4(vec3(r.r, g.g, b.b), r.a.add(g.a).add(b.a).div(3));
  });

/**
 * Colour as LIGHT rather than pigment: take the field's chroma and keep the brightness of what is
 * behind.
 *
 * `mix(white, tint, absorb)` darkens as it saturates and looks muddy. The 0.55 matters too — full
 * chroma normalization turns smooth gradients into hard posterized patches.
 */
export const transmittedHue = Fn(([lit]: [Vec]) => {
  const hue = lit.div(lit.r.max(lit.g).max(lit.b).max(0.001));
  return mix(lit, hue, float(0.55));
});

/**
 * Rodrigues rotation of a colour about the grey axis.
 *
 * Applied to the transmitted light only, so everything derived from it — the absorption hue, the
 * emission glow — shifts together while reflections keep the true lamp colours.
 */
export const rotateHue = Fn(([lit, turns]: [Vec, Vec]) => {
  const ha = turns.mul(2 * Math.PI);
  const k = vec3(0.57735027);
  return lit
    .mul(cos(ha))
    .add(cross(k, lit).mul(sin(ha)))
    .add(k.mul(k.dot(lit)).mul(float(1).sub(cos(ha))))
    .max(vec3(0));
});
