/**
 * The backdrop, as a node graph, the twin of BACKDROP_FRAG.
 *
 * Four ways of painting the same quad, and they have almost nothing in common: a derived vertical
 * ramp, a palette gradient in four geometries, an image, and a lit WALL with its own microfacet
 * relief and contact shadows. They live in one shader because they are one surface, and because the
 * lamp overlay at the end applies to all of them.
 *
 * The mode is a uniform rather than four materials. Every fragment of the draw takes the same side,
 * so the branch is coherent and the cost is the program being larger, which for a full-screen quad
 * drawn once per pass is not a cost worth splitting a material over.
 */
import { TSL } from "three/webgpu";
import {
  length,
  mix,
  normalFromXy,
  normalize,
  select,
  softMax,
  valueNoise,
  type Vec,
} from "./common";

const { Fn, float, vec2, vec3, vec4, Loop, If } = TSL;

/** How many footprints the wall can carry, and the most sides any one of them may have. */
// Re-exported from the config so the two engines and the parity harness cannot drift.
import { GROUND_MAX_SIDES, GROUND_SLOTS } from "../../config/model";

export { GROUND_MAX_SIDES, GROUND_SLOTS };

/**
 * Sample the palette at `t`, walking the stops in order.
 *
 * A zero-width span would divide by zero, so it steps past it and lets the later stop win, which
 * is also what makes a hard band between two stops expressible at all.
 */
export const rampAt = (stops: Vec, count: Vec, maxStops: number) =>
  Fn(([t]: [Vec]) => {
    const clamped = t.clamp(0, 1);
    const c = vec3(0).toVar();
    c.assign(stops.element(0).xyz);
    Loop(maxStops - 1, ({ i }: { i: Vec }) => {
      If(i.add(1).lessThan(count), () => {
        const a = stops.element(i).w;
        const b = stops.element(i.add(1)).w;
        const f = select(
          b.greaterThan(a),
          clamped.sub(a).div(b.sub(a).max(1e-6)).clamp(0, 1),
          // `a.step(b)` reads as `a >= b`, so this is GLSL's `step(b, t)`, t past the stop.
          clamped.step(b),
        );
        c.assign(mix(c, stops.element(i.add(1)).xyz, f));
      });
    });
    return select(count.lessThanEqual(0), vec3(1), c);
  });

/**
 * A tone curve that pivots rather than scaling.
 *
 * Shadows below the pivot are shaped by a power law and highlights above it by its mirror, so
 * raising contrast deepens the dark end without clipping the bright one.
 */
export const shadowContrastCurve = Fn(([v, contrast, pivot]: [Vec, Vec, Vec]) => {
  const p = pivot.clamp(0.001, 0.999);
  const k = contrast.max(0.001);
  return select(
    v.lessThan(p),
    p.mul(v.div(p).pow(k)),
    float(1).sub(
      float(1)
        .sub(p)
        .mul(float(1).sub(v).div(float(1).sub(p)).pow(k)),
    ),
  );
});

/** A 0 -> 1 transition centred ON the contour, so the true silhouette sits at the half value. */
export const softInside = Fn(([distance, amplitude]: [Vec, Vec]) => {
  const edge = amplitude.mul(0.5).max(0.0001);
  return float(1).sub(distance.smoothstep(edge.negate(), edge));
});

/**
 * Signed distance from `p` to one grounded footprint, a circle, or a convex polygon.
 *
 * The polygon is built by soft-maxing its half-planes rather than hard-maxing them, so the corners
 * ERODE as the softness grows. A hard max keeps them sharp at every radius, which reads as a
 * stencil rather than as contact.
 */
export const footprintDistance = (rounding: Vec) =>
  Fn(([p, g, phase]: [Vec, Vec, Vec]) => {
    const d = p.sub(g.xy);
    const acc = float(-1e9).toVar();
    Loop(GROUND_MAX_SIDES, ({ i }: { i: Vec }) => {
      If(i.toFloat().lessThan(g.w), () => {
        const a = phase.add(
          i
            .toFloat()
            .add(0.5)
            .mul(float(Math.PI * 2).div(g.w.max(1e-4))),
        );
        acc.assign(softMax(acc, d.dot(vec2(a.cos(), a.sin())).sub(g.z), rounding.mul(0.22)));
      });
    });
    return select(g.w.lessThan(2.5), length(d).sub(g.z), acc);
  });

