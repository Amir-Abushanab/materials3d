/**
 * The light-sheet materials, beam, caustic and dust, as node graphs.
 *
 * These are the passes whose GEOMETRY carries most of the meaning: the beam mesh is traced on the
 * CPU and arrives with per-vertex colour, profile and travel, so the fragment stage only has to
 * shape what the tracer already decided. That is why so little of the optics appears here.
 */
import { TSL } from "three/webgpu";
import { mix, select, valueNoise, type Vec } from "./common";

const { Fn, float, vec3, vec4 } = TSL;

/**
 * Open the bundle from its CENTRE LINE outward.
 *
 * A beam that fades up in brightness reads as a lamp being turned on; one that opens from the
 * middle reads as a beam arriving, which is what these scenes are about. The two branches keep it
 * honest at the ends: at zero the mask is exactly zero rather than a residual hairline down the
 * axis, and at one it is exactly one rather than a smoothstep that never quite closes.
 *
 * The feather has a FLOOR because the outgoing fan carries one flat profile per slice, so the
 * derivative is zero across a cell's interior and adjacent slices would step against each other.
 */
export const widthReveal = Fn(([profile, reveal]: [Vec, Vec]) => {
  const antialias = TSL.fwidth(profile).mul(1.5).max(0.04);
  const open = float(1).sub(
    profile.abs().smoothstep(reveal.sub(antialias).max(0), reveal.add(antialias).min(1)),
  );
  return select(
    reveal.lessThanEqual(0),
    float(0),
    select(reveal.greaterThanEqual(1), float(1), open),
  );
});

export interface BeamUniforms {
  intensity: Vec;
  edgeFalloff: Vec;
  falloffRate: Vec;
  falloffPower: Vec;
  reveal: Vec;
}

/**
 * The beam, shaped across its width and along its travel.
 *
 * The longitudinal term is most of what makes a fan read as light spreading out rather than as a
 * painted stripe, around a 280-fold dilution across the frame at the shipped constants. Alpha is
 * ZERO: an additive layer must not add coverage, or a premultiplied compositor darkens exactly the
 * pixels it was meant to brighten.
 */
export const beamPass = (u: BeamUniforms) =>
  Fn(([color, profile, travel]: [Vec, Vec, Vec]) => {
    const r = profile.abs();
    const radial = r
      .mul(r)
      .mul(u.edgeFalloff)
      .negate()
      .exp()
      .mul(float(1).sub(r.smoothstep(0.55, 1)))
      .mul(widthReveal(profile, u.reveal));
    const longitudinal = float(1).div(
      travel.max(0).mul(u.falloffRate.max(0)).add(1).pow(u.falloffPower.max(0.0001)),
    );
    return vec4(color.mul(radial).mul(longitudinal).mul(u.intensity), 0);
  });

export interface DustUniforms {
  intensity: Vec;
  response: Vec;
  falloffPower: Vec;
  exposure: Vec;
  /** The broad unthresholded field a grain reads to decide how much light reaches it. */
  light: (uv: Vec) => Vec;
  /** A mid bloom level, read for HUE only. */
  color: (uv: Vec) => Vec;
  linearToSrgb: (c: Vec) => Vec;
  srgbToLinear: (c: Vec) => Vec;
  tonemapAces: (c: Vec) => Vec;
}

/** Signed area of the triangle (a, b, p), positive on one side of the edge, negative on the other. */
const edgeSide = Fn(([a, b, p]: [Vec, Vec, Vec]) =>
  b.x
    .sub(a.x)
    .mul(p.y.sub(a.y))
    .sub(b.y.sub(a.y).mul(p.x.sub(a.x))),
);

/**
 * 1 outside the beam's cross-section, 0 inside it.
 *
 * Dust must not draw over the glass, and the test is per-FRAGMENT rather than per-grain: a large
 * defocused grain straddling the silhouette has to be clipped along the edge, not kept or dropped
 * whole on where its centre happens to land.
 *
 * A multiplier rather than a discard. The pass is additive, so scaling to zero is the same result
 * and costs no branch, and unlike `discard` it stays a pure function, which is what lets the
 * parity harness compare it against the reference at all.
 */
export const outsideSection = Fn(([p, a, b, c]: [Vec, Vec, Vec, Vec]) => {
  const s0 = edgeSide(a, b, p);
  const s1 = edgeSide(b, c, p);
  const s2 = edgeSide(c, a, p);
  const anyNegative = s0.lessThan(0).or(s1.lessThan(0)).or(s2.lessThan(0));
  const anyPositive = s0.greaterThan(0).or(s1.greaterThan(0)).or(s2.greaterThan(0));
  return select(anyNegative.and(anyPositive), float(1), float(0));
});

