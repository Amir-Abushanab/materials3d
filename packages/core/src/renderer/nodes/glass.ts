/**
 * The glass foundations, as node graphs — twins of the depth pass, the lamp plate and the prism
 * plane walk in `shaders.ts`.
 *
 * Two of these read arrays against a dynamic count, which is the one place where TSL's loop is a
 * genuine `Loop` node rather than a JavaScript unroll: the bound is a uniform, so the shader has to
 * carry the branch. `Loop` needs an `Fn` scope around it — outside one the node stack is null and
 * it throws at build time rather than at draw time.
 *
 * EVERY `If`/`Else` CALLBACK HERE TAKES A BLOCK BODY, and that is not a style choice. A concise
 * arrow returns whatever its expression evaluates to, and `x.assign(y)` evaluates to a node — so
 * TSL reads the branch as having a return VALUE, tries to emit `return <value>;` inside an inlined
 * function, and, finding no function to return from, emits the line commented out and reports the
 * node's generated code as empty. The assignment itself still lands, so the shader keeps working
 * and the only symptom is a console warning per branch plus a matching `Invalid generated code`
 * error, both naming nothing. `() => { x.assign(y); }` returns undefined and none of it happens.
 */
import { TSL } from "three/webgpu";
import { sq, srgbToLinear } from "./common";

type Vec = any;

const { Fn, float, vec3, vec4, Loop, If } = TSL;
// CONDITION FIRST — see the note in `nodes/common`.
const select = (cond: Vec, ifTrue: Vec, ifFalse: Vec): Vec => TSL.select(cond, ifTrue, ifFalse);
const reflect = (i: Vec, n: Vec): Vec => TSL.reflect(i, n);
const refract = (i: Vec, n: Vec, eta: Vec): Vec => TSL.refract(i, n, eta);

/**
 * Linear depth, split across two channels.
 *
 * A single 8-bit channel quantises depth to 1/255 of the far plane, which the depth-of-field
 * gather reads as visible banding across any smooth surface. The low byte carries the remainder,
 * and the subtraction is what makes the pair decode exactly as `x + y/255` rather than
 * double-counting the fraction.
 */
export const depthPass = (viewZ: Vec, far: number) =>
  Fn(() => {
    const d = viewZ.div(far).clamp(0, 1);
    const y = d.mul(255).fract();
    return vec4(d.sub(y.div(255)), y, 0, 1);
  })();

/** The two-channel encoding, read back. */
export const decodeDepth = (rg: Vec): Vec => rg.x.add(rg.y.div(255));

export interface PlateUniforms {
  /** xy = position, z = radius, w = intensity. */
  lamps: Vec;
  colors: Vec;
  count: Vec;
  gain: Vec;
  lo: Vec;
  hi: Vec;
  maxLamps: number;
}

/**
 * The lamp field: a sum of Gaussians, normalized to its own weight.
 *
 * Returns colour in rgb and COVERAGE in alpha, and the two are computed differently on purpose.
 * Colour is the weighted mean, so a shape between two lamps takes a blend rather than whichever is
 * nearer. Coverage saturates through `1 - exp(-a·gain)` so overlapping lamps cannot drive it past
 * one, and is then gated: without the gate every Gaussian tail reaches everywhere, so every shape
 * carries some tint and nothing in the frame reads as transparent.
 */
export const platePass = (u: PlateUniforms) =>
  Fn(([p]: [Vec]) => {
    const c = vec3(0).toVar();
    const a = float(0).toVar();
    Loop(u.count as Vec, ({ i }: { i: Vec }) => {
      const lamp = u.lamps.element(i);
      const d = p.sub(lamp.xy);
      const w = d.dot(d).div(lamp.z.mul(lamp.z).max(1e-6)).negate().exp().mul(lamp.w);
      c.addAssign(u.colors.element(i).mul(w));
      a.addAssign(w);
    });
    const amt = float(1).sub(a.mul(u.gain).negate().exp()).smoothstep(u.lo, u.hi);
    return vec4(c.div(a.max(1e-4)) as Vec, amt);
  });

/**
 * Distance along a ray to the nearest bounding plane it exits through.
 *
 * This is what the reference does instead of displacing the sample in screen space: refract the
 * view into the glass, walk it to whichever face it actually leaves by, and project THAT point. The
 * screen-space offset is a good approximation for a rod, whose surface curves smoothly and whose
 * exit is roughly opposite the entry; on a solid with flat faces and hard edges it is not, because
 * the refracted ray can leave through a different face entirely.
 *
 * Only a face the ray is heading OUT through can be an exit, which is what the denominator test
 * enforces — without it the walk finds the plane behind the ray and reports a path through empty
 * space.
 */
export const prismExit = (planes: Vec, count: Vec) =>
  Fn(([ro, rd]: [Vec, Vec]) => {
    const nearest = float(1e9).toVar();
    Loop(count, ({ i }: { i: Vec }) => {
      const pl = planes.element(i);
      const denom = rd.dot(pl.xyz);
      If(denom.greaterThan(1e-5), () => {
        const t = ro.dot(pl.xyz).add(pl.w).negate().div(denom);
        If(t.greaterThan(1e-4).and(t.lessThan(nearest)), () => {
          nearest.assign(t);
        });
      });
    });
    return select(nearest.greaterThan(1e8), float(0), nearest);
  });

