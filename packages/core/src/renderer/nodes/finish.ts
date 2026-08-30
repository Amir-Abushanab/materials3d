/**
 * The finish pass, as a node graph — the twin of FINISH_FRAG.
 *
 * Everything here is a PRINT effect rather than a lighting one: volumetric rays, ordered dither,
 * halftone, a CMYK separation and paper grain. They run after the tone map, over the finished
 * frame, and every one of them is off by default — which is why the pass is skipped entirely
 * unless a scene asks for something.
 *
 * All of them work on STRAIGHT colour and re-premultiply at the end. The frame arrives
 * premultiplied, and quantising or screening premultiplied colour ties every effect's threshold to
 * the alpha it happens to sit on, which over a transparent background is nonsense.
 */
import { TSL } from "three/webgpu";

type Vec = any;

const { Fn, float, vec3, vec4, uv, Loop } = TSL;
// Through a wrapper: three's `vec2` overloads reject a relaxed node. See `nodes/common`.
const vec2 = (x: Vec, y?: Vec): Vec => (y === undefined ? TSL.vec2(x) : TSL.vec2(x, y));
const mix = (a: Vec, b: Vec, t: Vec): Vec => TSL.mix(a, b, t);

const LIGHT_SAMPLES = 24;
const LUMA = [0.2126, 0.7152, 0.0722] as const;

const luma = (c: Vec): Vec => c.dot(vec3(...LUMA));
/** Saturation, the same discriminator the bloom gather uses — see POST_FRAG. */
const sat = (c: Vec): Vec => c.r.max(c.g).max(c.b).sub(c.r.min(c.g).min(c.b));

/**
 * The 8x8 ordered (Bayer) matrix, as a uniform table.
 *
 * A table rather than the bit-interleaving recurrence that generates it: the recurrence is easy to
 * write down and easy to get subtly wrong, and a wrong ordered-dither matrix still looks like an
 * ordered dither. Sixty-four constants that can be checked against the reference by eye are worth
 * more here than a clever closed form.
 */
const BAYER_8X8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const bayerTable = TSL.uniformArray(BAYER_8X8, "float");

const bayer = (p: Vec): Vec => {
  const q = p.div(8).fract().mul(8).floor();
  const cell: Vec = bayerTable.element(q.y.mul(8).add(q.x).toInt());
  return cell.div(64);
};

const sigmoid = Fn(([x, k]: [Vec, Vec]) => float(1).div(x.sub(0.5).mul(k).negate().exp().add(1)));

/** A dot growing from the centre of its cell as the value darkens. */
const circle = Fn(([p, lum, baseR]: [Vec, Vec, Vec]) => {
  const r = mix(baseR.mul(0.25), float(0), lum);
  const d = TSL.length(p.sub(0.5));
  const aa = TSL.fwidth(d);
  return float(1).sub(d.smoothstep(r.sub(aa), r.add(aa)));
});

/** One ink's screen: a rotated grid of dots whose radius tracks the value. */
const dotScreen = Fn(([coord, value, angle, cell]: [Vec, Vec, Vec, Vec]) => {
  const ca = angle.cos();
  const sa = angle.sin();
  // GLSL's `mat2(ca, sa, -sa, ca)` is COLUMN-major, so it multiplies as
  // (ca*x - sa*y, sa*x + ca*y). Writing it out row-wise transposes it, which rotates every screen
  // the wrong way and beats the four CMYK grids into a moire instead of separating them.
  const r = vec2(coord.x.mul(ca).sub(coord.y.mul(sa)), coord.x.mul(sa).add(coord.y.mul(ca)));
  const c = r.div(cell.max(2)).fract().sub(0.5);
  const radius = value.clamp(0, 1).sqrt().mul(0.5);
  return TSL.length(c).smoothstep(radius, radius.sub(0.06));
});

const hash21 = Fn(([p]: [Vec]) => p.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract());

export interface FinishUniforms {
  source: Vec;
  res: Vec;
  inner: Vec;
  innerDensity: Vec;
  innerDecay: Vec;
  innerCentre: Vec;
  dither: Vec;
  ditherScale: Vec;
  ditherSteps: Vec;
  halftone: Vec;
  halftoneCell: Vec;
  halftoneAngle: Vec;
  cmyk: Vec;
  cmykCell: Vec;
  paper: Vec;
  paperScale: Vec;
}

