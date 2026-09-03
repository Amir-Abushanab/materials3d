/**
 * The microfacet layer, as node graphs, twins of the BRDF helpers in GLASS_FRAG.
 *
 * These are the parts of the material model that are pure functions of angle and roughness, and
 * therefore the parts most worth checking numerically rather than by eye: a wrong exponent here
 * shifts every highlight in the library by an amount that looks like a deliberate choice.
 */
import { TSL } from "three/webgpu";
import { cos, max, mix, type Vec } from "./common";

const { Fn, float, vec3 } = TSL;

// NOT `Math.PI`. This mirrors GLASS_FRAG's `G3_PI` digit for digit, and the parity harness diffs
// the two shaders at 8-bit precision, a more accurate constant here is a difference, not a fix.
// oxlint-disable-next-line approx-constant
const PI = 3.14159265359;
/** Schlick's own value at the F82 sample angle, and the denominator that renormalizes it. */
const F82_SCHLICK_BAR = 0.46266437;
const F82_DENOM = 0.05665278;

/**
 * The GGX normal distribution.
 *
 * `a` is roughness SQUARED. Disney's reparameterization, adopted because it makes the visual
 * change per unit of the authored slider roughly even. Feeding roughness directly leaves almost
 * everything happening in the bottom fifth of the range.
 */
export const distributionGGX = Fn(([NoH, a]: [Vec, Vec]) => {
  const a2 = a.mul(a);
  const f = NoH.mul(a2).sub(NoH).mul(NoH).add(1);
  return a2.div(f.mul(f).mul(PI));
});

/**
 * Height-correlated Smith visibility, the geometry term with the 1/(4·NoL·NoV) already folded in.
 *
 * Correlated rather than separable because the two shadowing terms are not independent: a
 * microfacet hidden from the light is likelier to be hidden from the eye as well, and treating them
 * separately over-darkens grazing angles, which is exactly where a rough metal gets its form.
 */
export const visibilitySmith = Fn(([NoV, NoL, a]: [Vec, Vec, Vec]) => {
  const a2 = a.mul(a);
  const ggxL = NoV.mul(NoL.negate().mul(a2).add(NoL).mul(NoL).add(a2).sqrt());
  const ggxV = NoL.mul(NoV.negate().mul(a2).add(NoV).mul(NoV).add(a2).sqrt());
  return float(0.5).div(max(ggxV.add(ggxL), 1e-5));
});

/** Schlick's Fresnel from an authored F0. */
export const fresnelSchlick = Fn(([f0, u]: [Vec, Vec]) =>
  f0.add(vec3(1).sub(f0).mul(float(1).sub(u).pow(5))),
);

/**
 * The F82 conductor Fresnel, which takes an EDGE TINT as well as an F0.
 *
 * Schlick sends every metal to white at grazing incidence, and real conductors do not: copper and
 * gold keep their hue right to the silhouette. F82 pins a second sample at the angle where the
 * error is largest and pulls the curve back toward the authored edge colour there, so a metal's
 * rim reads as the metal rather than as a white outline drawn around it.
 */
export const fresnelF82 = Fn(([f0, edge, u]: [Vec, Vec, Vec]) => {
  const fs = fresnelSchlick(f0, u);
  const fsBar = f0.add(vec3(1).sub(f0).mul(F82_SCHLICK_BAR));
  const k = u.mul(float(1).sub(u).pow(6)).div(F82_DENOM);
  return max(fs.sub(fsBar.sub(edge).mul(k)), vec3(0));
});

/**
 * Thin-film interference over the surface.
 *
 * The phase is the optical path through the film, twice its thickness, refracted, divided by the
 * wavelength, evaluated at three representative wavelengths for RGB. Sampling three points of a
 * continuous spectrum is a simplification, and the visible consequence is that very thick films
 * band rather than washing out the way a real one does.
 */
export const thinFilm = Fn(([ndv, ior, film, iridescence]: [Vec, Vec, Vec, Vec]) => {
  const s2 = float(1).sub(ndv.mul(ndv)).div(ior.mul(ior));
  const cosT = max(float(1).sub(s2), 0).sqrt();
  const phase = ior
    .mul(film)
    .mul(cosT)
    .mul(2 * Math.PI * 2)
    .div(vec3(650, 550, 440));
  return mix(vec3(1), cos(phase).mul(0.5).add(0.5), iridescence);
});

/** A cheap 3D hash. Deterministic per cell, which is what keeps a glint field from crawling. */
export const hash13 = Fn(([p]: [Vec]) => {
  const q = p
    .mul(0.3183099)
    .add(vec3(0.71, 0.113, 0.419))
    .fract()
    .mul(17);
  return q.x.mul(q.y).mul(q.z).mul(q.x.add(q.y).add(q.z)).fract();
});

/** Perturb a normal by a seeded random direction. */
export const jitter = Fn(([n, seed, amount]: [Vec, Vec, Vec]) => {
  const r = vec3(hash13(seed), hash13(seed.add(7.13)), hash13(seed.add(19.7))).sub(0.5);
  return TSL.normalize(n.add(r.mul(amount)));
});

/**
 * GLITTER, a field of tiny mirrors embedded in the surface.
 *
 * Each cell gets its own normal, so only the few facets that happen to point at the key light fire,
 * and which ones those are changes as the shape turns. That flicker IS the effect; a smooth
 * highlight is not glitter.
 *
 * Two things follow Zirr & Kaplanyan's multiscale glint work rather than being invented: the facet
 * response is the microfacet NDF, a very tight GGX lobe, rather than an arbitrary exponent, and
 * the CELL DENSITY is tied to the screen-space footprint. Without that second part the cells shrink
 * below a pixel as a shape recedes and the sparkle degenerates into crawling noise, which is the
 * aliasing their paper exists to solve.
 */
export const glitter = Fn(
  ([worldPos, normal, view, key, footprint, scale, amount]: [
    Vec,
    Vec,
    Vec,
    Vec,
    Vec,
    Vec,
    Vec,
  ]) => {
    const density = TSL.min(scale, footprint.max(1e-4).reciprocal().mul(0.85));
    const cell = worldPos.mul(density).floor();
    const facetNormal = jitter(normal, cell, float(0.85));
    const h = TSL.normalize(view.add(key));
    const facet = distributionGGX(facetNormal.dot(h).max(0), float(0.02));
    // Only a fraction of cells are reflective at all, or the surface reads as static.
    const on = hash13(cell.add(3.3)).step(0.72);
    return facet.mul(on).mul(amount).mul(0.06);
  },
);