/** As above, but also reporting the outward normal of the face the ray leaves by. */
export const prismExitNormal = (planes: Vec, count: Vec) =>
  Fn(([ro, rd]: [Vec, Vec]) => {
    const nearest = float(1e9).toVar();
    const normal = vec3(0, 0, 1).toVar();
    Loop(count, ({ i }: { i: Vec }) => {
      const pl = planes.element(i);
      const denom = rd.dot(pl.xyz);
      If(denom.greaterThan(1e-5), () => {
        const t = ro.dot(pl.xyz).add(pl.w).negate().div(denom);
        If(t.greaterThan(1e-4).and(t.lessThan(nearest)), () => {
          nearest.assign(t);
          normal.assign(pl.xyz);
        });
      });
    });
    return vec4(normal, select(nearest.greaterThan(1e8), float(0), nearest));
  });

/**
 * Schlick's Fresnel for a dielectric, from the index rather than from an authored F0.
 *
 * Glass has no free parameter here — the reflectance at normal incidence follows from the index —
 * so deriving it keeps the reflection and the refraction describing the same material.
 */
export const dielectricFresnel = Fn(([ior, facing]: [Vec, Vec]) => {
  // `sq`, not `.pow(2)` — an ior below 1 makes the base negative, where WGSL's `pow` is
  // undefined. See `sq` in ./common.
  const f0 = sq(ior.sub(1).div(ior.add(1)));
  const m = float(1).sub(facing.clamp(0, 1));
  const m2 = m.mul(m);
  return f0.add(float(1).sub(f0).mul(m2).mul(m2).mul(m));
});

/**
 * Cast a refracted ray at the plane hanging behind the scene and sample where it lands.
 *
 * The ray is never allowed to run parallel to the plate: a grazing refraction would otherwise
 * divide by nearly zero and sample somewhere arbitrarily far away, which reads as a shape smearing
 * the backdrop across itself at exactly the angles where it should be showing its own edge.
 */
export const backplate = (sampleLamps: Vec, planeZ: Vec, plateScale: Vec, plateOffset: Vec) =>
  Fn(([ro, rd]: [Vec, Vec]) => {
    const dz = rd.z.min(-0.04);
    const h = ro.add(rd.mul(planeZ.sub(ro.z).div(dz)));
    return sampleLamps(h.xy.div(plateScale).add(plateOffset));
  });

export { srgbToLinear };

export interface BackGlassUniforms {
  planes: Vec;
  planeCount: Vec;
  ior: Vec;
  strength: Vec;
  plateDepth: Vec;
  /** The room, at whatever cone width the caller wants — mirror-smooth here. */
  room: (dir: Vec) => Vec;
  bounces: number;
}

/**
 * The prism's INNER interface — the twin of BACKGLASS_FRAG.
 *
 * Draws the BACK-facing triangles and, for each fragment, follows the camera ray on into the glass
 * through however many total internal reflections it takes until it escapes, then samples the room
 * along that exit direction. It never reads the scene: its job is to put reflected room light
 * INSIDE the body, so the far faces return light back through the near ones.
 *
 * The surface event is evaluated AT the face rather than by marching outward from it first. For a
 * convex solid the ray is already on the boundary heading out, so a search for a "next" surface
 * finds some far plane and reports a path through empty space — and which plane it finds changes
 * by region, which draws the interior as a set of wedges.
 *
 * The walk carries a `done` flag instead of breaking. A break inside a TSL loop is expressible, but
 * the flag keeps the trip count uniform across the wavefront, which is what a GPU wants anyway.
 */
export const backGlassPass = (u: BackGlassUniforms) =>
  Fn(([worldPos, worldNormal, cameraPos]: [Vec, Vec, Vec]) => {
    const view = worldPos.sub(cameraPos).negate().normalize();
    const incident = view.negate();
    // The camera ray reaches a back face from INSIDE the solid, having already crossed the front,
    // so the face's outward normal is the one it is leaving through.
    const outward = worldNormal.normalize();
    const facing = incident.negate().dot(outward).clamp(0, 1);
    const fresnel = dielectricFresnel(u.ior, facing);

    // What this pass contributes is the part that REFLECTS back into the glass. The transmitted
    // branch is the see-through, and the plate below already carries it.
    const dir = reflect(incident, outward).normalize().toVar();
    const pos = worldPos.toVar();
    const lastNormal = outward.toVar();
    const escaped = float(0).toVar();
    const done = float(0).toVar();
    const walk = prismExitNormal(u.planes, u.planeCount);

    for (let b = 0; b < u.bounces; b++) {
      If(done.equal(0), () => {
        const hit = walk(pos.add(dir.mul(2e-4)), dir);
        const faceNormal = hit.xyz;
        const t = hit.w;
        If(t.lessThanEqual(0), () => {
          done.assign(1);
        }).Else(() => {
          pos.assign(pos.add(dir.mul(t.add(2e-4))));
          lastNormal.assign(faceNormal);
          const refracted = refract(dir, faceNormal.negate(), u.ior);
          If(refracted.dot(refracted).greaterThan(1e-6), () => {
            dir.assign(refracted.normalize());
            escaped.assign(1);
            done.assign(1);
          }).Else(() => {
            dir.assign(reflect(dir, faceNormal));
          });
        });
      });
    }

    // A reflection still trapped inside shows nothing: only light that made it back out to the
    // room can be what this fragment is displaying.
    const exitFacing = dir.dot(lastNormal).clamp(0, 1);
    const transmission = select(
      escaped.greaterThan(0.5),
      float(1).sub(dielectricFresnel(u.ior, exitFacing)),
      float(0),
    );
    return vec4(u.room(dir).mul(u.strength).mul(fresnel).mul(transmission), u.plateDepth);
  });
