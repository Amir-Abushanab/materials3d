/**
 * Shared TSL node helpers — the node-graph counterpart of `shaders.ts`'s GLASS_CHUNK and its
 * colour utilities.
 *
 * Three conventions here are load-bearing rather than stylistic, and all three cost real time:
 *
 * A NODE'S ASSIGNMENT IS EMITTED WHERE IT IS FIRST BUILT, and building follows a walk of the
 * returned graph rather than the order the JavaScript reads. So a value first reached through the
 * argument of something containing a `Loop` — or an `If` — has its assignment written INSIDE that
 * body, and every later use reads whatever the last iteration left, or nothing at all when the
 * loop's bound is zero. In this engine that put `view` inside the prism's plane walk: on any shape
 * with no planes the loop never ran, `view` stayed the zero vector, and every Fresnel term in the
 * material collapsed to grazing incidence — a white shell where the glass should be. Nothing about
 * it is visible in the TypeScript; it shows only in the generated GLSL. `.toVar()` at the point of
 * definition pins the assignment to the enclosing scope, which is why anything shared across a
 * loop boundary carries one.
 *
 * TSL is imported from `three/webgpu`, never from `three/tsl`. The two entry points are separate
 * module instances with separate node registries, so a node built by one and handed to a renderer
 * created by the other fails its weak-map lookup with "Invalid value used as weak map key" — an
 * error that names nothing useful and only appears once something actually draws.
 *
 * Every `Fn` argument carries a precise node type (`Vec`, not `Node`). three's TSL types
 * overload each operator per component count, so a bare `Node` matches none of them and the errors
 * point at the operator rather than at the annotation that caused it.
 *
 * `Vec` is a deliberate, narrow relaxation. three's TSL `.d.ts` types combinators like `select`
 * and `mix` as returning a component-erased node, so a perfectly valid `cross(select(...), f)`
 * fails to typecheck with "Node<'float'> is not assignable to Vec3" — the annotation is wrong, not
 * the shader. Rather than contort every such expression, the graph is written against a relaxed
 * alias and its correctness is established by RENDERING it: node code is duck-typed at runtime, so
 * a type error here would surface as a shader that does not compile, which the pass tests catch
 * immediately and loudly. Narrow it again if three's types improve.
 */
import { TSL } from "three/webgpu";

/** See the note above: a node whose component type three's `.d.ts` cannot track through `select`
 *  and `mix`. Used only for `Fn` parameters and locals, never on an exported boundary. */
type Vec = any;

const { Fn, float, vec2, vec3 } = TSL;

/**
 * The free functions, re-wrapped to return the relaxed node type.
 *
 * Passing a relaxed node straight to three's typed `select`/`mix`/`cross` is worse than not typing
 * it at all: overload resolution then picks the FIRST candidate rather than inferring, so a vec3
 * silently resolves as a vec2 and the next `.z` access is a type error pointing somewhere
 * unrelated. Going through a wrapper stops resolution mattering, and the component types are
 * carried by the graph at runtime either way.
 */
// CONDITION FIRST. three's signature is `select(cond, ifTrue, ifFalse)`, and writing it the other
// way round passes a colour as the predicate — which compiles, renders, and is wrong everywhere.
const select = (cond: Vec, ifTrue: Vec, ifFalse: Vec): Vec => TSL.select(cond, ifTrue, ifFalse);
const mix = (a: Vec, b: Vec, t: Vec): Vec => TSL.mix(a, b, t);
const cross = (a: Vec, b: Vec): Vec => TSL.cross(a, b);
const normalize = (v: Vec): Vec => TSL.normalize(v);
const length = (v: Vec): Vec => TSL.length(v);
const cos = (v: Vec): Vec => TSL.cos(v);
const sin = (v: Vec): Vec => TSL.sin(v);

// ---------------------------------------------------------------------------
// Colour transfer
// ---------------------------------------------------------------------------

