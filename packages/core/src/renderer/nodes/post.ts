/**
 * The post pass, as a node graph — the twin of POST_FRAG.
 *
 * The largest single shader in the renderer, and the one whose ordering carries the most meaning:
 * the depth-of-field gather runs over PREMULTIPLIED colour, everything after it over straight
 * colour, and the tone map goes last after every additive contribution has landed. That sequence
 * is preserved exactly; where this reads differently from the GLSL it is because TSL wants a value
 * rather than a statement, never because a step moved.
 */
import { TSL } from "three/webgpu";
import type { Texture } from "three/webgpu";
import { tonemapAces, tonemapNeutral } from "./common";

type Vec = any;

const { Fn, float, vec2, vec3, vec4, texture, uv } = TSL;
// CONDITION FIRST — see the note in `nodes/common`.
const select = (cond: Vec, ifTrue: Vec, ifFalse: Vec): Vec => TSL.select(cond, ifTrue, ifFalse);
const mix = (a: Vec, b: Vec, t: Vec): Vec => TSL.mix(a, b, t);

const GOLDEN_ANGLE = 2.39996323;

export interface PostUniforms {
  color: Texture;
  depth: Texture;
  bloom: Texture;
  res: Vec;
  mirror: Vec;
  focus: Vec;
  range: Vec;
  aperture: Vec;
  scale: Vec;
  far: number;
  dofTaps: number;
  causticTaps: number;
  bloomAmount: Vec;
  bloomMode: Vec;
  bloomRadius: Vec;
  bloomThresh: Vec;
  caustics: Vec;
  haze: Vec;
  hazeTop: Vec;
  hazeColor: Vec;
  vignette: Vec;
  grain: Vec;
  time: Vec;
  transparent: Vec;
  toneMap: Vec;
}

/** The two-channel linear depth the depth passes write. */
const decodeDepth = (rg: Vec): Vec => rg.x.add(rg.y.div(255));

/**
 * Weight bloom by SATURATION rather than brightness.
 *
 * A standard bright-pass is useless against a near-white backdrop, where the background is the
 * brightest thing in frame and would bloom before anything in the scene did.
 */
const saturation = (c: Vec): Vec => c.r.max(c.g).max(c.b).sub(c.r.min(c.g).min(c.b));

