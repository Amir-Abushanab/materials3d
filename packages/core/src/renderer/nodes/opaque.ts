/**
 * The opaque materials — metal, ceramic and plastic — as a node graph, twinning `shadeOpaque`.
 *
 * The whole model turns on one distinction: for a conductor the normal-incidence reflectance IS
 * its colour and there is no diffuse lobe at all, while a dielectric reflects about four per cent
 * white regardless of what colour it is. That is why a red plastic has a white highlight and
 * red-gold does not.
 */
import { TSL } from "three/webgpu";
import { distributionGGX, fresnelF82, fresnelSchlick, visibilitySmith } from "./brdf";

type Vec = any;

const { Fn, float, vec3 } = TSL;
const select = (cond: Vec, ifTrue: Vec, ifFalse: Vec): Vec => TSL.select(cond, ifTrue, ifFalse);
const mix = (a: Vec, b: Vec, t: Vec): Vec => TSL.mix(a, b, t);
const normalize = (v: Vec): Vec => TSL.normalize(v);
const reflect = (i: Vec, n: Vec): Vec => TSL.reflect(i, n);

/**
 * The key for opaque surfaces, from the upper front-left.
 *
 * Not the vertical key the lamp plate implies: most shapes here are lathes whose normals are
 * horizontal, so a vertical key lands on none of them and every shape comes out a flat, identical
 * pastel. From here a barrel actually turns through the light.
 */
export const OPAQUE_KEY: readonly [number, number, number] = [-0.45, 0.55, 0.7];

export interface OpaqueUniforms {
  kind: Vec;
  albedo: Vec;
  edgeTint: Vec;
  useEdge: Vec;
  roughness: Vec;
  spec: Vec;
  rim: Vec;
  envOn: Vec;
  /** The room at a given cone width, and the plate along a direction. */
  room: (dir: Vec, cone: Vec) => Vec;
  plate: (dir: Vec) => Vec;
}

/**
 * Built as a FACTORY over its uniforms rather than taking them as arguments.
 *
 * `Fn` proxies whatever it is handed into node space, and a plain JavaScript object — let alone one
 * carrying callbacks for the room and the plate — is not something it can proxy. Passing one
 * compiles and then renders nothing at all, which is how this was first written.
 */
export const shadeOpaque = (u: OpaqueUniforms) =>
  Fn(([normal, view, ndv]: [Vec, Vec, Vec]) => {
    const L = normalize(vec3(...OPAQUE_KEY));
    const H = normalize(view.add(L));
    const NoV = ndv.max(1e-4);
    const NoL = normal.dot(L).max(0);
    const NoH = normal.dot(H).max(0);
    const LoH = L.dot(H).max(0);
    const a = u.roughness.mul(u.roughness);

    const metal = u.kind.lessThan(4.5);
    const f0 = select(metal, u.albedo, vec3(0.04));
    // Only conductors get the F82 treatment: it corrects Schlick's conductor error, and a
    // dielectric's four per cent is already well inside Schlick's accurate range.
    const edged = metal.and(u.useEdge.greaterThan(0.5));

    // D_GGX is a normalized distribution, so its peak goes as 1/alpha² — into the hundreds for a
    // polished surface. A physical renderer balances that against the light's radiance and then
    // tone-maps; this pipeline is display-referred end to end and does neither, so an untouched
    // highlight simply clips to a white blob. Compressing it keeps the LOBE — the shape and
    // falloff the whole microfacet model exists for — while bounding the peak.
    const D = distributionGGX(NoH, a);
    const Vis = visibilitySmith(NoV, NoL, a);
    const F = select(edged, fresnelF82(f0, u.edgeTint, LoH), fresnelSchlick(f0, LoH));
    const direct0 = D.mul(Vis).mul(F).mul(NoL);
    const direct = direct0.div(vec3(1).add(direct0));

    const R = reflect(view.negate(), normal);
    const env = u.plate(R);
    const behind = u.plate(normal.negate());
    const fill = mix(vec3(0.92), behind.rgb, behind.a.mul(0.6));
    // Roughness used to fade the whole reflection toward a flat fill — a rough metal reflected
    // LESS room rather than a blurred one, which reads as chalk. Where a prefiltered chain exists
    // the blur is real, so the fade drops to a token amount.
    const coneFade = select(u.envOn.greaterThan(0.5), u.roughness.mul(0.18), u.roughness.mul(0.75));
    const envCol = mix(mix(u.room(R, u.roughness), env.rgb, env.a), fill, coneFade);
    const Fenv = select(edged, fresnelF82(f0, u.edgeTint, NoV), fresnelSchlick(f0, NoV));

    // CERAMIC keeps a wrapped diffuse term. Not Lambert and not physical — it stands in for
    // subsurface scattering, which is most of why unglazed clay reads as clay: light bleeds past
    // the terminator instead of stopping dead at it. PLASTIC gets plain Lambert, so the two differ
    // by their light transport rather than only by a gloss number.
    const wrapped = select(u.kind.greaterThan(5.5), NoL, NoL.mul(0.5).add(0.5).pow(1.7));
    // Energy conservation: whatever the surface reflects specularly cannot also be diffused.
    const kd = vec3(1).sub(Fenv).mul(u.albedo);
    const dielectric = kd
      .mul(fill.mul(0.42).add(wrapped.mul(0.82)))
      .add(direct.mul(u.spec))
      .add(envCol.mul(Fenv));
    const conductor = envCol.mul(Fenv).add(direct.mul(u.spec));

    const col = select(metal, conductor, dielectric);
    return col.add(fill.mul(float(1).sub(ndv).pow(3)).mul(u.rim).mul(1.6));
  });