/**
 * One grain of dust.
 *
 * Hue comes from the bloom and brightness from the light field, and they are two different textures
 * on purpose: the field is a heavy sixteenth-resolution blur, broad enough to say whether light
 * reaches a grain and far too broad to say what colour it is.
 *
 * The response SATURATES, as `1 - exp(-b·response)` rather than a clamp, so weak samples fade off
 * continuously instead of drawing a hard particle halo at the edge of the light volume. And the
 * grain is tone mapped IN ISOLATION because it draws over the finished frame: a mote is a point of
 * light in its own right, and mapping the sum instead crushes every grain sitting on the beam,
 * which is exactly where they are brightest.
 */
export const dustPass = (u: DustUniforms) =>
  Fn(([corner, lightUv, softness, sparkle, opacity]: [Vec, Vec, Vec, Vec, Vec]) => {
    const r2 = corner.dot(corner);
    const colorLight = u.srgbToLinear(u.color(lightUv).rgb.max(vec3(0)));
    const light = u.light(lightUv).rgb.max(vec3(0));
    const brightness = light.r.max(light.g).max(light.b);

    const illumination = float(1)
      .sub(brightness.mul(u.response).negate().exp())
      .clamp(0, 1)
      .pow(u.falloffPower);

    // Core plus halo, not a single taper: a grain has a tight centre and a faint surround, and
    // softness widens the core rather than only blurring the edge.
    const edgeFade = float(1).sub(r2.smoothstep(0.62, 1));
    const core = r2
      .mul(mix(float(6.5), float(1.8), softness))
      .negate()
      .exp();
    const halo = r2.mul(1.25).negate().exp().mul(softness).mul(0.2);
    const radial = core.add(halo).mul(edgeFade);

    const colorBrightness = colorLight.r.max(colorLight.g).max(colorLight.b);
    const hueSource = select(colorBrightness.greaterThan(1e-7), colorLight, light);
    const hueBrightness = hueSource.r.max(hueSource.g).max(hueSource.b);
    const lightColor = u.linearToSrgb(hueSource.div(hueBrightness.max(1e-6)).clamp(0, 1));

    const energy = illumination.mul(radial).mul(sparkle).mul(u.exposure).mul(u.intensity);
    const displayEnergy = u.linearToSrgb(u.tonemapAces(vec3(energy))).r;
    return vec4(lightColor.mul(displayEnergy).mul(opacity), 0);
  });

/** A grain's every property is hashed from its index; this is the hash. */
const hash11 = Fn(([v]: [Vec]) => v.mul(127.1).sin().mul(43758.5453).fract());

/**
 * A grain's diameter in pixels and its softness, by class.
 *
 * Five classes on a heavily skewed distribution: almost every grain is the smallest kind, and the
 * rare large soft ones are what stop the field reading as uniform noise. The thresholds are the
 * distribution, 0.82 of grains tiny, 0.004 of them the largest.
 */
const appearance = Fn(([cls, size]: [Vec, Vec]) =>
  select(
    cls.lessThan(0.82),
    TSL.vec2(mix(float(1.05), float(1.75), size.mul(size)), 0.04),
    select(
      cls.lessThan(0.95),
      TSL.vec2(mix(float(1.8), float(3.8), size.pow(1.4)), 0.18),
      select(
        cls.lessThan(0.99),
        TSL.vec2(mix(float(4.2), float(9), size.pow(0.75)), 0.58),
        select(
          cls.lessThan(0.996),
          TSL.vec2(mix(float(12), float(28), size.pow(0.8)), 1),
          TSL.vec2(mix(float(32), float(72), size.pow(0.8)), 1),
        ),
      ),
    ),
  ),
);

export interface DustVertexUniforms {
  time: Vec;
  size: Vec;
  drift: Vec;
  planeZ: Vec;
  camDist: Vec;
  extent: Vec;
  res: Vec;
}

/**
 * The dust field's vertex stage, the twin of DUST_VERT.
 *
 * NOTHING about a grain is uploaded except its index. Position, size, class, shape, energy and
 * lifetime are all hashed from it, exactly as the reference derives everything from an instance
 * index: a respawn costs no buffer write, and the whole field is one draw of two triangles per
 * grain.
 *
 * The grain's light lookup is SNAPPED to a texel of the light field before being used. Without it
 * a grain drifting across a texel boundary crossfades between two very different brightnesses and
 * flickers; snapped, it changes in one step, which reads as a mote passing into the light.
 */