/**
 * Display to linear, ON THE DISPLAY RANGE ONLY.
 *
 * The curve is defined on [0,1] and several of this renderer's targets are HDR, where the beam
 * sits in the hundreds. Feeding that to the transfer function is not an approximation but a
 * different function — 500 comes back as 2.6 million — and anything that then blurs it spreads a
 * number that size across the frame. Above one the value is already radiance and passes through.
 */
export const srgbToLinear = Fn(([c]: [Vec]) => {
  const v = c.max(vec3(0));
  const clamped = v.min(vec3(1));
  const lo = mix(
    clamped.div(12.92),
    clamped.add(0.055).div(1.055).pow(vec3(2.4)),
    clamped.step(vec3(0.04045)),
  );
  return mix(lo, v, v.step(vec3(1)));
});

export const linearToSrgb = Fn(([c]: [Vec]) => {
  const v = c.max(vec3(0));
  return mix(
    v.mul(12.92),
    v
      .pow(vec3(1 / 2.4))
      .mul(1.055)
      .sub(0.055),
    v.step(vec3(0.0031308)),
  );
});

/** Narkowicz's ACES fit — more contrast than the neutral curve, at the cost of a hue shift. */
export const tonemapAces = Fn(([v]: [Vec]) => {
  const c = v.max(vec3(0));
  return c
    .mul(c.mul(2.51).add(0.03))
    .div(c.mul(c.mul(2.43).add(0.59)).add(0.14))
    .clamp(0, 1);
});

/**
 * The Khronos PBR neutral curve: compresses the peak and desaturates toward it rather than
 * clipping each channel on its own.
 *
 * Per-channel clipping is what turns an over-range spectrum into magenta/cyan/yellow bars, because
 * whichever channel saturates first drags the hue to a primary. This keeps the hue and loses only
 * saturation, which is what over-exposure actually looks like.
 */
export const tonemapNeutral = Fn(([value]: [Vec]) => {
  const START = 0.76;
  const DESAT = 0.15;
  const color = value.max(vec3(0)).toVar();
  const lowest = color.r.min(color.g).min(color.b);
  const offset = select(
    lowest.lessThan(0.08),
    lowest.sub(lowest.mul(lowest).mul(6.25)),
    float(0.04),
  );
  color.subAssign(vec3(offset));
  const peak = color.r.max(color.g).max(color.b);
  const distance = float(1 - START);
  const compressed = float(1).sub(distance.mul(distance).div(peak.add(distance).sub(START)));
  const scaled = color.mul(compressed.div(peak.max(0.0001)));
  const amount = float(1).sub(float(1).div(peak.sub(compressed).mul(DESAT).add(1)));
  // Below the knee the colour is returned untouched, which is what keeps the curve a no-op on
  // everything that was already in range.
  return select(peak.lessThan(START), color, mix(scaled, vec3(compressed), amount));
});

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/** Bright ceiling, dark floor — the ramp metals fall back on when no room is configured. */
export const studioGradient = Fn(([rd]: [Vec]) =>
  mix(vec3(0.05, 0.055, 0.07), vec3(0.9, 0.93, 1.0), rd.y.mul(0.5).add(0.5).smoothstep(0, 1)),
);

/**
 * How much of one rectangular panel a ray sees: the panel projected onto the sphere, feathered at
 * its border.
 *
 * The feather is not decoration — an unfeathered edge aliases badly in a mirror-smooth reflection,
 * where one pixel can straddle the whole transition.
 */
const panelMask = Fn(([direction, forward, size, feather]: [Vec, Vec, Vec, Vec]) => {
  const f = normalize(forward);
  // Any helper axis works as long as it is not parallel to the panel's own.
  const helper = select(f.y.abs().greaterThan(0.92), vec3(0, 0, 1), vec3(0, 1, 0));
  const right = normalize(cross(helper, f));
  const up = cross(f, right);
  const facing = direction.dot(f);
  const localX = direction.dot(right).div(facing).abs();
  const localY = direction.dot(up).div(facing).abs();
  const edgeX = float(1).sub(localX.smoothstep(size.x, size.x.add(feather)));
  const edgeY = float(1).sub(localY.smoothstep(size.y, size.y.add(feather)));
  return select(facing.lessThanEqual(0.01), float(0), edgeX.mul(edgeY));
});

