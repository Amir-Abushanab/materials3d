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
  /** The scene's own `mirrorH`/`mirrorV`, 1 per mirrored axis. Distinct from `mirror`, which
   *  folds in the storage inversion and is therefore only good for READS. */
  sceneMirror: Vec;
  /** 1 when the source targets are blit-written and therefore stored row-inverted, 0 when they
   *  are plain textures — as in the parity harness. See `blitUv` in ./passes. */
  sourceInverted: Vec;
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
    // TWO coordinates, and the distinction is load-bearing.
    //
    // `vUv` is where to READ the source, corrected for how the frame is stored in its target.
    // `screen` is where the output pixel IS. POST_FRAG uses one variable for both, because for it
    // they coincide — nothing needs correcting there.
    //
    // Everything that keys off position on the SCREEN — the caustic pool, the haze ramp, the
    // vignette, the grain — takes `screen`. Reading them from `vUv` puts the haze band at the top
    // of the frame where the reference puts it at the bottom, which on `skewer` was worth 9 of the
    // 22 levels of difference between the two engines.
    const vUv = mix(uv(), vec2(1).sub(uv()), u.mirror.step(0.5));
    // The SCENE's mirror, which is not `u.mirror`. That one is the read correction — the scene
    // mirror XORed with the storage inversion — and cannot answer "where is this pixel on a
    // mirrored screen". POST_FRAG has one coordinate for both because nothing it reads is stored
    // inverted, so its ramps mirror for free; here they have to be told. Without this, turning
    // `mirrorV` on left the haze band and the caustic pool at the unmirrored end of the frame.
    const screen = mix(uv(), vec2(1).sub(uv()), u.sceneMirror.step(0.5));

    /**
     * A neighbour of `vUv`, given an offset expressed the way POST_FRAG expresses it.
     *
     * `vUv` is vertically mirrored against the screen — that is what it is FOR — so a raw `+y`
     * added to it walks DOWN the frame where the reference's identical `+y` walks up. Every gather
     * in this pass is directional, and the caustic pool is deliberately one-sided, so the mirrored
     * ones pooled light above the glass instead of below it. Worth 3.9 of `skewer`'s difference
     * from the WebGL engine, with the depth-of-field and bloom spirals worth another 1.2 between
     * them.
     */
    const near = (o: Vec): Vec => vUv.add(vec2(o.x, mix(o.y, o.y.negate(), u.sourceInverted)));

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
      const uv2 = near(dir.mul(rad).div(u.res));

      // Occlusion guard: a sample in FRONT of this fragment contributes only in proportion to its
      // own circle of confusion, so a sharp foreground shape does not smear over a blurred one.
      const d2 = decodeDepth(texture(u.depth, uv2)).mul(u.far);
      const r2 = d2.sub(u.focus).abs().div(u.range).clamp(0, 1).mul(u.aperture).mul(u.scale);
      const w = select(d2.lessThan(dC.sub(0.4)), r2.smoothstep(0, rad.add(0.001)), float(1));
      sum.addAssign(texture(u.color, uv2).mul(w));
      wsum.addAssign(w);

      const g = texture(
        u.color,
        near(dir.mul(u.bloomRadius.mul(u.scale).mul(Math.sqrt(fi / u.dofTaps))).div(u.res)),
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
      // V-FLIPPED relative to `vUv` when the source is a blit-written target: the pyramid is one
      // and the colour target is not, so the two taps in this pass genuinely need different
      // conventions. See `blitUv` in ./passes.
      texture(u.bloom, vec2(vUv.x, mix(vUv.y, float(1).sub(vUv.y), u.sourceInverted))).rgb.mul(
        u.bloomAmount,
      ),
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
      const c = texture(u.color, near(vec2(Math.sin(o * 9) * 0.012, o * 0.2))).rgb;
      caus.addAssign(c.mul(saturation(c)).mul(1 - o));
    }
    const pool = caus.div(u.causticTaps).mul(screen.y.smoothstep(0.46, 0)).mul(u.caustics).mul(3.2);
    col.addAssign(pool);
    alpha.assign(alpha.add(pool.r.max(pool.g).max(pool.b)).min(1));

    const haze = screen.y.smoothstep(u.hazeTop, -0.02).mul(u.haze);
    col.assign(mix(col, u.hazeColor, haze));
    // Over a backdrop haze is a veil painted on top. Over transparency there is nothing to paint
    // onto, and the right reading is the one the eye makes: shapes dissolve into what is behind
    // them, so haze takes coverage away rather than adding a band of colour.
    alpha.mulAssign(float(1).sub(haze.mul(u.transparent)));

    const q = screen.sub(0.5);
    col.mulAssign(float(1).sub(q.dot(q).mul(u.vignette)));
    col.addAssign(
      screen
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