export interface WallUniforms {
  extent: Vec;
  lightUv: Vec;
  lightDir: Vec;
  scale: Vec;
  normal: Vec;
  microFreq: Vec;
  microNormal: Vec;
  gamma: Vec;
  contrast: Vec;
  pivot: Vec;
  floorLevel: Vec;
  highlight: Vec;
  ambient: Vec;
  ambientLight: Vec;
  shadow: Vec;
  grounding: Vec;
  ground: Vec;
  groundPhase: Vec;
  groundCount: Vec;
  /** Dev tap: the name of a wall intermediate to return instead of the shaded colour. Never set in
   *  production, where it is undefined and every tap compiles out. */
  probe?: string;
}

/**
 * The WALL: a lit plaster surface with relief at two scales and contact shadows under the shapes.
 *
 * Two noise octaves, and they do different jobs. The large one shapes the diffuse response; the
 * micro one alone drives the specular, because a mirror of a small solid angle responds to the
 * finest structure present, giving it the combined normal lets the large scale drag the highlight
 * around and the wall reads as warped rather than rough.
 */
export const wallShade = (u: WallUniforms, bottom: Vec) =>
  Fn(([uvIn]: [Vec]) => {
    const wp = uvIn.sub(0.5).mul(2).mul(u.extent).toVar();
    const m = valueNoise(wp.mul(u.scale))
      .mul(0.5)
      .add(valueNoise(wp.mul(u.scale).mul(3.7)).mul(0.5))
      .toVar();

    const e = float(0.02);
    const largeXy = vec2(
      m.sub(valueNoise(wp.add(vec2(e, 0)).mul(u.scale).mul(3.7))),
      m.sub(valueNoise(wp.add(vec2(0, e)).mul(u.scale).mul(3.7))),
    ).mul(u.normal);
    const microUv = wp.mul(u.scale).mul(u.microFreq).add(vec2(0.371, 0.613)).toVar();
    const micro = valueNoise(microUv).toVar();
    const microXy = vec2(
      micro.sub(valueNoise(microUv.add(vec2(e, 0)))),
      micro.sub(valueNoise(microUv.add(vec2(0, e)))),
    )
      .mul(u.microNormal)
      .toVar();
    const N = normalFromXy(largeXy.add(microXy));
    const microN = normalFromXy(microXy);

    // The reference's baked light mask, standing in as a broad directional falloff. BROAD, and
    // that matters: the contrast curve pivots high, so anything under it is crushed to near black,
    // and a stand-in that fell off quickly would light nothing at all.
    const gl0 = float(1)
      .sub(length(uvIn.sub(u.lightUv).mul(vec2(0.85, 1.15))).mul(0.62))
      .clamp(0, 1);
    const gl = shadowContrastCurve(gl0.pow(u.gamma.max(0.001)), u.contrast, u.pivot).toVar();

    const L = normalize(u.lightDir);
    const facing = N.dot(L).max(0).toVar();
    const diffuse = mix(u.ambient, float(1), facing);
    const H = normalize(L.add(vec3(0, 0, 1)));
    const specular = microN
      .dot(H)
      .max(0)
      .pow(mix(float(48), float(4), m))
      .mul(mix(float(0.12), float(0.025), m));

    const albedo = bottom.mul(m.mul(0.5).add(0.5));
    const direct = albedo.mul(diffuse).add(vec3(specular));
    // The mask drives BOTH the local exposure and the neutral incident radiance. Merely adding it
    // over a uniformly lit wall lifts the shadows, and the tone curve then compresses all the
    // authored separation into white.
    const baseExposure = mix(u.floorLevel, u.highlight, gl);
    const globalIllum = vec3(
      gl
        .mul(u.ambientLight)
        .mul(m.mul(0.5).add(0.5))
        .mul(mix(float(0.25), float(1), facing)),
    );

    const occl = float(0).toVar();
    const distanceTo = footprintDistance(u.grounding);
    // UNROLLED IN JAVASCRIPT, not a `Loop`. `footprintDistance` contains a `Loop` of its own, and
    // nesting one inside another does not survive: the inner function's `toVar` accumulator is
    // hoisted out of the scope it belongs to, so every slot came back with a distance that is not
    // the one the same call returns when it is evaluated on its own. The measured symptom was a
    // contact shadow at roughly twice its true strength, from a footprint distance of -0.19 where
    // the identical expression outside the loop gave +0.04.
    //
    // `GROUND_SLOTS` is a compile-time constant, so this costs nothing a `Loop` would not: the
    // shader was going to unroll it anyway. The count guard stays a runtime `If`.
    for (let slot = 0; slot < GROUND_SLOTS; slot++) {
      If(float(slot).lessThan(u.groundCount), () => {
        occl.assign(
          occl.max(
            softInside(
              distanceTo(wp, u.ground.element(slot), u.groundPhase.element(slot)),
              u.grounding,
            ),
          ),
        );
      });
    }
    const grounding = mix(float(1), float(1).sub(u.shadow), occl);

    // Dev taps, matching BACKDROP_FRAG's, so the wall can be bisected against it term by term.
    if (u.probe) {
      const taps: Record<string, Vec> = {
        wallM: vec3(m),
        wallN: N.mul(0.5).add(0.5),
        wallGl: vec3(gl),
        wallFacing: vec3(facing),
        wallSpec: vec3(specular.mul(8)),
        wallDirect: direct,
        wallGi: globalIllum.mul(4),
        wallGrounding: vec3(grounding),
        wallExposure: vec3(baseExposure.div(4)),
        wallWp: vec3(wp.mul(0.5).add(0.5), 0),
        wallOccl: vec3(occl),
        wallFp: vec3(distanceTo(wp, u.ground.element(0), u.groundPhase.element(0)).mul(4).add(0.5)),
      };
      const tap = taps[u.probe];
      if (tap !== undefined) return tap;
    }

    return direct.mul(baseExposure).add(globalIllum).mul(grounding);
  });

