/**
 * The full-screen passes, as node graphs — twins of the bloom and blit shaders in `shaders.ts`.
 *
 * Each is built as a FACTORY taking its textures and uniforms rather than as a bare `Fn`, because a
 * node graph is compiled once and re-run, so the things that vary per invocation have to be
 * uniforms captured at build time rather than arguments. That is the one structural difference
 * from the GLSL originals; the arithmetic is intended to be identical, and
 * `scripts/tsl-parity.mjs` is what establishes that it is.
 *
 * Where a loop bound is a compile-time constant in GLSL — the `BLOOM_TAPS` define — it is a plain
 * JavaScript loop here, emitting one unrolled chain of nodes. That is what the define already did,
 * and it keeps the weights computable in JS wherever they do not depend on a uniform.
 */
import { TSL } from "three/webgpu";
import type { Texture } from "three/webgpu";
import { directionFromEquirect, srgbToLinear, studioRoom } from "./common";

/** See `nodes/common` — three's TSL types resolve the wrong overload for a relaxed node. */
type Vec = any;

const { Fn, float, vec2, vec3, vec4, texture, uv } = TSL;
const max = (a: Vec, b: Vec): Vec => TSL.max(a, b);
// The FREE mix, whose (a, b, t) order is pinned by three's own overloads. The fluent `a.mix(b, t)`
// is not obviously the same order, and getting it backwards here swapped the near and far bloom
// scales — a 34/255 error that looked like a plausible picture and was caught only by parity.
const mix = (a: Vec, b: Vec, t: Vec): Vec => TSL.mix(a, b, t);

/** The room, rasterized into an equirectangular map — level 0 of the chain. */
export const envBakePass = (softbox: Vec, gain: Vec) =>
  Fn(() => vec4(studioRoom(directionFromEquirect(uv()), softbox, gain), 1))();

/**
 * One axis of the blur that builds the chain, with the equirect distortion compensated.
 *
 * A row near a pole covers far less solid angle than one at the equator, so a blur of constant
 * TEXEL width is a blur of wildly varying ANGLE — the poles smear into streaks while the middle
 * barely moves. Dividing the horizontal step by sin(theta) makes the kernel angular instead, which
 * is the only version of it that means anything on a sphere. The vertical pass runs uncompensated:
 * the correction is for rows covering different solid angles, and applying it down the columns
 * pulls the poles apart rather than tightening them.
 *
 * Five taps reconstructing nine, by landing each off-centre fetch between two texels and letting
 * the bilinear unit do the pairing.
 */
const ENV_BLUR_TAPS: [number, number][] = [
  [1.3846153846, 0.3162162162],
  [3.2307692308, 0.0702702703],
];

/**
 * `src` is a texture NODE, not a texture, and that is what lets one compiled material walk the
 * whole chain: every level swaps `src.value` and redraws, where taking a `Texture` would mean a
 * fresh shader compile for each of the fourteen draws a bake performs.
 */
export const envBlurPass = (src: Vec, texel: Vec, direction: Vec, radius: Vec, compensate: Vec) =>
  Fn(() => {
    const p = uv();
    const sinTheta = TSL.sin(p.y.mul(Math.PI)).max(0.15);
    const scale = mix(float(1), sinTheta.reciprocal(), compensate);
    const step = direction.mul(texel).mul(radius).mul(scale).toVar();
    const sum = src.sample(p).mul(0.227027027).toVar();
    for (const [offset, weight] of ENV_BLUR_TAPS) {
      sum.addAssign(src.sample(p.add(step.mul(offset))).mul(weight));
      sum.addAssign(src.sample(p.sub(step.mul(offset))).mul(weight));
    }
    return sum;
  })();

/** A straight copy. Used to move a blurred scratch target into one mip of the environment. */
export const blitPass = (src: Texture | Vec) =>
  Fn(() => (src.isTextureNode ? src.sample(uv()) : texture(src as Texture, uv())))();

/**
 * Threshold the highlights, and DOWNSAMPLE while doing it.
 *
 * The box filter is not an embellishment: the source is the full-resolution frame and the target is
 * already half of it, so reading a single texel discards three quarters of the frame before the
 * pyramid starts. A thin diagonal highlight then arrives at level 0 as a staircase, and every level
 * below blurs those blocks back over the picture as hatching.
 */