export const postPass = (u: PostUniforms) =>
  Fn(() => {
    // Mirroring is a flip of the SOURCE lookup, so the haze ramp and the caustic pool below — both
    // of which key off vertical position — flip with the picture rather than staying put.
    const vUv = mix(uv(), vec2(1).sub(uv()), u.mirror.step(0.5));

    const dC = decodeDepth(texture(u.depth, vUv)).mul(u.far);
    const r0 = dC.sub(u.focus).abs().div(u.range).clamp(0, 1).pow(1.2).mul(u.aperture).mul(u.scale);

    // RGBA, not RGB: alpha is the main pass's coverage and has to be blurred by exactly the same
    // kernel as the colour, or the depth of field softens a shape's colour and leaves its
    // silhouette crisp.
    const sum = texture(u.color, vUv).toVar();
    const wsum = float(1).toVar();
    const glow = vec3(0).toVar();

    for (let k = 0; k < u.dofTaps; k++) {
      const fi = k + 1;
      const a = fi * GOLDEN_ANGLE;
      const dir = vec2(Math.cos(a), Math.sin(a));
      const rad = r0.mul(Math.sqrt(fi / u.dofTaps));
      const uv2 = vUv.add(dir.mul(rad).div(u.res));

      // Occlusion guard: a sample in FRONT of this fragment contributes only in proportion to its
      // own circle of confusion, so a sharp foreground shape does not smear over a blurred one.
      const d2 = decodeDepth(texture(u.depth, uv2)).mul(u.far);
      const r2 = d2.sub(u.focus).abs().div(u.range).clamp(0, 1).mul(u.aperture).mul(u.scale);
      const w = select(d2.lessThan(dC.sub(0.4)), r2.smoothstep(0, rad.add(0.001)), float(1));
      sum.addAssign(texture(u.color, uv2).mul(w));
      wsum.addAssign(w);

      const g = texture(
        u.color,
        vUv.add(dir.mul(u.bloomRadius.mul(u.scale).mul(Math.sqrt(fi / u.dofTaps))).div(u.res)),
      ).rgb;
      glow.addAssign(g.mul(saturation(g).sub(u.bloomThresh).max(0)));
    }

    // The gather is over PREMULTIPLIED colour, the only form that can be blurred across an alpha
    // edge without bleeding: three premultiplies the clear colour, so a transparent background
    // clears to black whatever RGB it was given, and averaging that as straight colour drags every
    // soft edge toward black. Un-premultiply once here and the rest of the pass works in straight
    // colour exactly as it does over a backdrop.
    const acc = sum.div(wsum);
    const alphaIn = acc.a;
    const straight = acc.rgb.div(alphaIn.max(1e-4));

    // Either the gather or the pyramid, never both — two answers to one question, and summing them
    // doubles the halo.
    const bloom = select(
      u.bloomMode.greaterThan(0.5),
      texture(u.bloom, vUv).rgb.mul(u.bloomAmount),
      glow.div(u.dofTaps).mul(u.bloomAmount),
    );
    const col = straight.add(bloom).toVar();
    // Bloom spilling past a silhouette has to bring coverage with it, or over a transparent
    // background the glow is multiplied away against alpha 0 and never appears.
    const alpha = alphaIn.add(bloom.r.max(bloom.g).max(bloom.b)).min(1).toVar();

    // A downward saturation-weighted gather: a screen-space approximation of light pooling under
    // the glass, not refracted photons.
    const caus = vec3(0).toVar();
    for (let k = 0; k < u.causticTaps; k++) {
      const o = (k + 1) / u.causticTaps;
      const c = texture(u.color, vUv.add(vec2(Math.sin(o * 9) * 0.012, o * 0.2))).rgb;
      caus.addAssign(c.mul(saturation(c)).mul(1 - o));
    }
    const pool = caus.div(u.causticTaps).mul(vUv.y.smoothstep(0.46, 0)).mul(u.caustics).mul(3.2);
    col.addAssign(pool);
    alpha.assign(alpha.add(pool.r.max(pool.g).max(pool.b)).min(1));

    const haze = vUv.y.smoothstep(u.hazeTop, -0.02).mul(u.haze);
    col.assign(mix(col, u.hazeColor, haze));
    // Over a backdrop haze is a veil painted on top. Over transparency there is nothing to paint
    // onto, and the right reading is the one the eye makes: shapes dissolve into what is behind
    // them, so haze takes coverage away rather than adding a band of colour.
    alpha.mulAssign(float(1).sub(haze.mul(u.transparent)));

    const q = vUv.sub(0.5);
    col.mulAssign(float(1).sub(q.dot(q).mul(u.vignette)));
    col.addAssign(
      vUv
        .mul(u.res)
        .dot(vec2(12.9898, 78.233))
        .add(u.time)
        .sin()
        .mul(43758.5453)
        .fract()
        .sub(0.5)
        .mul(u.grain),
    );

    // Tone map LAST, after every additive contribution has landed and while the value is still
    // straight colour. Mode 0 is a no-op: every preset predating the curve was calibrated against
    // a clamped frame, and compressing them all would move the reference.
    const mapped = select(
      u.toneMap.greaterThan(1.5),
      tonemapAces(col),
      select(u.toneMap.greaterThan(0.5), tonemapNeutral(col), col),
    );

    // Back to premultiplied for the drawing buffer. With an opaque background alpha is 1
    // throughout, so this and the divide above are both identities.
    return vec4(mapped.mul(alpha), alpha);
  })();