export interface BackdropUniforms {
  /** 0 derived ramp, 1 palette gradient, 2 image, 3 wall. */
  mode: Vec;
  /** 0 linear, 1 radial, 2 conic, 3 mesh. */
  gradType: Vec;
  top: Vec;
  bottom: Vec;
  stops: Vec;
  stopCount: Vec;
  maxStops: number;
  angle: Vec;
  mesh: Vec;
  meshColors: Vec;
  meshCount: Vec;
  meshSoft: Vec;
  maxMeshPoints: number;
  /** Visible fraction of the plane, per axis, the plane is deliberately oversized. */
  frame: Vec;
  size: Vec;
  hasImage: Vec;
  image: (uvNode: Vec) => Vec;
  imageFit: Vec;
  imageZoom: Vec;
  imageAspect: Vec;
  imageOffset: Vec;
  wall: WallUniforms;
  /** The lamp field, painted faintly over whatever the backdrop is. */
  lamps: (p: Vec) => Vec;
  plateScale: Vec;
  plateOffset: Vec;
  show: Vec;
  /** Dev tap: a backdrop intermediate to return instead of the composed colour. Never set in
   *  production, where it is undefined and every tap compiles out. */
  probe?: string;
}

export const backdropPass = (u: BackdropUniforms) =>
  Fn(([uvIn]: [Vec]) => {
    // TWO coordinates, for the same reason the post pass has two. `uvIn` is the OVERSIZED PLANE's
    // own uv, straight off the geometry, and `fuv` is the visible rectangle within it.
    //
    // Gradients and images are authored against the visible rectangle, so they take `fuv`. The
    // vertical ramp, the wall and the lamp overlay are authored against the PLANE: the reference
    // oversizes it deliberately so the ramp is calibrated against a fixed 160x110 span rather than
    // against whatever the camera happens to frame, and the screen sees a slice of it.
    //
    // This derivation runs in the direction BACKDROP_FRAG's does, plane -> frame, because it is
    // fed by the same world-space plane. It used to run the other way, reconstructing the plane uv
    // from a full-screen quad as `(uvIn - 0.5) * frame + 0.5`, which silently assumed the camera
    // looks at the plane's CENTRE. It does not: `camera.lookAt.y` is nonzero in most presets, so
    // the slice the camera really sees is off-centre and everything authored against the plane
    // landed shifted. On `skewer` that put the lamp overlay 138px low.
    const planeUv = uvIn.toVar();
    const fuv = uvIn.sub(0.5).div(u.frame.max(1e-4)).add(0.5).toVar();
    const ramp = rampAt(u.stops, u.stopCount, u.maxStops);

    // IMAGE. `cover` and `contain` differ only in which way the aspect comparison goes, so they
    // share the arithmetic and disagree about one predicate.
    const frameAspect = u.size.x.mul(u.frame.x).div(u.size.y.mul(u.frame.y).max(1e-4));
    const ratio = frameAspect.div(u.imageAspect.max(1e-4));
    const wide = select(u.imageFit.equal(0), ratio.greaterThan(1), ratio.lessThan(1));
    const fitted = select(
      u.imageFit.equal(2),
      fuv.sub(0.5),
      select(
        wide,
        vec2(fuv.x.sub(0.5), fuv.y.sub(0.5).mul(ratio)),
        vec2(fuv.x.sub(0.5).div(ratio), fuv.y.sub(0.5)),
      ),
    );
    const imageUv = fitted.div(u.imageZoom.max(1e-4)).add(u.imageOffset).toVar();
    const outside = imageUv.x
      .lessThan(0)
      .or(imageUv.x.greaterThan(1))
      .or(imageUv.y.lessThan(0))
      .or(imageUv.y.greaterThan(1));
    const imageColor = select(outside, u.bottom, u.image(imageUv).rgb);

    // MESH gradient: a weighted blend of coloured points, which is the one gradient geometry that
    // is not a function of a single parameter.
    const acc = vec3(0).toVar();
    const wsum = float(0).toVar();
    Loop(u.maxMeshPoints, ({ i }: { i: Vec }) => {
      If(i.lessThan(u.meshCount), () => {
        const d = fuv.sub(u.mesh.element(i).xy);
        const w = d.dot(d).div(u.meshSoft.mul(u.meshSoft).max(1e-6)).negate().exp();
        acc.addAssign(u.meshColors.element(i).mul(w));
        wsum.addAssign(w);
      });
    });
    const meshColor = select(wsum.greaterThan(1e-5), acc.div(wsum.max(1e-6)), u.bottom);

    const dir = vec2(u.angle.cos(), u.angle.sin());
    const gradient = select(
      u.gradType.equal(3),
      meshColor,
      select(
        u.gradType.equal(1),
        ramp(length(fuv.sub(0.5)).mul(Math.SQRT2)),
        select(
          u.gradType.equal(2),
          ramp(
            fuv
              .sub(0.5)
              .y.atan(fuv.sub(0.5).x)
              .sub(u.angle)
              .div(Math.PI * 2)
              .add(1)
              .fract(),
          ),
          ramp(fuv.sub(0.5).dot(dir).add(0.5)),
        ),
      ),
    );

    const c = select(
      u.mode.equal(2).and(u.hasImage.equal(1)),
      imageColor,
      select(
        u.mode.equal(3),
        wallShade(u.wall, u.bottom)(planeUv),
        // `smoothstep` on the PLANE's v, exactly as BACKDROP_FRAG has it.
        select(u.mode.equal(1), gradient, mix(u.bottom, u.top, planeUv.y.smoothstep(0, 1))),
      ),
    );

    // The lamps, faintly, over whatever the backdrop turned out to be, so a scene sits in a room
    // rather than in front of a flat card.
    const p = planeUv.sub(0.5).mul(u.size).div(u.plateScale).add(u.plateOffset);
    const lamp = u.lamps(p).toVar();
    if (u.probe === "bgLampRgb") return vec4(lamp.rgb, 1);
    if (u.probe === "bgLampA") return vec4(vec3(lamp.a), 1);
    return vec4(mix(c, lamp.rgb, lamp.a.mul(u.show)), 1);
  });