export const finishPass = (u: FinishUniforms) =>
  Fn(() => {
    // The same two-coordinate split the post pass needs, and for the same reason: `uv()` runs
    // bottom-up and a render target stores its rows the other way, so a READ has to flip while a
    // screen POSITION must not. FINISH_FRAG needs neither correction, because nothing it samples
    // is stored upside down relative to the coordinate it uses.
    const vUv = uv();
    const flip = (p: Vec): Vec => vec2(p.x, float(1).sub(p.y));

    /** Straight (un-premultiplied) colour at a SCREEN uv. */
    const src = (p: Vec): Vec => {
      const t = u.source.sample(flip(p));
      return vec4(t.rgb.div(t.a.max(1e-4)), t.a);
    };

    // `gl_FragCoord` counts up from the BOTTOM of the frame; `screenCoordinate` counts down from
    // the top. Every pattern below is a function of position, so using the wrong one mirrors the
    // dither lattice, the halftone grid and the paper grain vertically.
    const fragCoord = vec2(TSL.screenCoordinate.x, u.res.y.max(1).sub(TSL.screenCoordinate.y));
    const base = src(vUv);
    const col = base.rgb.toVar();
    const alpha = base.a.toVar();

    // VOLUMETRIC RAYS, marched toward a centre. Weighted by SATURATION rather than brightness, for
    // the same reason the bloom is: against a near-white frame the background is the brightest
    // thing present and would throw the strongest rays.
    TSL.If(u.inner.greaterThan(0.001), () => {
      const delta = vUv.sub(u.innerCentre).mul(u.innerDensity.div(LIGHT_SAMPLES));
      const coord = vUv.toVar();
      const decay = float(1).toVar();
      const rays = vec3(0).toVar();
      Loop(LIGHT_SAMPLES, () => {
        coord.assign(coord.sub(delta));
        const s = src(coord);
        rays.addAssign(s.rgb.mul(s.a).mul(sat(s.rgb)).mul(decay));
        decay.mulAssign(u.innerDecay);
      });
      const scaled = rays.div(LIGHT_SAMPLES).mul(u.inner).mul(3).toVar();
      col.addAssign(scaled);
      alpha.assign(alpha.max(luma(scaled)).clamp(0, 1));
    });

    // ORDERED DITHER, quantising LUMINANCE and carrying the hue through unchanged — quantising the
    // channels independently walks the colour toward whichever primary rounds up first.
    TSL.If(u.dither.greaterThan(0.001), () => {
      const px = u.ditherScale.max(1);
      const blockUv = TSL.screenCoordinate
        .div(px)
        .floor()
        .add(0.5)
        .mul(px)
        .div(u.res.max(vec2(1)));
      const block = src(blockUv);
      const steps = u.ditherSteps.floor().max(1);
      const lum = luma(block.rgb);
      const bright = lum
        .add(bayer(fragCoord.div(px)).sub(0.5).div(steps))
        .clamp(0, 1)
        .mul(block.a);
      const quant = bright.mul(steps).add(0.5).floor().div(steps);
      const dithered = block.rgb.div(lum.max(0.001)).mul(quant);
      const quantA = block.a.mul(steps).add(0.5).floor().div(steps);
      col.assign(mix(col, dithered, u.dither));
      alpha.assign(mix(alpha, mix(quant, float(1), quantA), u.dither));
    });

    // HALFTONE: one screen over the whole frame, sampling each cell's CENTRE so the dot's size
    // reflects the cell rather than the pixel it happens to cover.
    TSL.If(u.halftone.greaterThan(0.001), () => {
      const ca = u.halftoneAngle.cos();
      const sa = u.halftoneAngle.sin();
      const cell = u.halftoneCell.max(2);
      const fc = fragCoord;
      const grid = vec2(fc.x.mul(ca).sub(fc.y.mul(sa)), fc.x.mul(sa).add(fc.y.mul(ca)));
      const inCell = grid.div(cell).fract();
      const cellMid = grid.div(cell).floor().add(0.5).mul(cell);
      // The inverse rotation, which for a rotation is its transpose.
      const centre = vec2(
        cellMid.x.mul(ca).add(cellMid.y.mul(sa)),
        cellMid.x.mul(sa).negate().add(cellMid.y.mul(ca)),
      );
      const tex = src(centre.div(u.res.max(vec2(1))));
      const c = vec3(sigmoid(tex.r, float(2)), sigmoid(tex.g, float(2)), sigmoid(tex.b, float(2)));
      const lum = mix(float(1), luma(c), tex.a);
      const d = circle(inCell, lum, float(1.3));
      col.assign(mix(col, tex.rgb, u.halftone));
      alpha.assign(mix(alpha, tex.a.mul(d), u.halftone));
    });

    // CMYK separation, each ink on its own classical screen angle: 75, 15, 0 and 45 degrees. Those
    // offsets are what stop the four grids beating against each other into a moire.
    TSL.If(u.cmyk.greaterThan(0.001), () => {
      const k = float(1).sub(col.r.max(col.g).max(col.b));
      const invK = float(1).sub(k).max(1e-3);
      const coord = fragCoord;
      const dc = dotScreen(coord, float(1).sub(col.r).sub(k).div(invK), float(1.309), u.cmykCell);
      const dm = dotScreen(coord, float(1).sub(col.g).sub(k).div(invK), float(0.262), u.cmykCell);
      const dy = dotScreen(coord, float(1).sub(col.b).sub(k).div(invK), float(0), u.cmykCell);
      const dk = dotScreen(coord, k, float(0.785), u.cmykCell);
      const ink = vec3(1)
        .sub(vec3(dc, 0, 0))
        .sub(vec3(0, dm, 0))
        .sub(vec3(0, 0, dy))
        .sub(vec3(dk))
        .clamp(0, 1);
      col.assign(mix(col, ink, u.cmyk));
    });

    // PAPER: two noise scales, one of them stretched along y so the grain reads as fibre with a
    // direction rather than as uniform speckle.
    TSL.If(u.paper.greaterThan(0.001), () => {
      const p = fragCoord.div(u.paperScale.max(0.5));
      const fibre = hash21(p.floor())
        .mul(0.5)
        .add(hash21(p.mul(vec2(0.3, 3)).floor()).mul(0.5));
      const tex = mix(fibre, hash21(fragCoord), float(0.3));
      col.mulAssign(mix(float(1), float(1).sub(tex.sub(0.5).mul(0.35)), u.paper));
    });

    return vec4(col.mul(alpha), alpha);
  })();