/**
 * A sparse three-panel room: a broad back-left wall, a soft centre fill and a dominant cool key.
 *
 * Against a dark backdrop the lamp plate reaches almost none of the hemisphere a surface sees, so
 * without a room to reflect, glass renders as a flat silhouette with no faces. The panel constants
 * are the reference's.
 */
export const studioSoftbox = Fn(([rd]: [Vec]) => {
  const d = normalize(rd);
  const floorBlend = float(1).sub(d.y.smoothstep(-0.22, -0.02));
  const room = mix(vec3(0.00025, 0.0003, 0.0004), vec3(0.0016, 0.0017, 0.0019), floorBlend);
  const back = panelMask(d, vec3(-0.82, 0.08, 0.57), vec2(1.35, 1.1), float(0.22))
    .mul(vec3(0.82, 0.84, 0.88))
    .mul(0.011);
  // The 0.707s are the GLSL's own literals, not an approximation of `Math.SQRT1_2` — see the note
  // on PI in `nodes/brdf`. Rounding them differently moves the softbox and fails parity.
  // oxlint-disable-next-line approx-constant
  const fill = panelMask(d, vec3(0, -0.707, 0.707), vec2(0.38, 0.62), float(0.18))
    .mul(vec3(1.0, 0.97, 0.91))
    .mul(0.22);
  // oxlint-disable-next-line approx-constant
  const key = panelMask(d, vec3(0.612, 0.354, 0.707), vec2(0.5, 0.16), float(0.035))
    .mul(vec3(0.76, 0.88, 1.0))
    .mul(20.0);
  const total = room.add(back).add(fill).add(key);
  // The reference replays a gamma-2.2 encode followed by an sRGB decode. The two curves very
  // nearly cancel, and the small mismatch between them is deliberate — dropping either is not a
  // simplification but a different room. Without both, the interior reads black and every wedge of
  // the traced fan glows.
  return srgbToLinear(
    total
      .div(vec3(1).add(total))
      .max(vec3(0))
      .pow(vec3(1 / 2.2)),
  );
});

// ---------------------------------------------------------------------------
// The prefiltered room
// ---------------------------------------------------------------------------

const ENV_PI = Math.PI;

export const equirectUv = Fn(([dir]: [Vec]) => {
  const d = normalize(dir);
  return vec2(
    d.z
      .atan(d.x)
      .div(2 * ENV_PI)
      .add(0.5),
    d.y.clamp(-1, 1).acos().div(ENV_PI),
  );
});

export const directionFromEquirect = Fn(([uv]: [Vec]) => {
  const phi = uv.x.sub(0.5).mul(2 * ENV_PI);
  const theta = uv.y.mul(ENV_PI);
  return vec3(sin(theta).mul(cos(phi)), cos(theta), sin(theta).mul(sin(phi)));
});

/**
 * Which mip a reflection should read.
 *
 * The cone is the material's own roughness; the footprint is how fast the reflected direction
 * changes across this pixel, which is what stops a mirror-smooth surface aliasing when it curves
 * away and compresses the whole room into a few pixels. Whichever is wider wins.
 */
export const envLod = Fn(([cone, ddxR, ddyR, texelAngle, levels]: [Vec, Vec, Vec, Vec, Vec]) => {
  const footprint = length(ddxR).max(length(ddyR));
  return cone.max(footprint).max(1e-6).div(texelAngle).log2().clamp(0, levels.sub(1));
});

// ---------------------------------------------------------------------------
// Noise and surface
// ---------------------------------------------------------------------------

/**
 * The room, either analytic or baked — the twin of GLASS_CHUNK's `studio()`.
 *
 * A function of the mode UNIFORM rather than a JavaScript branch, because the bake pass and every
 * material that falls back to the analytic room have to agree about what the room contains. Two
 * spellings of it would be a difference nobody would think to attribute to this switch.
 */