export const dustVertex = (u: DustVertexUniforms) => {
  // Through `Vec`: three types an attribute by its declared string, which loses the component
  // count, so every operator on it fails to resolve. See the note in `nodes/common`.
  const corner: Vec = TSL.attribute("aCorner", "vec2");
  const id: Vec = TSL.attribute("aId", "float");
  const index = id.add(1);
  const viewProj = TSL.cameraProjectionMatrix.mul(TSL.modelViewMatrix);

  // Lifetime, so the field turns over instead of being a fixed constellation.
  const seedLife = hash11(index.mul(19.127).add(71));
  const seedPhase = hash11(index.mul(23.417).add(83));
  const lifeDuration = mix(float(1), float(7), seedLife);
  const lifeClock = u.time.mul(u.drift).add(seedPhase.mul(lifeDuration));
  const generation = lifeClock.div(lifeDuration).floor();
  const lifePhase = lifeClock.div(lifeDuration).fract();

  const spawn = index.mul(7.919).add(generation.mul(131.7));
  const sx = hash11(spawn.add(1.3));
  const sy = hash11(spawn.add(5.7));
  const sz = hash11(spawn.add(11.1));
  const sDepth = hash11(spawn.add(17.9));
  const seedSize = hash11(index.mul(7.731).add(31));
  const seedClass = hash11(index.mul(9.173).add(37));
  const seedEnergy = hash11(index.mul(11.917).add(43));
  const seedShape = hash11(index.mul(13.531).add(47));
  const seedAngle = hash11(index.mul(17.273).add(59));

  const z = u.planeZ.add(sz.add(sDepth).sub(1).mul(u.extent.z));
  // Grains nearer the camera spread WIDER, so the field reads as a volume rather than a wall.
  const depthScale = u.camDist.sub(z).div(u.camDist.max(0.001)).clamp(0.08, 1);
  const base = vec3(
    sx.mul(2).sub(1).mul(u.extent.x).mul(depthScale),
    sy.mul(2).sub(1).mul(u.extent.y).mul(depthScale),
    z,
  );
  const wander = vec3(
    u.time
      .mul(mix(float(0.09), float(0.17), sy))
      .add(sz.mul(2 * Math.PI))
      .sin()
      .mul(mix(float(0.008), float(0.035), seedSize)),
    u.time
      .mul(mix(float(0.07), float(0.14), sz))
      .add(sx.mul(2 * Math.PI))
      .sin()
      .mul(mix(float(0.01), float(0.04), sy)),
    u.time
      .mul(mix(float(0.05), float(0.1), sx))
      .add(sy.mul(2 * Math.PI))
      .sin()
      .mul(mix(float(0.006), float(0.025), sz)),
  ).mul(u.extent.x);
  const p = base.add(wander);

  const clip = viewProj.mul(vec4(p, 1));
  const ndc0 = clip.xy.div(clip.w.max(1e-5));
  const rawUv = TSL.vec2(ndc0.x.mul(0.5).add(0.5), float(0.5).sub(ndc0.y.mul(0.5)));
  const res = u.res.max(TSL.vec2(1));
  const snapped = rawUv.mul(res).floor().add(0.5).div(res);
  const ndc = TSL.vec2(snapped.x.mul(2).sub(1), float(1).sub(snapped.y.mul(2)));

  const look = appearance(seedClass, seedSize);
  const radius = look.x.mul(0.5).mul(u.size);

  // A grain is not a disc: the small ones are slightly elongated at a random bearing, and the
  // large soft ones round off. Without it a dense field reads as a grid of identical dots.
  const aspect = mix(mix(float(0.68), float(1.32), seedShape), float(1), look.y);
  const angle = seedAngle.mul(2 * Math.PI);
  const ax = TSL.vec2(angle.cos(), angle.sin());
  const ay = TSL.vec2(ax.y.negate(), ax.x);
  const shaped = ax
    .mul(corner.x)
    .mul(aspect)
    .add(ay.mul(corner.y).div(aspect.max(0.001)));

  const opacity = float(1).min(float(1.5).div(look.x.max(1.5)).pow(0.9));
  const energy = seedEnergy.pow(3).mul(1.1).add(0.3);
  const twinkleAmount = mix(float(0.015), float(0.06), look.y);
  const twinkle = u.time
    .mul(mix(float(0.12), float(0.28), seedShape))
    .add(angle)
    .sin()
    .mul(twinkleAmount)
    .add(1);
  const fadeFraction = mix(float(0.14), float(0.24), seedShape);

  return {
    /** The quad's clip position, with the grain's screen-space footprint applied. */
    position: TSL.vec4(
      ndc.mul(clip.w).add(shaped.mul(radius).mul(2).div(res).mul(clip.w)) as Vec,
      clip.z as Vec,
      clip.w as Vec,
    ) as Vec,
    corner: TSL.varying(corner),
    lightUv: TSL.varying(TSL.vec2(snapped.x, float(1).sub(snapped.y))),
    softness: TSL.varying(look.y),
    sparkle: TSL.varying(opacity.mul(energy).mul(twinkle)),
    opacity: TSL.varying(lifePhase.smoothstep(0, fadeFraction)),
  };
};