export const bloomExtractPass = (src: Texture, threshold: Vec, texel: Vec) =>
  Fn(() => {
    const o = texel.mul(0.5);
    const c = max(
      texture(src, uv().add(vec2(o.x.negate(), o.y.negate())))
        .add(texture(src, uv().add(vec2(o.x, o.y.negate()))))
        .add(texture(src, uv().add(vec2(o.x.negate(), o.y))))
        .add(texture(src, uv().add(vec2(o.x, o.y))))
        .mul(0.25).rgb,
      vec3(0),
    );
    const b = c.r.max(c.g).max(c.b);
    const t = threshold.max(0);
    // A soft knee rather than a hard cut. A step at the threshold makes the bloom's edge track a
    // contour of the image, which reads as a bright outline drawn around things.
    const knee = t.mul(0.5).max(0.0001);
    const soft0 = b.sub(t).add(knee).clamp(0, knee.mul(2));
    const soft = soft0.mul(soft0).div(knee.mul(4).add(0.0001));
    return vec4(c.mul(b.sub(t).max(soft).div(b.max(0.0001))), 1);
  })();

/** Halve the resolution with a 4-tap box, which is the only correct way down a pyramid. */
export const bloomDownPass = (src: Texture, texel: Vec) =>
  Fn(() => {
    const o = texel.mul(0.5);
    const c = texture(src, uv().add(vec2(o.x.negate(), o.y.negate())))
      .add(texture(src, uv().add(vec2(o.x, o.y.negate()))))
      .add(texture(src, uv().add(vec2(o.x.negate(), o.y))))
      .add(texture(src, uv().add(vec2(o.x, o.y))));
    return vec4(max(c.mul(0.25).rgb, vec3(0)), 1);
  })();

/**
 * One axis of the Gaussian, with adjacent taps PAIRED.
 *
 * Exact rather than approximate: a sample placed between texels i and i+1 comes back from a linear
 * sampler as (1-f)·T(i) + f·T(i+1), so choosing f = w(i+1)/(w(i)+w(i+1)) is precisely the two
 * weighted taps the naive loop would fetch separately. The eighteen-tap level goes from thirty-five
 * fetches to nineteen for the same result.
 *
 * It relies on the source being LINEAR filtered and the offsets being in texel units from a texel
 * centre. A nearest-filtered source would silently snap every pair to one of its two taps and
 * narrow the kernel with no other sign.
 */
export const bloomBlurPass = (src: Texture, taps: number, sigma: Vec, dir: Vec, texel: Vec) =>
  Fn(() => {
    const total = float(1).toVar();
    const acc = texture(src, uv()).rgb.toVar();
    for (let i = 1; i < taps; i += 2) {
      const a = float(i);
      const b = float(i + 1);
      const wa = a.mul(a).div(sigma.mul(sigma)).mul(-0.5).exp();
      // The last pair is a lone tap when the count is even; its partner weighs nothing.
      const wb = i + 1 < taps ? b.mul(b).div(sigma.mul(sigma)).mul(-0.5).exp() : float(0);
      const w = wa.add(wb);
      const off = dir.mul(texel).mul(a.mul(wa).add(b.mul(wb)).div(w));
      acc.addAssign(
        texture(src, uv().add(off))
          .rgb.add(texture(src, uv().sub(off)).rgb)
          .mul(w),
      );
      total.addAssign(w.mul(2));
    }
    return vec4(max(acc.div(total), vec3(0)), 1);
  })();

/**
 * Recombine the visible levels.
 *
 * Radius moves weight from the near scale to the far one WITHOUT widening any kernel, so the halo
 * grows continuously instead of stepping as taps are added.
 */
export const bloomCompositePass = (l0: Texture, l1: Texture, l2: Texture, radius: Vec) =>
  Fn(() => {
    const r = radius.clamp(0, 1);
    const w0 = mix(float(1), float(0.55), r);
    const w1 = float(0.8);
    const w2 = mix(float(0.55), float(1), r);
    const c = texture(l0, uv())
      .rgb.mul(w0)
      .add(texture(l1, uv()).rgb.mul(w1))
      .add(texture(l2, uv()).rgb.mul(w2));
    return vec4(max(c.div(w0.add(w1).add(w2).max(0.0001)), vec3(0)), 1);
  })();

/**
 * The particle light field, straight from the HDR scene: an 8×8 area filter reducing to a
 * sixteenth in ONE step.
 *
 * Chaining four box downsamples would be cheaper but walks over the intermediate levels, and those
 * hold the thresholded bloom the composite still needs. Deliberately UNTHRESHOLDED — this is what a
 * grain of dust sees, and dust is lit by all the light in the room rather than only the part bright
 * enough to bloom.
 */
export const particleDownPass = (src: Texture, texel: Vec, scale: Vec) =>
  Fn(() => {
    const acc = vec3(0).toVar();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const grid = vec2(x - 3.5, y - 3.5);
        // Decoded per TAP, before the average: sixty-four display values do not average to the
        // display value of their linear mean.
        acc.addAssign(
          srgbToLinear(texture(src, uv().add(grid.mul(0.125).mul(scale).mul(texel))).rgb),
        );
      }
    }
    return vec4(max(acc.div(64), vec3(0)), 1);
  })();