export const studioRoom = Fn(([rd, softbox, gain]: [Vec, Vec, Vec]) =>
  select(softbox.greaterThan(0.5), studioSoftbox(rd).mul(gain), studioGradient(rd)),
);

/**
 * Sample the baked chain, with the texel centres smoothstepped toward each other.
 *
 * A plain bilinear fetch on an equirect map shows its grid as soft diamonds wherever the room is
 * nearly flat, and this room is nearly flat almost everywhere. Warping the fractional part by
 * 3f²-2f³ makes the interpolation C1 across texel boundaries at no extra fetch.
 *
 * The level is EXPLICIT, never a bias. A bias is applied on top of whatever the hardware derives
 * from the fragment's own footprint, which for a reflection is meaningless — the footprint of the
 * DIRECTION is exactly what `envLod` already accounted for.
 */
export const sampleEnv = (map: Vec, size: Vec) =>
  Fn(([dir, lod]: [Vec, Vec]) => {
    const levelSize = size.div(lod.exp2()).max(vec2(2));
    const texel = equirectUv(dir).mul(levelSize).sub(0.5);
    const corner = texel.floor();
    const f = texel.fract();
    const p = corner
      .add(f.mul(f).mul(float(3).sub(f.mul(2))))
      .add(0.5)
      .div(levelSize);
    return TSL.texture(map, p).level(lod).rgb;
  });

export interface RoomUniforms {
  /** 1 once a chain is baked; below that the analytic room answers. */
  envOn: Vec;
  map: Vec;
  /** Level 0, in texels. */
  size: Vec;
  /** Radians per texel at level 0. */
  texelAngle: Vec;
  levels: Vec;
  softbox: Vec;
  gain: Vec;
}

/**
 * The room as a surface actually sees it: sharp for a mirror, a wider cone as it roughens.
 *
 * `select` is a ternary, not a branch, so both sides are evaluated — which is what makes the
 * derivatives here safe. Taking `dFdx` inside a real conditional is undefined where the quad
 * diverges, and a reflection off a curved surface diverges constantly.
 */
export const studioCone = (u: RoomUniforms) => {
  const sample = sampleEnv(u.map, u.size);
  return Fn(([rd, roughness]: [Vec, Vec]) =>
    select(
      u.envOn.greaterThan(0.5),
      sample(rd, envLod(roughness, TSL.dFdx(rd), TSL.dFdy(rd), u.texelAngle, u.levels)),
      studioRoom(rd, u.softbox, u.gain),
    ),
  );
};

export const hash21 = Fn(([p]: [Vec]) => p.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract());

/** Value noise on the unit lattice, smoothstepped between corners. */
export const valueNoise = Fn(([p]: [Vec]) => {
  const i = p.floor();
  const f = p.fract();
  const w = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(hash21(i), hash21(i.add(vec2(1, 0))), w.x),
    mix(hash21(i.add(vec2(0, 1))), hash21(i.add(vec2(1, 1))), w.x),
    w.y,
  );
});

/**
 * A tangent-space normal from its XY, with the slope LIMITED rather than normalized away.
 *
 * `normalize(vec3(x, y, 1))` silently rescales z, so a strong field flattens itself and past a
 * point more strength stops tilting the normal at all. Clamping the XY to unit length and solving
 * z from it keeps strength meaning something all the way up.
 */
export const normalFromXy = Fn(([xy]: [Vec]) => {
  const limited = xy.div(length(xy).max(1));
  return normalize(vec3(limited, float(1).sub(limited.dot(limited)).max(0.0001).sqrt()));
});

/** Log-sum-exp soft maximum: erodes corners as the softness grows, where a hard max keeps them. */
export const softMax = Fn(([a, b, rounding]: [Vec, Vec, Vec]) => {
  const r = rounding.max(0.0001);
  const m = a.max(b);
  return m.add(r.mul(a.sub(m).div(r).exp().add(b.sub(m).div(r).exp()).log()));
});