export interface CausticUniforms {
  edgeFalloff: Vec;
  falloffRate: Vec;
  falloffPower: Vec;
  strength: Vec;
  coverage: Vec;
  farDesat: Vec;
  farBright: Vec;
  travelScale: Vec;
  rateScale: Vec;
  powerScale: Vec;
  normalInfluence: Vec;
  normalElevation: Vec;
  wallScale: Vec;
  wallNormal: Vec;
  beamDir: Vec;
}

/**
 * The CAUSTIC, the twin of CAUSTIC_FRAG.
 *
 * The same traced geometry as the beam, drawn a second time and lying on the wall rather than
 * hanging in the air: what the sheet deposits where it lands. It reads the wall's own relief, so
 * the pool brightens where the surface tilts into the light and dims where it turns away, which is
 * what stops it reading as a decal.
 *
 * `step(0, wave)` is the near/far discriminator the tracer sets per vertex. Without it the pool
 * draws on both sides of the sheet and the far half shows through the near one.
 */
export const causticPass = (u: CausticUniforms) =>
  Fn(([color, profile, travel, wave, world]: [Vec, Vec, Vec, Vec, Vec]) => {
    const r = profile.abs();
    const radial = u.edgeFalloff
      .negate()
      .mul(r)
      .mul(r)
      .exp()
      .mul(float(1).sub(r.smoothstep(0.55, 1)));
    const distance = travel.div(u.travelScale.max(0.001)).clamp(0, 1);
    const outgoing = float(1).div(
      float(1)
        .add(u.falloffRate.max(0).mul(u.rateScale.max(0)).mul(travel.max(0)))
        .pow(u.falloffPower.mul(u.powerScale.max(0)).max(0.0001)),
    );

    // The wall's fine octave alone. The caustic sits ON that surface, so what tilts it is the
    // relief the surface actually has, not a second invented one.
    const e = float(0.02);
    const m0 = valueNoise(world.mul(u.wallScale).mul(3.7));
    const mx = valueNoise(world.add(TSL.vec2(e, 0)).mul(u.wallScale).mul(3.7));
    const my = valueNoise(world.add(TSL.vec2(0, e)).mul(u.wallScale).mul(3.7));
    const N: Vec = TSL.normalize(
      TSL.vec3(m0.sub(mx).mul(u.wallNormal) as Vec, m0.sub(my).mul(u.wallNormal) as Vec, 1),
    );
    const elev = u.normalElevation.clamp(1, 89).mul(0.01745329252);
    const incident: Vec = TSL.normalize(
      TSL.vec3(TSL.normalize(u.beamDir).mul(elev.cos()) as Vec, elev.sin() as Vec),
    );
    // Normalized against the response a FLAT wall would give, so the influence knob scales a
    // deviation from one rather than the absolute dot product, which would darken everything.
    const flat0 = incident.z.max(0.05);
    const relative = N.dot(incident).max(0).div(flat0).clamp(0, 2.5);
    const surface = mix(float(1), relative, u.normalInfluence.clamp(0, 1));

    const energy = color.r.max(color.g).max(color.b).max(0).mul(radial).mul(outgoing);
    const bounded = float(1).sub(energy.mul(u.strength.max(0)).negate().exp());
    const farMix = distance.smoothstep(0.16, 0.92).mul(u.farDesat);
    const neutral = vec3(color.r.max(color.g).max(color.b).add(u.farBright.mul(distance)));
    const tint = mix(color, neutral, farMix).mul(bounded.mul(0.68).add(0.62)).clamp(0, 1.45);
    const cover = bounded.mul(u.coverage).clamp(0, 1);
    // `a.step(b)` reads as `a >= b`, so this is GLSL's `step(0, wave)`. Reversed it discards the
    // near half of the sheet instead of the far one.
    return vec4(tint.mul(cover).mul(surface).mul(wave.step(0)), 0);
  });
