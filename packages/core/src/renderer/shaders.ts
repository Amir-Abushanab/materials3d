/**
 * GLSL for the four passes. Written in GLSL1 style (`gl_FragColor`, `texture2D`) — three still
 * shims those onto GLSL ES 3.00 for any `ShaderMaterial` that doesn't set `glslVersion`, so this
 * compiles unchanged on the WebGL2-only renderer while staying readable next to the technique
 * notes. The one place the WebGL2 upgrade is taken advantage of is the lamp loop, which now
 * breaks at `uLampCount` instead of grinding through all twelve slots.
 *
 * Everything here works in DISPLAY (sRGB) space — see util/color.ts for why.
 */

import { FAR, MAX_LAMPS, MAX_MESH_POINTS, MAX_STOPS } from "../config/model";

const FAR_LITERAL = FAR.toFixed(1);

/**
 * The lamp field: a handful of soft Gaussian lamps with empty space between them, returning both
 * a colour and a coverage amount. Shared verbatim by the glass material and the backdrop, so the
 * colour a shape refracts and the colour faintly visible around it come from one definition.
 */
export const PLATE_CHUNK = /* glsl */ `
  uniform vec4  uLamp[${MAX_LAMPS}];      // xy = centre, z = radius, w = intensity
  uniform vec3  uLampCol[${MAX_LAMPS}];
  uniform int   uLampCount;
  uniform float uLampGain, uLampLo, uLampHi;

  vec4 plate(vec2 p){
    vec3 c = vec3(0.0); float a = 0.0;
    for (int i = 0; i < ${MAX_LAMPS}; i++){
      if (i >= uLampCount) break;
      vec2 d = p - uLamp[i].xy;
      float w = exp(-dot(d, d) / max(uLamp[i].z * uLamp[i].z, 1e-6)) * uLamp[i].w;
      c += uLampCol[i] * w;
      a += w;
    }
    float amt = 1.0 - exp(-a * uLampGain);
    // Gate the Gaussian tails to fully clear. Without this every lamp reaches everywhere, so
    // every shape carries some tint and nothing reads as transparent.
    amt = smoothstep(uLampLo, uLampHi, amt);
    return vec4(c / max(a, 1e-4), amt);
  }`;

export const GLASS_VERT = /* glsl */ `
  uniform mat3 uNormalMat;
  varying vec3  vW, vN, vVN;
  varying vec4  vProj;
  varying float vVZ;

  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW  = wp.xyz;
    // World-space normal via a real inverse-transpose (three's built-in normalMatrix is
    // view-space), so non-uniformly scaled items still refract correctly.
    vN  = normalize(uNormalMat * normal);
    vVN = normalize((viewMatrix * vec4(vN, 0.0)).xyz);
    vProj = projectionMatrix * viewMatrix * wp;
    vVZ = -(viewMatrix * wp).z;
    gl_Position = vProj;
  }`;

/**
 * Shared GLSL: the room a reflection falls back on, and the analytic interior trace.
 *
 * Interpolated into both glass interfaces rather than duplicated. The room in particular has to
 * have ONE definition — the back face and the front face of the same solid disagreeing about what
 * they reflect is exactly the kind of error nobody spots and nobody can then explain.
 */
export const GLASS_CHUNK = /* glsl */ `
  uniform float uPrism, uStudio, uStudioGain;
  uniform vec4 uPrismPlanes[6];
  uniform int uPrismPlaneCount;

  float prismExit(vec3 ro, vec3 rd){
    float nearest = 1e9;
    for (int i = 0; i < 6; i++){
      if (i >= uPrismPlaneCount) break;
      vec4 pl = uPrismPlanes[i];
      float denom = dot(rd, pl.xyz);
      // Only a face the ray is heading OUT through can be an exit.
      if (denom <= 1e-5) continue;
      float t = -(dot(ro, pl.xyz) + pl.w) / denom;
      if (t > 1e-4 && t < nearest) nearest = t;
    }
    return nearest > 1e8 ? 0.0 : nearest;
  }

  /** As above, but also reports the outward normal of the face the ray leaves by. */
  float prismExitN(vec3 ro, vec3 rd, out vec3 outN){
    float nearest = 1e9;
    outN = vec3(0.0, 0.0, 1.0);
    for (int i = 0; i < 6; i++){
      if (i >= uPrismPlaneCount) break;
      vec4 pl = uPrismPlanes[i];
      float denom = dot(rd, pl.xyz);
      if (denom <= 1e-5) continue;
      float t = -(dot(ro, pl.xyz) + pl.w) / denom;
      if (t > 1e-4 && t < nearest){ nearest = t; outN = pl.xyz; }
    }
    return nearest > 1e8 ? 0.0 : nearest;
  }


  vec3 studioGradient(vec3 rd){
    float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    return mix(vec3(0.55), vec3(1.02), smoothstep(0.20, 0.88, t));
  }

  /**
   * How much of a rectangular softbox a ray heading in rd sees.
   *
   * The panel is a rectangle projected onto the sphere and feathered at its border. The feather is
   * not decoration: on a mirror-smooth surface a hard-edged panel aliases into a stair-stepped
   * band, and the softness is what makes a reflection read as a light rather than as a polygon.
   *
   * Adapted from Vercel's vgpu (MIT) — see THIRD-PARTY-NOTICES.md.
   */
  float panelMask(vec3 rd, vec3 dir, vec2 size, float feather){
    vec3 fwd = normalize(dir);
    // Any helper axis works so long as it is not parallel to the panel's own.
    vec3 helper = abs(fwd.y) > 0.92 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(helper, fwd));
    vec3 up = cross(fwd, right);
    float facing = dot(rd, fwd);
    if (facing <= 0.01) return 0.0;
    float lx = abs(dot(rd, right) / facing);
    float ly = abs(dot(rd, up) / facing);
    return (1.0 - smoothstep(size.x, size.x + feather, lx))
         * (1.0 - smoothstep(size.y, size.y + feather, ly));
  }

  /**
   * A sparse three-panel studio: a broad back-left wall, a soft centre fill and a dominant cool
   * key on the right, over a near-black room with a floor/wall seam.
   *
   * This exists because the lamp plate is a flat panel BEHIND the scene — on a dark backdrop it
   * covers almost none of the hemisphere, so glass has nothing to reflect and renders as a flat
   * silhouette. Three intentional surfaces are enough to draw the edges of a solid and tell the
   * eye it is looking at a block of glass rather than a painted triangle.
   *
   * Analytic rather than a baked cubemap: at three panels the closed form is cheaper than a
   * texture fetch and stays editable in one place. Adapted from vgpu (MIT).
   */
  vec3 studioSoftbox(vec3 rd){
    vec3 d = normalize(rd);
    float floorBlend = 1.0 - smoothstep(-0.22, -0.02, d.y);
    vec3 room = mix(vec3(0.00025, 0.0003, 0.0004), vec3(0.006, 0.007, 0.009), floorBlend);
    // The wall behind the scene goes essentially black, so the glass reflects the same dark
    // surface it physically stands in front of.
    float backWall = (1.0 - smoothstep(-0.08, 0.08, d.z)) * smoothstep(-0.28, -0.08, d.y);
    room = mix(room, vec3(0.00002), backWall);
    float horizon = exp(-abs(d.y + 0.1) * 22.0) * 0.0012;
    vec3 c = room + vec3(horizon, horizon * 0.96, horizon * 0.9);
    c += vec3(0.82, 0.84, 0.88) * panelMask(d, vec3(-0.82, 0.08, 0.57), vec2(1.35, 1.1), 0.22) * 0.011;
    c += vec3(1.0, 0.97, 0.91) * panelMask(d, vec3(0.0, -0.707, 0.707), vec2(0.38, 0.62), 0.18) * 0.22;
    c += vec3(0.76, 0.88, 1.0) * panelMask(d, vec3(0.612, 0.354, 0.707), vec2(0.5, 0.16), 0.035) * 20.0;
    // Filmic compression, then the gamma-2.2 encode AND the sRGB decode the reference performs.
    //
    // Both halves matter. The encode alone lifts the room's near-black base of ~0.005 to ~0.077 —
    // fifteen times brighter — and the reflection then shows a room that is dimly lit everywhere
    // instead of black with a few panels in it. Inside a solid that is the difference between the
    // interior reading as black and every wedge of the traced fan glowing. The two curves very
    // nearly cancel; the reference keeps both precisely so the small mismatch between them is
    // preserved, and dropping either one is not a simplification.
    vec3 mapped = c / (vec3(1.0) + c);
    vec3 encoded = pow(max(mapped, vec3(0.0)), vec3(1.0 / 2.2));
    return mix(
      encoded / 12.92,
      pow((encoded + 0.055) / 1.055, vec3(2.4)),
      step(vec3(0.04045), encoded));
  }

  vec3 studio(vec3 rd){
    return uStudio > 0.5 ? studioSoftbox(rd) * uStudioGain : studioGradient(rd);
  }
`;

/**
 * The room, PREFILTERED — adapted from vgpu's `environment-map` example (MIT).
 *
 * The analytic {@link GLASS_CHUNK} room answers "what is in this direction" exactly, which is the
 * right answer for a mirror and the wrong one for anything else. A rough surface reflects a CONE,
 * not a ray, and the honest way to shade it is to average the room over that cone — which is far
 * too expensive per fragment and does not need to be done per fragment at all, because the room
 * does not change. Bake it once into an equirectangular texture, blur that into a mip chain, and a
 * roughness becomes a mip level.
 *
 * What it replaces is a fake: roughness used to fade the sharp reflection toward a flat grey, so a
 * rough metal did not reflect a blurred room, it reflected a *less* room. That reads as chalk.
 */
export const ENV_CHUNK = /* glsl */ `
  uniform sampler2D tEnv;
  uniform vec2 uEnvSize;      // level 0, in texels
  uniform float uEnvTexel;    // radians per texel at level 0
  uniform float uEnvLevels;

  const float ENV_PI = 3.141592653589793;

  vec2 equirectUv(vec3 dir){
    vec3 d = normalize(dir);
    return vec2(atan(d.z, d.x) / (2.0 * ENV_PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / ENV_PI);
  }

  vec3 directionFromEquirect(vec2 uv){
    float phi = (uv.x - 0.5) * 2.0 * ENV_PI;
    float theta = uv.y * ENV_PI;
    return vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
  }

  /**
   * Which mip a reflection should read.
   *
   * The cone is the material's own roughness; the footprint is how fast the reflected direction
   * changes across this pixel, which is what stops a mirror-smooth surface from aliasing when it
   * curves away and compresses the whole room into a few pixels. Whichever is wider wins.
   */
  float envLod(float cone, vec3 ddxR, vec3 ddyR){
    float footprint = max(length(ddxR), length(ddyR));
    return clamp(log2(max(max(cone, footprint), 1e-6) / uEnvTexel), 0.0, uEnvLevels - 1.0);
  }

  /**
   * Sample with the texel centres smoothstepped toward each other.
   *
   * A plain bilinear fetch on an equirect map shows its grid as soft diamonds wherever the room is
   * nearly flat, and the room here is nearly flat almost everywhere. Warping the fractional part
   * by 3f²-2f³ makes the interpolation C1 across texel boundaries at no extra fetch.
   */
  vec3 sampleEnv(vec3 dir, float lod){
    vec2 levelSize = max(uEnvSize / exp2(lod), vec2(2.0));
    vec2 texel = equirectUv(dir) * levelSize - 0.5;
    vec2 corner = floor(texel);
    vec2 f = fract(texel);
    vec2 uv = (corner + f * f * (3.0 - 2.0 * f) + 0.5) / levelSize;
    // An EXPLICIT level, not a bias. The three-argument texture2D is a bias in both GLSL ES
    // versions, and a bias is applied on top of whatever the hardware derives from the fragment's
    // own footprint — which for a reflection is meaningless, since the footprint of the direction
    // is exactly what envLod already accounted for. three rewrites every non-raw ShaderMaterial to
    // GLSL ES 3.00 and defines this spelling as textureLod, so it is available unconditionally.
    return texture2DLodEXT(tEnv, uv, lod).rgb;
  }
`;

/**
 * The room as a surface actually sees it: sharp for a mirror, a wider cone as it roughens.
 *
 * Injected after {@link ENV_CHUNK} so `studioCone` can fall back to the analytic room when no
 * chain is baked — the two have to agree, because the same scene may shade one material through
 * each and a disagreement about what the room contains is not something anyone would attribute to
 * this switch.
 */
export const ENV_LOOKUP = /* glsl */ `
  uniform float uEnvOn;
  vec3 studioCone(vec3 rd, float roughness){
    if (uEnvOn < 0.5) return studio(rd);
    return sampleEnv(rd, envLod(roughness, dFdx(rd), dFdy(rd)));
  }
`;

export const GLASS_FRAG = /* glsl */ `
  ${GLASS_CHUNK}
  ${ENV_CHUNK}
  ${ENV_LOOKUP}
  precision highp float;

  uniform sampler2D tBg;

  // -- Analytic interior tracing --------------------------------------------
  // uPrism: 0 = the screen-space normal offset below, 1 = trace the real interior path.
  /**
   * Camera view-projection, passed explicitly.
   *
   * three declares projectionMatrix in its VERTEX prefix only — the fragment prefix carries
   * viewMatrix and cameraPosition but not the projection. Naming it here silently fails to
   * compile the whole glass program, and the shapes then vanish while every other material in the
   * scene keeps drawing, which is a confusing way to find out.
   */
  uniform mat4 uViewProj;

  uniform vec3  uCam, uTint, uClearCol;
  uniform vec2  uPlateScale, uPlateOffset;
  uniform float uDisp, uLens, uSigma, uAspect, uPath, uPass, uIOR, uPlaneZ;
  uniform float uConeTransmission;
  /** Per-channel Beer-Lambert absorption, and whether to use it instead of lamp-derived hue. */
  uniform vec3  uAbsorb;
  uniform float uUseAbsorb;
  uniform float uUseTint, uRim, uSpec, uSat, uEmis;
  // Refracted-hue rotation in turns (0 = as lit) — transmission only, never the reflections.
  uniform float uHue;
  // 0 glass · 1 frosted · 2 glitter · 3 liquid · 4 metal · 5 ceramic · 6 plastic.
  uniform float uKind, uRough, uSparkle, uSparkleScale;
  // Liquid ripple field. uFlowRate is pre-snapped on the CPU so uTime * uFlowRate closes over a
  // loop exactly as motion rates do.
  uniform float uRipple, uRippleScale, uFlowRate, uTime;
  // Thin-film interference on the Fresnel reflection — strength, and optical thickness in nm.
  uniform float uIrid, uFilm;
  uniform vec3  uAlbedo, uEdge;
  uniform float uUseEdge;
  uniform sampler2D tBack;
  uniform float uThick;   // 1 = thickness is measured from the back-face pass

  varying vec3  vW, vN, vVN;
  varying vec4  vProj;
  varying float vVZ;

  const float FAR = ${FAR_LITERAL};
  ${PLATE_CHUNK}

  /** Decode the two-channel linear depth the depth passes write. */
  float dec(vec2 e){ return e.x + e.y / 255.0; }


  /**
   * A per-pixel rotation for the sample disk, so eleven taps do not lie on the same eleven
   * bearings across the whole surface. Hashed from the PIXEL rather than from time: the pattern
   * has to be stable frame to frame, or the scatter boils.
   */
  float coneRotation(vec2 pixel){
    return fract(sin(dot(floor(pixel), vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  }

  /**
   * The i-th of CONE_SAMPLES directions spread around dir on a golden-angle spiral.
   *
   * sqrt of the index spaces the samples by equal AREA rather than equal radius, so the disk is
   * evenly covered instead of crowded at the centre; the golden angle keeps successive samples
   * from lining up into spokes at any count.
   */
  vec3 coneDirection(vec3 dir, int i, float radius, float rotation){
    vec3 axis = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 tangent = normalize(cross(axis, dir));
    vec3 bitangent = cross(dir, tangent);
    float r = sqrt((float(i) + 0.5) / float(CONE_SAMPLES));
    float a = float(i) * 2.39996323 + rotation;
    return normalize(dir + (cos(a) * tangent + sin(a) * bitangent) * r * radius);
  }

  /** Three overlapping Gaussians across the sample sweep — the reference's spectral weights. */
  vec3 spectralWeight(float t){
    return vec3(
      exp(-pow((t - 0.05) / 0.45, 2.0)),
      exp(-pow((t - 0.50) / 0.38, 2.0)),
      exp(-pow((t - 0.95) / 0.45, 2.0)));
  }

  // Cast a refracted ray at the plane hanging behind the scene and sample where it lands.
  vec4 backplate(vec3 ro, vec3 rd){
    float dz = min(rd.z, -0.04);   // never divide by a ray parallel to the plate
    vec3 h = ro + rd * ((uPlaneZ - ro.z) / dz);
    return plate(h.xy / uPlateScale + uPlateOffset);
  }

  /**
   * Distance along a ray to the nearest bounding plane it exits through.
   *
   * This is what the reference does instead of displacing the sample in screen space: refract the
   * view into the glass, walk it to whichever face it actually leaves by, and project THAT point.
   * The screen-space offset below is a good approximation for a rod, whose surface curves smoothly
   * and whose exit is always roughly opposite the entry. On a solid with flat faces and hard edges
   * it is not — the refracted ray can leave through a different face entirely, and no amount of
   * rim weighting reproduces that. It also returns the true optical path length, so Beer-Lambert
   * stops having to guess a chord.
   */
  // Total internal reflection returns a zero vector from refract(); fall back to a mirror bounce.
  vec3 bendDir(vec3 V, vec3 N, float eta){
    vec3 r = refract(-V, N, eta);
    return dot(r, r) < 1e-4 ? reflect(-V, N) : normalize(r);
  }

  /** The one key direction in the scene. Shared with the glass specular below, so a metal shape
   *  and a glass one beside it agree about where the light is. */
  const vec3 KEY = normalize(vec3(-0.30, 0.86, 0.42));

  /**
   * A second, much LOWER key, used only by the glass highlight below.
   *
   * KEY points nearly straight up, and a highlight is a mirror image of the light: a surface can
   * only show it if its normal tilts toward it. A cylinder standing on end has normals that are
   * all horizontal, so its mirror direction never leaves the y = 0 plane and can never reach a
   * light at y = 0.86 — no exponent fixes that, because the term is zero before the exponent
   * touches it. That is why uSpec measured dead on every rod, cone and upright prism.
   *
   * So: key plus fill, which is what a real studio does for exactly this reason. This one sits
   * low and close to the lens axis, where a vertical flank can actually see it, and it is weaker
   * than the top light so the two read as one lighting setup rather than two competing suns.
   */
  const vec3 KEY_FILL = normalize(vec3(0.42, 0.16, 0.89));

  float hash13(vec3 p){
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  /** A per-facet normal wobble, used by glitter to give each cell its own orientation. */
  vec3 jitter(vec3 N, vec3 seed, float amount){
    vec3 r = vec3(hash13(seed), hash13(seed + 7.13), hash13(seed + 19.7)) - 0.5;
    return normalize(N + r * amount);
  }

  /**
   * The liquid surface: travelling trig waves in world space, as a gradient added to the normal.
   * Trig waves rather than scrolled noise on purpose — each term's temporal frequency is an
   * INTEGER multiple of the snapped base phase, so a loop that closes for the motion closes for
   * the water too, which scrolled noise can never guarantee. Four directions at incommensurate
   * spatial frequencies is enough to hide the periodicity at hero-section scale.
   */
  vec3 rippleNormal(vec3 N, vec3 p){
    float ph = uTime * uFlowRate;
    vec3 k1 = vec3( 1.00,  0.62,  0.31);
    vec3 k2 = vec3(-0.54,  1.13,  0.47);
    vec3 k3 = vec3( 0.36, -0.82,  1.07);
    vec3 k4 = vec3(-1.18, -0.33,  0.72);
    vec3 g = vec3(0.0);
    g += k1 * cos(dot(p, k1) * uRippleScale + ph);
    g += k2 * cos(dot(p, k2) * uRippleScale - ph * 2.0 + 1.7) * 0.65;
    g += k3 * cos(dot(p, k3) * uRippleScale + ph * 3.0 + 3.9) * 0.42;
    g += k4 * cos(dot(p, k4) * uRippleScale - ph + 2.6) * 0.55;
    return normalize(N + g * uRipple * 0.16);
  }

  /**
   * Thin-film interference colour, as a multiplier for the Fresnel reflection.
   *
   * The standard first-order model: optical path difference 2·n·d·cos θt sets a per-wavelength
   * phase, sampled at three representative wavelengths (650/550/440nm). Airy summation would be
   * more correct and buys nothing at hero-section scale; three cosines already sweep the bands
   * across the shape as it turns, which is the whole effect.
   */
  vec3 thinFilm(float ndv){
    float s2 = (1.0 - ndv * ndv) / (uIOR * uIOR);
    float cosT = sqrt(max(1.0 - s2, 0.0));
    vec3 phase = 6.2831853 * (2.0 * uIOR * uFilm * cosT) / vec3(650.0, 550.0, 440.0);
    return mix(vec3(1.0), 0.5 + 0.5 * cos(phase), uIrid);
  }

  // ---------------------------------------------------------------------------------------------
  // Microfacet BRDF — Cook-Torrance with the Trowbridge-Reitz (GGX) distribution.
  //
  // These are the standard real-time forms (Filament's implementations of Walter et al. 2007 and
  // Heitz's height-correlated Smith visibility). They replace the hand-tuned pow(dot, exponent)
  // lobe this started with: an exponent has no relationship to a surface, so "roughness" meant
  // whatever looked right at one value and fell apart at the others.
  //
  // ROUGHNESS REMAP: alpha = roughness². Disney's reparameterization, adopted because it makes the
  // slider perceptually linear — without it almost all of the visible change is crammed into the
  // bottom of the range.
  // ---------------------------------------------------------------------------------------------
  const float G3_PI = 3.14159265359;

  float D_GGX(float NoH, float a){
    float a2 = a * a;
    float f = (NoH * a2 - NoH) * NoH + 1.0;
    return a2 / (G3_PI * f * f);
  }

  float V_SmithGGXCorrelated(float NoV, float NoL, float a){
    float a2 = a * a;
    float GGXL = NoV * sqrt((-NoL * a2 + NoL) * NoL + a2);
    float GGXV = NoL * sqrt((-NoV * a2 + NoV) * NoV + a2);
    return 0.5 / max(GGXV + GGXL, 1e-5);
  }

  vec3 F_Schlick(vec3 f0, float u){
    return f0 + (vec3(1.0) - f0) * pow(1.0 - u, 5.0);
  }

  // Hoffman's F82 correction to Schlick, for conductors.
  //
  // Schlick is derived for dielectrics and OVERSHOOTS for metals near the silhouette; measured
  // conductors dip below it, most sharply at around 82°. The correction subtracts a lobe that is
  // zero at both normal incidence and true grazing and peaks at that angle, pinned so the curve
  // passes exactly through the measured edge reflectance.
  //
  // What it buys visually is desaturation at the rim: gold's F0 is (1.00, 0.86, 0.60) but its
  // measured edge is nearly neutral, so a gold cylinder should go pale where it turns away. Plain
  // Schlick keeps it uniformly gold, which is a large part of what reads as "CG metal".
  //
  // mu-bar = 1/7 (~81.8°); the two constants are (6/7)^5 and (1/7)(6/7)^6.
  const float F82_SCHLICK_BAR = 0.46266437;
  const float F82_DENOM = 0.05665278;

  vec3 F_82(vec3 f0, vec3 edge, float u){
    vec3 fs = F_Schlick(f0, u);
    vec3 fsBar = f0 + (vec3(1.0) - f0) * F82_SCHLICK_BAR;
    float k = u * pow(1.0 - u, 6.0) / F82_DENOM;
    return max(fs - k * (fsBar - edge), vec3(0.0));
  }

  /**
   * The opaque kinds.
   *
   * There is no environment map here — the only "world" this renderer has is the lamp plate
   * hanging behind the scene, so that is what gets reflected, projected along the reflection ray
   * by the same backplate() used for refraction. It is a crude environment, and a metal shape is
   * only ever as convincing as a flat backdrop standing in for one; what it does buy is that
   * opaque and transmissive shapes are lit by the SAME field and sit in the same room.
   *
   * The plate is also a BACKLIGHT — it is behind everything — so an opaque form would read as a
   * silhouette on the key alone. The backlight term is what puts a halo on its edges and keeps it
   * from punching a dead hole in the frame.
   */
  /**
   * A separate key for the opaque kinds.
   *
   * KEY above points almost straight up, which is right for glass: there it only drives a small
   * specular accent on a shape that is already lit from behind by the plate. An opaque form has
   * nothing but this light to reveal it, and the compositions here are mostly VERTICAL cylinders —
   * whose normals are horizontal, so a vertical key lands on none of them and every shape comes
   * out a flat, identical pastel. This one comes from the upper front-left, so a barrel actually
   * turns through the light.
   */
  const vec3 OPAQUE_KEY = normalize(vec3(-0.45, 0.55, 0.70));

  /**
   * A stand-in for the room this renderer has no way to represent.
   *
   * The lamp plate is a flat panel BEHIND the scene, so it covers almost none of the hemisphere a
   * reflective surface actually sees. This fills in the rest with the one thing every product shot
   * has — a bright ceiling and a darker floor — which is what draws a horizon across a metal
   * cylinder and gives it its form.
   */

  vec3 shadeOpaque(vec3 N, vec3 V, float ndv){
    vec3 L = OPAQUE_KEY;
    vec3 H = normalize(V + L);
    float NoV = max(ndv, 1e-4);
    float NoL = max(dot(N, L), 0.0);
    float NoH = max(dot(N, H), 0.0);
    float LoH = max(dot(L, H), 0.0);
    float a = uRough * uRough;

    bool metal = uKind < 4.5;
    // The one line that actually separates a conductor from a dielectric: for a metal the
    // normal-incidence reflectance IS its colour (measured — see MATERIAL_PRESETS), and there is
    // no diffuse lobe at all. A dielectric reflects ~4% white regardless of what colour it is,
    // which is why a red plastic has a WHITE highlight and red-gold does not.
    vec3 f0 = metal ? uAlbedo : vec3(0.04);

    // Direct light from the key.
    //
    // D_GGX is a normalized distribution, so its peak goes as 1/alpha² — into the hundreds for a
    // polished surface. A physical renderer balances that against the light's radiance and then
    // tone-maps; this pipeline is display-referred end to end and does neither, so an untouched
    // GGX highlight simply clips to a white blob. Compressing it (Reinhard) keeps the LOBE — the
    // shape and falloff that the whole microfacet model is for — while bounding the peak.
    float D = D_GGX(NoH, a);
    float Vis = V_SmithGGXCorrelated(NoV, NoL, a);
    // Only conductors get the F82 treatment: it is a correction to Schlick's conductor error, and
    // a dielectric's 4% is already well within Schlick's accurate range.
    bool edged = metal && uUseEdge > 0.5;
    vec3 F = edged ? F_82(f0, uEdge, LoH) : F_Schlick(f0, LoH);
    vec3 direct = D * Vis * F * NoL;
    direct = direct / (1.0 + direct);

    // Environment: the lamp plate, along the mirror direction. There is no prefiltered radiance
    // to fall back on here, so a rough surface fades its reflection toward the ambient fill
    // instead of blurring it — the same trick a mip-biased cubemap would do, minus the cubemap.
    //
    // Where the reflection ray misses the plate it lands on STUDIO() rather than a constant. That
    // matters more than it sounds: a polished conductor reflects ~96% at every angle, so its
    // Fresnel term is nearly flat and carries no shading at all — every bit of a metal's form
    // comes from variation in what it reflects. Against a flat fallback an aluminium rod is a
    // featureless white stripe, which is exactly how this first rendered.
    vec3 R = reflect(-V, N);
    vec4 env = backplate(vW, R);
    vec4 behind = backplate(vW, -N);
    vec3 fill = mix(vec3(0.92), behind.rgb, behind.a * 0.6);
    // The room at this surface's own cone width, with the plate over it. Roughness used to fade
    // the whole thing toward a flat fill colour — a rough metal reflected LESS room rather than a
    // blurred one, which reads as chalk. Where a prefiltered chain exists the blur is real, so the
    // fade drops to a token amount; the old weight survives only as the analytic fallback.
    float coneFade = uEnvOn > 0.5 ? uRough * 0.18 : uRough * 0.75;
    vec3 envCol = mix(mix(studioCone(R, uRough), env.rgb, env.a), fill, coneFade);
    vec3 Fenv = edged ? F_82(f0, uEdge, NoV) : F_Schlick(f0, NoV);

    vec3 col;
    if (metal){
      col = envCol * Fenv + direct * uSpec;
    } else {
      // CERAMIC keeps a wrapped diffuse term. That is not Lambert and not physical — it stands in
      // for subsurface scattering, which is most of why unglazed clay reads as clay: light bleeds
      // past the terminator instead of stopping dead at it. PLASTIC gets plain Lambert, so the
      // two differ by their light transport and not just by a gloss number.
      float wrapped = uKind > 5.5 ? NoL : pow(NoL * 0.5 + 0.5, 1.7);
      // Energy conservation: whatever the surface reflects specularly cannot also be diffused.
      vec3 kd = (vec3(1.0) - Fenv) * uAlbedo;
      col = kd * (fill * 0.42 + wrapped * 0.82) + direct * uSpec + envCol * Fenv;
    }
    return col + fill * pow(1.0 - ndv, 3.0) * uRim * 1.6;
  }

  void main(){
    vec3 N = normalize(vN);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(uCam - vW);
    float ndv = clamp(dot(N, V), 0.0, 1.0);

    // The opaque kinds never touch the refraction below. Branching on a uniform is coherent —
    // every fragment of a draw takes the same side — so the transmissive path pays nothing for
    // this beyond the program being larger.
    if (uKind > 3.5){
      vec3 oc = shadeOpaque(N, V, ndv);
      oc = mix(vec3(dot(oc, vec3(0.3333))), oc, uSat);
      oc = (oc - 0.5) * 1.04 + 0.5;
      oc += vec3(uEmis) * 0.5;
      gl_FragColor = vec4(oc, uPass > 0.5 ? 1.0 : vVZ / FAR);
      return;
    }

    // FROSTED scatters the ray before it is refracted, so the plate behind arrives as a diffuse
    // glow rather than an image. Seeded on world position, so the grain sits ON the surface and
    // stays put as the shape turns, instead of crawling with the camera.
    if (uKind > 0.5 && uKind < 1.5){
      N = jitter(N, floor(vW * 90.0), uRough * 0.55);
      ndv = clamp(dot(N, V), 0.0, 1.0);
    }

    // LIQUID tilts the normal through a travelling wave field before the ray is bent — the same
    // hook as frosted, animated and smooth instead of seeded and granular. Everything downstream
    // (dispersion, chord, Fresnel, rim) reads the rippled normal, which is why the shimmer stays
    // coherent instead of looking pasted on.
    if (uKind > 2.5 && uKind < 3.5 && uRipple > 0.001){
      N = rippleNormal(N, vW);
      ndv = clamp(dot(N, V), 0.0, 1.0);
    }

    float e0 = 1.0 / uIOR;
    vec3 lit;
    float amt;
    if (uConeTransmission > 0.5){
      // A CONE of refracted rays rather than three, adapted from the reference's transmission
      // example. Two things fall out of it that the three-ray version cannot express.
      //
      // Dispersion becomes a continuum: every sample carries its own index and a smooth RGB
      // weight, instead of red, green and blue each being one ray at one index. Three bins put
      // hard colour fringes on any edge whose refraction moves faster than the bins are wide,
      // which on a faceted solid is most of them.
      //
      // And roughness finally SCATTERS. A rough surface refracts into a spread of directions, so
      // frosted glass gathers light from an area behind it; blurring one lookup instead smears
      // whatever that single ray happened to hit, which reads as a dirty window rather than as
      // frosting. The spread goes as roughness squared, so a polished surface pays for the loop
      // and nothing else.
      float rotation = coneRotation(gl_FragCoord.xy);
      float radius = uRough * uRough * 0.18;
      vec3 spectrum = vec3(0.0);
      vec3 weightSum = vec3(0.0);
      float cover = 0.0;
      for (int i = 0; i < CONE_SAMPLES; i++){
        float t = (float(i) + 0.5) / float(CONE_SAMPLES);
        // uDisp is an offset in ETA, and the three-ray version spanned e0-uDisp to e0+uDisp — so
        // the same authored number means the same total spread here.
        vec3 base = bendDir(V, N, e0 + (t - 0.5) * 2.0 * uDisp);
        vec4 p = backplate(vW, coneDirection(base, i, radius, rotation));
        vec3 w = uDisp > 1e-5 ? spectralWeight(t) : vec3(1.0);
        spectrum += p.rgb * w;
        weightSum += w;
        cover += p.a;
      }
      lit = spectrum / max(weightSum, vec3(1e-4));
      amt = cover / float(CONE_SAMPLES);
    } else {
      // Three rays at three IORs — hand-rolled dispersion, because the point is the plate field.
      vec4 pR = backplate(vW, bendDir(V, N, e0 - uDisp));
      vec4 pG = backplate(vW, bendDir(V, N, e0        ));
      vec4 pB = backplate(vW, bendDir(V, N, e0 + uDisp));
      lit = vec3(pR.r, pG.g, pB.b);
      amt = (pR.a + pG.a + pB.a) / 3.0;
    }

    // A shape can carry its own colour instead of borrowing the lamps behind it.
    lit = mix(lit, uTint, uUseTint);
    amt = mix(amt, 1.0, uUseTint);

    // Hue rotation of the transmitted light: Rodrigues rotation of the colour vector about the
    // grey axis — cheap, and it moves only lit, so everything derived from it (the absorption
    // hue, the emission glow) shifts together while reflections keep the true lamp colours.
    // Branching on a uniform is coherent, so a resting shape pays nothing.
    if (abs(uHue) > 0.0005){
      float ha = uHue * 6.2831853;
      vec3 k = vec3(0.57735027);
      lit = max(lit * cos(ha) + cross(k, lit) * sin(ha) + k * dot(k, lit) * (1.0 - cos(ha)), 0.0);
    }

    // BASE: what is genuinely behind this fragment. On the main pass that is the plate pass's
    // frame, displaced in screen space — which is what lets glass refract other glass.
    // The displacement is RIM-WEIGHTED: a near-flat window in the middle, hard bending at the
    // edge. Uniform displacement reads as frosted; edge-loaded displacement reads as cut.
    vec3 base = uClearCol;
    float tracedPath = -1.0;
    if (uPass > 0.5){
      vec2 suv = (vProj.xy / vProj.w) * 0.5 + 0.5;
      vec2 off = vec2(vVN.x / uAspect, vVN.y) * uLens * pow(1.0 - ndv, 1.35) * 3.4;
      if (uPrism > 0.5){
        vec3 inside = bendDir(V, N, 1.0 / max(uIOR, 1.0));
        float t = prismExit(vW, inside);
        if (t > 0.0){
          tracedPath = t;
          vec4 clip = uViewProj * vec4(vW + inside * t, 1.0);
          off = ((clip.xy / max(clip.w, 1e-5)) * 0.5 + 0.5) - suv;
        }
      }
      vec4 smp = texture2D(tBg, clamp(suv + off, vec2(0.002), vec2(0.998)));
      // Depth validation. The plate pass stored linear depth in alpha; reject any sample NEARER
      // than this fragment, or shapes pick up the silhouette of whatever is in front of them and
      // the whole cluster gains a ghost outline. This is what buys the high blend weight below.
      base = mix(base, smp.rgb, 0.94 * step(vVZ - 0.30, smp.a * FAR));
    }

    // Beer-Lambert. The optical path is either MEASURED from the back-face depth pass, or falls
    // back to an analytic chord through a cylinder.
    //
    // 2R·(N·V) is exactly the chord through a cylinder — which is why the fallback survived so
    // long: the reference scene is entirely rods, and there it is not an approximation at all. It
    // is wrong for everything else. A sphere gets one constant across its whole disc, a cone the
    // same value at tip and base, a ring the same looking through the hole as through the wall.
    //
    // The pow(ndv, 0.40) is a deliberate cheat kept in BOTH paths: the true chord falls off so
    // fast at the silhouette that it leaves a wide white rim eating most of the shape's width.
    // Since a cylinder's measured thickness is exactly 2·uPath·ndv, multiplying the measurement by
    // ndv^-0.6 reproduces the authored curve identically for rods while being correct elsewhere —
    // the shaping is preserved, only the geometry term stops being a guess.
    float chord;
    if (tracedPath > 0.0){
      // The trace already walked the real path — this is the exact distance through the glass for
      // this fragment's refracted ray, not an approximation of it.
      chord = tracedPath;
    } else if (uThick > 0.5){
      vec2 duv = (vProj.xy / vProj.w) * 0.5 + 0.5;
      float backZ = dec(texture2D(tBack, clamp(duv, vec2(0.0), vec2(1.0))).rg) * FAR;
      chord = max(backZ - vVZ, 0.0) * pow(max(ndv, 0.02), -0.6);
    } else {
      chord = 2.0 * uPath * pow(ndv, 0.40);
    }
    float trans = (1.0 - exp(-uSigma * chord)) * amt;

    // Colour as LIGHT, not pigment: take the lamp's chroma and keep the brightness of what is
    // behind. mix(white, tint, absorb) darkens as it saturates and looks muddy. The 0.55 matters
    // too — full chroma normalization turns smooth gradients into hard posterized patches.
    vec3 hue = lit / max(max(lit.r, max(lit.g, lit.b)), 0.001);
    hue = mix(lit, hue, 0.55);
    vec3 col = base * mix(vec3(1.0), hue, trans);

    // ABSORPTION overrides that, when a material asks for it.
    //
    // The model above gives glass no colour of its own — it borrows chroma from whatever lamps
    // happen to sit behind it. That is the right call for a pale studio full of coloured light,
    // and it cannot express the most recognisable property of coloured glass: that the thick parts
    // are more saturated than the thin ones. It also means a shape in a dark scene has nothing to
    // take colour FROM, so the scene has to invent lamps to light it.
    //
    // Beer-Lambert per channel fixes both. Transmittance is exp(-sigma*d) with a coefficient per
    // channel, so the tint deepens with the optical path this fragment actually traversed and owes
    // nothing to the lamp field.
    if (uUseAbsorb > 0.5){
      vec3 transmittance = exp(-uAbsorb * chord);
      col = base * mix(vec3(1.0), transmittance, amt);
    }
    col += lit * trans * uEmis;

    float F = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
    vec3 R = reflect(-V, N);
    vec4 rf = backplate(vW, R);
    // Where the reflection ray misses the plate, land it on the studio rather than on a flat
    // constant. Metals have always done this; glass did not, which is why a shape over a dark
    // backdrop had nothing to reflect and came out a silhouette with no faces.
    vec3 rfCol = mix(studio(R), rf.rgb, rf.a);
    // The film tints what the surface REFLECTS — reflection, rim and specular — never what it
    // transmits: interference happens to the bounced wave, and colouring the transmission too
    // reads as dye. A film also reflects far more than bare glass and its coloured band reaches
    // much further in from the silhouette, hence the strength boost and the widened rim window.
    vec3 film = thinFilm(ndv);
    // The reflection carries far more weight under the softbox. 0.16 is tuned for a bright plate
    // sitting behind the glass, where the reflection is a garnish on top of a lit shape; in a dark
    // room it is the ONLY thing describing the solid, and at 0.16 the prism stays a silhouette.
    float reflW = uStudio > 0.5 ? F * (0.62 + uIrid * 0.38) : F * (0.16 + uIrid * 0.9);
    col = mix(col, (uStudio > 0.5 ? rfCol : mix(vec3(0.97), rf.rgb, rf.a)) * film, reflW);
    // The rim window. 0.62 means "the last ~68 degrees before edge-on", which sounds generous and
    // is not: on a smooth convex surface N.V collapses fast, so even this only paints a band.
    //
    // It was 0.90 -- the last six degrees -- and at that width uRim was measurably INERT on eight
    // of the eleven shape kinds: swung from 0 to 3, the rendered frame came back bit-identical for
    // a rod, disc, cone, sphere, arrow, droplet, blob and slab, because the band was thinner than
    // a pixel. It survived only on prism and hex, whose flat facets hold a whole face near
    // grazing. A parameter every preset sets and no shape responds to is not a subtle parameter,
    // it is a broken one.
    col = mix(col, film, smoothstep(mix(0.62, 0.42, uIrid), 1.0, 1.0 - ndv) * uRim);
    col *= 1.0 - smoothstep(0.62, 0.86, 1.0 - ndv) * 0.10;

    // The specular lobe. 40 is tight enough to read as a hard studio highlight and wide enough to
    // FIND the key light.
    //
    // This was 140, and the same audit says why that was wrong: at 140 the lobe is so narrow it
    // only fires where a fragment's mirror direction lands almost exactly on KEY, and uSpec came
    // back dead on seven of eleven kinds -- every lathe whose normals form a one-parameter family
    // (rod, cone) and every flat-faceted solid (disc, prism, hex, slab, arrow). Pushing uSpec to
    // 30 did not rescue them, because the term it multiplies was exactly zero.
    vec3 spec = reflect(-V, N);
    float lobe = pow(max(dot(spec, KEY), 0.0), 40.0) + 0.55 * pow(max(dot(spec, KEY_FILL), 0.0), 40.0);
    col += lobe * uSpec * mix(vec3(1.0), film, uIrid);

    // GLITTER — a field of tiny mirrors embedded in the surface. Each cell gets its own normal,
    // so only the few facets that happen to point at the key light fire, and which ones those are
    // changes as the shape turns. That flicker IS the effect; a smooth highlight is not glitter.
    //
    // Two things here follow Zirr & Kaplanyan's multiscale glint work rather than being invented:
    // the facet response is the microfacet NDF (a very tight GGX lobe) rather than an arbitrary
    // exponent, and the CELL DENSITY is tied to the screen-space footprint. Without that second
    // part the cells shrink below a pixel as a shape recedes and the sparkle turns into crawling
    // noise — which is the aliasing their paper exists to solve.
    if (uKind > 1.5 && uKind < 2.5){
      float footprint = max(fwidth(vW.x) + fwidth(vW.y), 1e-4);
      float density = min(uSparkleScale, 0.85 / footprint);
      vec3 cell = floor(vW * density);
      vec3 fN = jitter(N, cell, 0.85);
      vec3 Hs = normalize(V + KEY);
      float facet = D_GGX(max(dot(fN, Hs), 0.0), 0.02);
      // Only a fraction of cells are reflective at all, or the surface reads as static.
      float on = step(0.72, hash13(cell + 3.3));
      col += facet * on * uSparkle * 0.06;
    }

    col = mix(vec3(dot(col, vec3(0.3333))), col, uSat);
    col = (col - 0.5) * 1.04 + 0.5;

    // Alpha does two different jobs. On the PLATE pass it carries linear depth, which is what the
    // main pass validates its samples against. On the MAIN pass nothing reads depth back, so it
    // carries coverage instead — that is what lets the post pass composite the scene over a
    // transparent background.
    gl_FragColor = vec4(col, uPass > 0.5 ? 1.0 : vVZ / FAR);
  }`;

export const BACKDROP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/** The backdrop samples the same lamps, faintly. If colour appears *only* inside glass, the eye
 *  reads it as tint however it was computed — a faint presence in the gaps is what sells
 *  "behind". */
export const BACKDROP_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uTop, uBot;
  uniform float uShow;
  uniform vec2 uSize, uPlateScale, uPlateOffset;

  // -- Painted backdrop ------------------------------------------------------
  // uMode: 0 = the derived vertical ramp, 1 = palette gradient, 2 = image / video.
  uniform int   uMode;
  uniform vec4  uStop[${MAX_STOPS}];     // rgb + position along the ramp
  uniform int   uStopCount;
  uniform int   uGradType;                       // 0 linear, 1 radial, 2 conic, 3 mesh
  uniform float uAngle;
  uniform vec4  uMesh[${MAX_MESH_POINTS}];      // xy = centre, z = unused, w = unused
  uniform vec3  uMeshCol[${MAX_MESH_POINTS}];
  uniform int   uMeshCount;
  uniform float uMeshSoft;
  uniform sampler2D tImage;

  // -- Wall mode -------------------------------------------------------------
  uniform vec2  uWallExtent, uWallLightUv, uWallPrism;
  uniform vec3  uWallLightDir;
  uniform float uWallScale, uWallNormal, uWallGamma, uWallContrast, uWallPivot;
  uniform float uWallFloor, uWallHighlight, uWallAmbient, uWallAmbientLight;
  uniform float uWallShadow, uWallGrounding;
  // The second, finer noise octave. Supplied by the renderer since the wall was written, but never
  // DECLARED here — so the program failed to compile and the whole backdrop drew nothing. It went
  // unnoticed behind the 'half' reserved-word error above it, which failed first.
  uniform float uWallMicroFreq, uWallMicroNormal;
  uniform vec4  uGround[GROUND_SLOTS];        // (centre.xy, apothem, sides)
  uniform float uGroundPhase[GROUND_SLOTS];
  uniform int   uGroundCount;

  float hash12(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  /** Bilinear value noise — enough to break a flat wall up without reading as a pattern. */
  float valueNoise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
      mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0)), u.x),
      u.y);
  }

  /**
   * A contrast curve that pivots rather than clipping, ported from the reference.
   *
   * Both halves are power curves anchored at the pivot, so raising contrast deepens the shadows and
   * lifts the highlights around a chosen value instead of crushing one end. A plain pow() would
   * pull the whole wall dark.
   */
  /**
   * A tangent-space normal from its XY, with the slope LIMITED rather than normalized away.
   *
   * normalize(vec3(x, y, 1)) silently rescales z, so a strong field flattens itself: doubling
   * the strength past a point stops tilting the normal any further. Clamping the XY to unit length
   * and solving z from it keeps the normal on the hemisphere and keeps strength meaning something
   * all the way up — and a field that would have tipped past horizontal lands exactly at grazing
   * instead of folding through.
   */
  vec3 wallNormalFromXy(vec2 xy){
    vec2 limited = xy / max(length(xy), 1.0);
    return normalize(vec3(limited, sqrt(max(1.0 - dot(limited, limited), 0.0001))));
  }


  /**
   * Log-sum-exp soft maximum — the reference's smoothMaximum3, generalized to a running fold.
   *
   * Intersecting a polygon's half-planes with a hard max and then feathering the result keeps a
   * fully opaque core with needle-sharp vertices however wide the blur gets, which is not what a
   * blurred silhouette looks like. A soft max erodes the corners as the softness grows, which is
   * much closer to actually filtering the projected shape.
   */
  float softMax(float a, float b, float rounding){
    float r = max(rounding, 0.0001);
    float m = max(a, b);
    return m + r * log(exp((a - m) / r) + exp((b - m) / r));
  }

  /**
   * Signed distance from a wall point to a solid's footprint.
   *
   * The vec4 is (centre.xy, apothem, sides); zero sides means a circle, which is the honest footprint
   * for every lathe that is not a prism. A regular polygon needs no per-corner uniforms: edge i's
   * outward normal is just its angle, so the distance is a dot product minus the apothem.
   */
  float footprintDistance(vec2 p, vec4 g, float phase){
    vec2 d = p - g.xy;
    if (g.w < 2.5) return length(d) - g.z;
    float step = 6.2831853 / g.w;
    float acc = -1e9;
    for (int i = 0; i < GROUND_MAX_SIDES; i++){
      if (float(i) >= g.w) break;
      float a = phase + (float(i) + 0.5) * step;
      acc = softMax(acc, dot(d, vec2(cos(a), sin(a))) - g.z, uWallGrounding * 0.22);
    }
    return acc;
  }

  /**
   * A 0 -> 1 transition centred ON the contour, so the true silhouette sits at the half value.
   *
   * NOT named 'half'. That is a reserved word in GLSL ES 3.00, and three rewrites every non-raw
   * ShaderMaterial to 3.00 — so the declaration failed to compile, took the whole backdrop program
   * with it, and the wall mode drew nothing at all. A dead backdrop looks like a scene that simply
   * has no wall configured, which is why it survived so long.
   */
  float softInside(float distance, float amplitude){
    float edge = max(amplitude * 0.5, 0.0001);
    return 1.0 - smoothstep(-edge, edge, distance);
  }

  float shadowContrastCurve(float v, float contrast, float pivot){
    float p = clamp(pivot, 0.001, 0.999);
    float k = max(contrast, 0.001);
    return v < p ? p * pow(v / p, k) : 1.0 - (1.0 - p) * pow((1.0 - v) / (1.0 - p), k);
  }
  uniform int   uHasImage;
  uniform int   uImageFit;                       // 0 cover, 1 contain, 2 stretch
  uniform float uImageZoom, uImageAspect;
  uniform vec2  uImageOffset;
  /** Visible fraction of this plane, per axis — the plane is deliberately oversized. */
  uniform vec2  uFrame;

  ${PLATE_CHUNK}

  /** Sample the palette at t, walking the stops in order. */
  vec3 ramp(float t){
    if (uStopCount <= 0) return vec3(1.0);
    if (uStopCount == 1) return uStop[0].rgb;
    t = clamp(t, 0.0, 1.0);
    vec3 c = uStop[0].rgb;
    for (int i = 0; i < ${MAX_STOPS} - 1; i++){
      if (i + 1 >= uStopCount) break;
      float a = uStop[i].w;
      float b = uStop[i + 1].w;
      // A zero-width span would divide by zero; step past it and let the later stop win.
      float f = b > a ? clamp((t - a) / (b - a), 0.0, 1.0) : step(b, t);
      c = mix(c, uStop[i + 1].rgb, f);
    }
    return c;
  }

  void main(){
    // The backdrop plane is bigger than the frustum (it has to be, or an orbit reveals its edge),
    // so map the VISIBLE window of it to 0..1 before painting — otherwise every gradient and image
    // would be authored against a rectangle wider than the one being exported.
    vec2 fuv = (vUv - 0.5) / max(uFrame, vec2(1e-4)) + 0.5;

    vec3 c;
    if (uMode == 2 && uHasImage == 1){
      vec2 uv = fuv - 0.5;
      if (uImageFit != 2){
        // Compare the frame's aspect against the image's; correct along whichever axis has to
        // give. cover crops the long side, contain letterboxes it.
        float frameAspect = (uSize.x * uFrame.x) / max(uSize.y * uFrame.y, 1e-4);
        float ratio = frameAspect / max(uImageAspect, 1e-4);
        bool wide = uImageFit == 0 ? ratio > 1.0 : ratio < 1.0;
        if (wide) uv.y *= ratio; else uv.x /= ratio;
      }
      uv = uv / max(uImageZoom, 1e-4) + uImageOffset;
      c = texture2D(tImage, uv).rgb;
      // Outside the image, fall back to the flat colour rather than smearing its edge pixels.
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) c = uBot;
    } else if (uMode == 3){
      // -- Wall ---------------------------------------------------------------
      //
      // A lit SURFACE rather than a painted ramp, adapted from the reference's wall-common.wgsl.
      // The prism there does not float in black: it stands a few millimetres in front of a wall,
      // and almost everything that reads as depth — the falloff around the beam, the contact
      // shadow under the glass, the sheen the fan picks up — is that wall responding to light.
      //
      // The reference samples two BAKED textures here: a material map and a GPU-baked global light
      // mask. Neither is portable, so both are analytic below: a value-noise material and a
      // directional gradient standing in for the mask. The lighting composition, the shadow
      // contrast curve and its constants are ported exactly, because that is the part that decides
      // how the wall reads.
      vec2 wp = (vUv - 0.5) * 2.0 * uWallExtent;

      // Material: a slow albedo variation and a finer roughness break-up, so the specular is not
      // a perfect mirror sheet.
      float m = valueNoise(wp * uWallScale) * 0.5 + valueNoise(wp * uWallScale * 3.7) * 0.5;

      // TWO normal fields at different frequencies, not one — the reference's wall-normal.wgsl.
      // A single field has to choose: coarse enough to shape the light across the wall, or fine
      // enough to break up the specular, and it cannot be both. The large scale bends the diffuse
      // over hand-sized areas; the micro runs seven times faster and is what stops the sheen
      // reading as a mirror sheet. Their strengths are theirs — 0.22 and 1.05 — and the micro
      // being the far stronger of the two is the point: it is the surface, the large scale is
      // only the wall not being flat.
      //
      // The micro field is OFFSET so it does not correlate with the large one. Sampling both at
      // the same place makes them reinforce at the same points, which is one field with an odd
      // profile rather than two scales.
      float e = 0.02;
      vec2 largeXy = vec2(
        m - valueNoise((wp + vec2(e, 0.0)) * uWallScale * 3.7),
        m - valueNoise((wp + vec2(0.0, e)) * uWallScale * 3.7)) * uWallNormal;
      vec2 microUv = wp * uWallScale * uWallMicroFreq + vec2(0.371, 0.613);
      float micro = valueNoise(microUv);
      vec2 microXy = vec2(
        micro - valueNoise(microUv + vec2(e, 0.0)),
        micro - valueNoise(microUv + vec2(0.0, e))) * uWallMicroNormal;
      vec3 N = wallNormalFromXy(largeXy + microXy);
      // The specular reads the micro scale ALONE. It is a mirror of a small solid angle, so what
      // it responds to is the finest structure present; giving it the combined normal lets the
      // large scale drag the whole highlight around and the wall looks warped rather than rough.
      vec3 microN = wallNormalFromXy(microXy);

      // Global light: the reference's baked mask, standing in as a broad directional falloff.
      // Broad, and that matters: the contrast curve below pivots at 0.9, so anything under that
      // is crushed to near black. The reference's baked mask sits high across most of the wall,
      // and a stand-in that falls off quickly would light nothing at all.
      float gl = clamp(1.0 - length((vUv - uWallLightUv) * vec2(0.85, 1.15)) * 0.62, 0.0, 1.0);
      gl = pow(gl, max(uWallGamma, 0.001));
      gl = shadowContrastCurve(gl, uWallContrast, uWallPivot);

      vec3 L = normalize(uWallLightDir);
      float facing = max(dot(N, L), 0.0);
      float diffuse = mix(uWallAmbient, 1.0, facing);
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float specular = pow(max(dot(microN, H), 0.0), mix(48.0, 4.0, m)) * mix(0.12, 0.025, m);

      vec3 albedo = uBot * (0.5 + 0.5 * m);
      vec3 direct = albedo * diffuse + vec3(specular);
      // The mask drives BOTH the local exposure and the neutral incident radiance. Merely adding
      // it over a uniformly lit wall lifts the shadows, and the tone curve then compresses all the
      // authored separation into white.
      float baseExposure = mix(uWallFloor, uWallHighlight, gl);
      vec3 globalIllum = vec3(gl * uWallAmbientLight * (0.5 + 0.5 * m) * mix(0.25, 1.0, facing));

      // Contact shadow and ambient occlusion where a solid meets the wall — the shape of the
      // solid, not a disc under the middle of the scene. Adapted from the reference's floor-AO
      // pass, which is where the reason for the odd soft-max below is spelled out.
      //
      // Deliberately an occlusion mask rather than a cast shadow: the room is swappable now, and a
      // directional shadow would contradict the reflections the moment the key light moved.
      float occl = 0.0;
      for (int i = 0; i < GROUND_SLOTS; i++){
        if (i >= uGroundCount) break;
        vec4 g = uGround[i];
        occl = max(occl, softInside(footprintDistance(wp, g, uGroundPhase[i]), uWallGrounding));
      }
      float grounding = mix(1.0, 1.0 - uWallShadow, occl);

      c = (direct * baseExposure + globalIllum) * grounding;
    } else if (uMode == 1){
      if (uGradType == 3){
        // Mesh: inverse-distance blend of the blobs. Weights are normalized, so the field is a
        // true average — no blob can blow past the palette's range.
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        for (int i = 0; i < ${MAX_MESH_POINTS}; i++){
          if (i >= uMeshCount) break;
          vec2 d = fuv - uMesh[i].xy;
          float w = exp(-dot(d, d) / max(uMeshSoft * uMeshSoft, 1e-6));
          acc += uMeshCol[i] * w;
          wsum += w;
        }
        c = wsum > 1e-5 ? acc / wsum : uBot;
      } else if (uGradType == 1){
        c = ramp(length(fuv - 0.5) * 1.41421356);
      } else if (uGradType == 2){
        vec2 d = fuv - 0.5;
        c = ramp(fract((atan(d.y, d.x) - uAngle) / 6.28318531 + 1.0));
      } else {
        vec2 dir = vec2(cos(uAngle), sin(uAngle));
        c = ramp(dot(fuv - 0.5, dir) + 0.5);
      }
    } else {
      c = mix(uBot, uTop, smoothstep(0.0, 1.0, vUv.y));
    }

    vec2 p = (vUv - 0.5) * uSize / uPlateScale + uPlateOffset;
    vec4 lp = plate(p);
    gl_FragColor = vec4(mix(c, lp.rgb, lp.a * uShow), 1.0);
  }`;

/** Linear view depth packed across two channels for ~16 bits of precision. */
export const DEPTH_VERT = /* glsl */ `
  varying float vZ;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vZ = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

export const DEPTH_FRAG = /* glsl */ `
  precision highp float;
  varying float vZ;
  void main(){
    float d = clamp(vZ / ${FAR_LITERAL}, 0.0, 1.0);
    vec2 e = vec2(d, fract(d * 255.0));
    e.x -= e.y / 255.0;              // decode: e.x + e.y / 255.0
    gl_FragColor = vec4(e, 0.0, 1.0);
  }`;

export const POST_VERT = /* glsl */ `
  varying vec2 vUvIn;
  void main(){
    vUvIn = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

/**
 * Depth of field (golden-angle spiral gather), saturation-weighted bloom, caustics, haze,
 * vignette and grain. `DOF_TAPS` and `CAUSTIC_TAPS` are defines so the renderer can trade taps
 * for frame time at low quality without branching per pixel.
 */
export const POST_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tColor, tDepth;
  uniform vec2  uRes;
  uniform vec3  uHazeCol;
  uniform float uFocus, uRange, uAperture, uBloom, uCaustics;
  uniform float uHaze, uHazeTop, uVignette, uGrain, uTime, uScale, uTransparent;
  uniform float uBloomRadius, uBloomThresh;
  uniform float uToneMap;   // 0 none, 1 neutral, 2 ACES
  uniform sampler2D tBloom;
  uniform float uBloomMode; // 0 the gather below, 1 the pyramid in tBloom
  uniform vec2  uMirror;   // 1 = flip that axis
  varying vec2 vUvIn;

  const float FAR = ${FAR_LITERAL};
  const float TAPS = float(DOF_TAPS);
  const float GOLDEN_ANGLE = 2.39996323;

  float dec(vec2 e){ return e.x + e.y / 255.0; }

  // Weight bloom by SATURATION, not brightness. A standard bright-pass is useless against a
  // near-white backdrop — the background is the brightest thing in frame.
  float sat(vec3 c){ return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

  /**
   * Khronos PBR "neutral" tone map, adapted from Vercel's vgpu (MIT) — see THIRD-PARTY-NOTICES.
   *
   * The reason this is here rather than a plain clamp: an additive light sheet delivers values far
   * above 1, and clamping each channel independently drives every bright colour to a primary or a
   * secondary. A spectrum clipped that way turns into magenta / cyan / yellow bars — the hue is
   * destroyed exactly where the picture is brightest. This compresses the PEAK and desaturates
   * toward it, so an over-range colour fades to white through its own hue instead of hard-edging
   * into someone else's.
   */
  vec3 tonemapNeutral(vec3 v){
    vec3 c = max(v, vec3(0.0));
    const float START = 0.76;
    const float DESAT = 0.15;
    float lo = min(c.r, min(c.g, c.b));
    float offset = lo < 0.08 ? lo - 6.25 * lo * lo : 0.04;
    c -= vec3(offset);
    float peak = max(c.r, max(c.g, c.b));
    if (peak < START) return c;
    float d = 1.0 - START;
    float newPeak = 1.0 - d * d / (peak + d - START);
    c *= newPeak / max(peak, 0.0001);
    float amount = 1.0 - 1.0 / (DESAT * (peak - newPeak) + 1.0);
    return mix(c, vec3(newPeak), amount);
  }

  /** Narkowicz's ACES fit — punchier and more contrast than neutral, at the cost of hue shift. */
  vec3 tonemapAces(vec3 v){
    vec3 c = max(v, vec3(0.0));
    c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
    return clamp(c, 0.0, 1.0);
  }

  void main(){
    // Mirroring is a flip of the SOURCE lookup, so the haze ramp and the caustic pool below —
    // which key off the vertical position — flip with the picture rather than staying put.
    vec2 vUv = mix(vUvIn, vec2(1.0) - vUvIn, step(0.5, uMirror));

    float dC = dec(texture2D(tDepth, vUv).rg) * FAR;
    float r0 = pow(clamp(abs(dC - uFocus) / uRange, 0.0, 1.0), 1.2) * uAperture * uScale;

    // RGBA, not RGB: alpha is the main pass's coverage, and it has to be blurred by exactly the
    // same kernel as the colour or the depth of field would soften a shape's colour while leaving
    // its silhouette crisp.
    vec4 sum = texture2D(tColor, vUv);
    float wsum = 1.0;
    vec3 glow = vec3(0.0);

    for (int k = 0; k < DOF_TAPS; k++){
      float fi = float(k) + 1.0;
      float a = fi * GOLDEN_ANGLE;
      vec2 dir = vec2(cos(a), sin(a));
      float rad = sqrt(fi / TAPS) * r0;
      vec2 uv2 = vUv + dir * rad / uRes;

      // Occlusion guard: a sample in FRONT of this fragment only contributes in proportion to
      // its own circle of confusion, so a sharp foreground shape doesn't smear over a blurred one.
      float d2 = dec(texture2D(tDepth, uv2).rg) * FAR;
      float r2 = clamp(abs(d2 - uFocus) / uRange, 0.0, 1.0) * uAperture * uScale;
      float w = (d2 < dC - 0.4) ? smoothstep(0.0, rad + 0.001, r2) : 1.0;
      sum += texture2D(tColor, uv2) * w;
      wsum += w;

      vec3 g = texture2D(tColor, vUv + dir * (sqrt(fi / TAPS) * uBloomRadius * uScale) / uRes).rgb;
      // Threshold on saturation, not brightness — same reasoning as sat() above.
      glow += g * max(sat(g) - uBloomThresh, 0.0);
    }
    // The gather is over PREMULTIPLIED colour, which is the only form you can blur across an
    // alpha edge without bleeding: three premultiplies the clear colour, so a transparent
    // background clears to black whatever RGB it was given, and averaging that as straight colour
    // drags every soft edge toward black. Un-premultiply once here and the rest of the pass —
    // haze, vignette, grain — works in straight colour exactly as it does over a backdrop.
    vec4 acc = sum / wsum;
    float alphaIn = acc.a;
    vec3 straight = acc.rgb / max(alphaIn, 1e-4);
    // Either the gather above or the pyramid, never both — they are two answers to the same
    // question and summing them doubles the halo.
    vec3 bloom = uBloomMode > 0.5
      ? texture2D(tBloom, vUv).rgb * uBloom
      : (glow / TAPS) * uBloom;
    vec3 col = straight + bloom;
    // Bloom spilling past a shape's silhouette has to bring coverage with it, or over a
    // transparent background the glow is multiplied away against alpha 0 and never appears.
    float alpha = min(1.0, alphaIn + max(max(bloom.r, bloom.g), bloom.b));

    if (uCaustics > 0.001){
      // A downward saturation-weighted gather — a screen-space approximation of light pooling
      // under the glass, not refracted photons.
      vec3 caus = vec3(0.0);
      for (int k = 0; k < CAUSTIC_TAPS; k++){
        float o = (float(k) + 1.0) / float(CAUSTIC_TAPS);
        vec3 c = texture2D(tColor, vUv + vec2(sin(o * 9.0) * 0.012, o * 0.20)).rgb;
        caus += c * sat(c) * (1.0 - o);
      }
      vec3 pool = (caus / float(CAUSTIC_TAPS)) * smoothstep(0.46, 0.0, vUv.y) * uCaustics * 3.2;
      col += pool;
      alpha = min(1.0, alpha + max(max(pool.r, pool.g), pool.b));
    }

    float haze = smoothstep(uHazeTop, -0.02, vUv.y) * uHaze;
    col = mix(col, uHazeCol, haze);
    // Over a backdrop, haze is a veil painted on top. Over transparency there is nothing to paint
    // it onto, and the right reading is the same one the eye makes: the shapes dissolve into what
    // is behind them, so haze takes coverage away rather than adding a band of colour.
    alpha *= 1.0 - haze * uTransparent;

    vec2 q = vUv - 0.5;
    col *= 1.0 - dot(q, q) * uVignette;
    col += (fract(sin(dot(vUv * uRes, vec2(12.9898, 78.233)) + uTime) * 43758.5453) - 0.5) * uGrain;

    // Tone map LAST, after every additive contribution has landed and while the value is still
    // straight colour. Default 0 is a no-op: every preset built before this existed was calibrated
    // against a clamped frame, and silently compressing them all would move the reference.
    if (uToneMap > 1.5) col = tonemapAces(col);
    else if (uToneMap > 0.5) col = tonemapNeutral(col);

    // Back to premultiplied for the drawing buffer (three's default context attributes). With an
    // opaque background alpha is 1 throughout, so this and the divide above are both identities.
    gl_FragColor = vec4(col * alpha, alpha);
  }`;

export const FINISH_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

/**
 * The finish pass: light shafts and print-style stylisation over the composited frame.
 *
 * Why a second pass rather than more code at the tail of {@link POST_FRAG}: every effect here
 * needs to SAMPLE the finished image somewhere other than the current fragment — a ray march
 * toward a light source, a quantized block centre, a halftone cell centre. Inside the post pass
 * the only thing available is `tColor`, which is the main pass *before* depth of field, haze and
 * bloom, so a dot screen would be built from an image the viewer never sees. The renderer skips
 * this pass entirely when every effect is off, so the cost is zero unless it is asked for.
 *
 * `tDiffuse` is premultiplied (the post pass writes it that way for the drawing buffer), so this
 * un-premultiplies once up front, works in straight colour throughout — which is what all the
 * luminance and threshold maths below assume — and premultiplies once at the end.
 *
 * `dither` and `halftone` are DERIVED FROM @paper-design/shaders (Apache-2.0) — see
 * THIRD-PARTY-NOTICES.md and the per-effect notes below.
 */
export const FINISH_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tDiffuse;
  uniform vec2  uRes;
  uniform float uInner, uInnerDensity, uInnerDecay;
  uniform vec2  uInnerCentre;
  uniform float uDither, uDitherScale, uDitherSteps;
  uniform float uHalftone, uHalftoneCell, uHalftoneAngle;
  uniform float uCmyk, uCmykCell;
  uniform float uPaper, uPaperScale;
  varying vec2 vUv;

  const int LIGHT_SAMPLES = 24;
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  float luma(vec3 c){ return dot(c, LUMA); }
  /** Saturation, the same discriminator the bloom gather uses — see POST_FRAG. */
  float sat(vec3 c){ return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

  /** Straight (un-premultiplied) colour at uv. */
  vec4 src(vec2 uv){
    vec4 t = texture2D(tDiffuse, uv);
    return vec4(t.rgb / max(t.a, 1e-4), t.a);
  }

  // ---- Bayer matrices ----
  // DERIVED FROM @paper-design/shaders 'image-dithering' (Apache-2.0). The matrices, the lookup,
  // and the hue-preserving "quantize luminance, keep the source hue" recolour are paper's. The
  // int[] arrays and dynamic indexing compile because three builds ShaderMaterials as
  // "#version 300 es".
  const int bayer8x8[64] = int[64](
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21
  );
  float bayer(vec2 uv){
    ivec2 pos = ivec2(fract(uv / 8.0) * 8.0);
    return float(bayer8x8[pos.y * 8 + pos.x]) / 64.0;
  }

  float sigmoid(float x, float k){ return 1.0 / (1.0 + exp(-k * (x - 0.5))); }

  // DERIVED FROM @paper-design/shaders 'halftone-dots' (Apache-2.0): the classic dot whose radius
  // grows as the sampled cell darkens, antialiased with fwidth.
  float circle(vec2 uv, float lum, float baseR){
    float r = mix(0.25 * baseR, 0.0, lum);
    float d = length(uv - 0.5);
    float aa = fwidth(d);
    return 1.0 - smoothstep(r - aa, r + aa, d);
  }

  /** One rotated dot screen for a single ink. */
  float dotScreen(vec2 coord, float value, float angle, float cell){
    float ca = cos(angle), sa = sin(angle);
    vec2 r = mat2(ca, sa, -sa, ca) * coord;
    vec2 c = fract(r / max(cell, 2.0)) - 0.5;
    float radius = sqrt(clamp(value, 0.0, 1.0)) * 0.5;
    return smoothstep(radius, radius - 0.06, length(c));
  }

  float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main(){
    vec4 base = src(vUv);
    vec3 col = base.rgb;
    float alpha = base.a;

    // ---- Light shafts ------------------------------------------------------
    // Marches back toward the source accumulating what it passes through. Wave3D weights the
    // march by coverage alone, which works there because its shafts are authored over a
    // transparent background — alpha already says "this is the subject". Materials3D composites over
    // a near-white backdrop where alpha is 1 everywhere, so coverage alone would make the
    // BACKGROUND the brightest emitter and blow the frame out. Weighting by saturation as well is
    // the same trick the bloom gather uses, and it picks out exactly what a light shaft should
    // come from: the tinted, dispersed light that has already been through the glass.
    // Over a transparent background the shafts still carry their own coverage in, or they would
    // be multiplied away against alpha 0 and never appear.
    if (uInner > 0.001){
      vec2 delta = (vUv - uInnerCentre) * (uInnerDensity / float(LIGHT_SAMPLES));
      vec2 coord = vUv;
      float decay = 1.0;
      vec3 rays = vec3(0.0);
      for (int i = 0; i < LIGHT_SAMPLES; i++){
        coord -= delta;
        vec4 s = src(coord);
        rays += s.rgb * s.a * sat(s.rgb) * decay;
        decay *= uInnerDecay;
      }
      rays = rays / float(LIGHT_SAMPLES) * uInner * 3.0;
      col += rays;
      alpha = clamp(max(alpha, luma(rays)), 0.0, 1.0);
    }

    // ---- Ordered dithering -------------------------------------------------
    if (uDither > 0.001){
      float px = max(uDitherScale, 1.0);
      vec2 blockUv = (floor(gl_FragCoord.xy / px) + 0.5) * px / max(uRes, vec2(1.0));
      vec4 block = src(blockUv);
      float steps = max(floor(uDitherSteps), 1.0);
      float lum = luma(block.rgb);
      float bright = clamp(lum + (bayer(gl_FragCoord.xy / px) - 0.5) / steps, 0.0, 1.0);
      bright = mix(0.0, bright, block.a);
      float quant = floor(bright * steps + 0.5) / steps;
      // Keep the source hue, quantize only the luminance.
      vec3 dithered = block.rgb / max(lum, 0.001) * quant;
      float quantA = floor(block.a * steps + 0.5) / steps;
      col = mix(col, dithered, uDither);
      alpha = mix(alpha, mix(quant, 1.0, quantA), uDither);
    }

    // ---- Halftone dot screen ----------------------------------------------
    if (uHalftone > 0.001){
      float ca = cos(uHalftoneAngle), sa = sin(uHalftoneAngle);
      mat2 rot = mat2(ca, sa, -sa, ca);
      float cell = max(uHalftoneCell, 2.0);
      vec2 grid = rot * gl_FragCoord.xy;
      vec2 inCell = fract(grid / cell);
      vec2 centre = transpose(rot) * ((floor(grid / cell) + 0.5) * cell);
      vec4 tex = src(centre / max(uRes, vec2(1.0)));
      vec3 c = vec3(sigmoid(tex.r, 2.0), sigmoid(tex.g, 2.0), sigmoid(tex.b, 2.0));
      float lum = mix(1.0, luma(c), tex.a);
      float d = circle(inCell, lum, 1.3);
      col = mix(col, tex.rgb, uHalftone);
      alpha = mix(alpha, tex.a * d, uHalftone);
    }

    // ---- Process (CMYK) halftone ------------------------------------------
    if (uCmyk > 0.001){
      float k = 1.0 - max(max(col.r, col.g), col.b);
      float invK = max(1.0 - k, 1e-3);
      vec2 coord = gl_FragCoord.xy;
      float dc = dotScreen(coord, (1.0 - col.r - k) / invK, 1.309, uCmykCell); // 75°
      float dm = dotScreen(coord, (1.0 - col.g - k) / invK, 0.262, uCmykCell); // 15°
      float dy = dotScreen(coord, (1.0 - col.b - k) / invK, 0.0, uCmykCell);   //  0°
      float dk = dotScreen(coord, k, 0.785, uCmykCell);                        // 45°
      // Subtractive: each ink absorbs its complement, black absorbs everything.
      vec3 ink = clamp(vec3(1.0) - vec3(dc, 0.0, 0.0) - vec3(0.0, dm, 0.0)
                       - vec3(0.0, 0.0, dy) - vec3(dk), 0.0, 1.0);
      col = mix(col, ink, uCmyk);
    }

    // ---- Paper substrate ---------------------------------------------------
    if (uPaper > 0.001){
      vec2 p = gl_FragCoord.xy / max(uPaperScale, 0.5);
      float fibre = hash21(floor(p)) * 0.5 + hash21(floor(p * vec2(0.3, 3.0))) * 0.5;
      float tex = mix(fibre, hash21(gl_FragCoord.xy), 0.3);
      col *= mix(1.0, 1.0 - (tex - 0.5) * 0.35, uPaper);
    }

    gl_FragColor = vec4(col * alpha, alpha);
  }`;

/**
 * The prism beam's mesh (see `lightSheet.ts`).
 *
 * The tracer decides where every vertex goes and what colour it carries; two things are left to
 * the fragment because they vary continuously and the mesh is coarse:
 *
 *   RADIAL — a Gaussian across the beam's width with a smoothstep cutoff at its edge. The slices
 *   are only two dozen thin quads, so without this the beam's edge is a staircase.
 *
 *   LONGITUDINAL — geometric dilution along the outgoing run, `1 / (1 + rate·travel)^power` over a
 *   travel normalized 0 at the glass to 1 at the wall. At the reference's 3.8 / 3.7 that is a
 *   roughly 280× falloff across the frame, and it is most of why the fan reads as light spreading
 *   out rather than as a painted stripe. A plain exponential was tried there and rejected: it
 *   introduces a second abrupt fade near the wall, where this leaves a soft tail.
 *
 * Adapted from Vercel's vgpu (MIT) — see THIRD-PARTY-NOTICES.md.
 */
/** A straight copy, used to move a blurred scratch target into one mip of the environment. */
export const BLIT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  varying vec2 vUvIn;
  void main(){ gl_FragColor = texture2D(tSrc, vUvIn); }`;

/** Rasterize the analytic room into the equirectangular layout the pyramid is built on. */
export const ENV_BAKE_FRAG = /* glsl */ `
  precision highp float;
  ${GLASS_CHUNK}
  ${ENV_CHUNK}
  varying vec2 vUvIn;
  void main(){
    gl_FragColor = vec4(studio(directionFromEquirect(vUvIn)), 1.0);
  }`;

/**
 * One axis of the blur that builds the chain, with the equirect distortion compensated.
 *
 * A row near a pole covers far less solid angle than one at the equator, so a blur of constant
 * texel width is a blur of wildly varying ANGLE — the poles smear into streaks while the middle
 * barely moves. Dividing the horizontal step by sin(theta) makes the kernel angular instead, which
 * is the only version of it that means anything on a sphere. The vertical pass needs no such
 * correction, and applying it there would pull the poles apart instead.
 */
export const ENV_BLUR_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform vec2 uDir;
  uniform float uRadius;
  uniform float uCompensate;
  varying vec2 vUvIn;

  const float ENV_PI = 3.141592653589793;

  void main(){
    float sinTheta = max(sin(vUvIn.y * ENV_PI), 0.15);
    float scale = mix(1.0, 1.0 / sinTheta, uCompensate);
    vec2 step = uDir * uTexel * uRadius * scale;
    // The five-tap bilinear-paired Gaussian: three fetches per side reconstruct nine taps.
    float offsets[3];
    float weights[3];
    offsets[0] = 0.0;         weights[0] = 0.2270270270;
    offsets[1] = 1.3846153846; weights[1] = 0.3162162162;
    offsets[2] = 3.2307692308; weights[2] = 0.0702702703;
    vec4 sum = texture2D(tSrc, vUvIn) * weights[0];
    for (int i = 1; i < 3; i++){
      sum += texture2D(tSrc, vUvIn + step * offsets[i]) * weights[i];
      sum += texture2D(tSrc, vUvIn - step * offsets[i]) * weights[i];
    }
    gl_FragColor = sum;
  }`;

export const BEAM_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aProfile;     // -1..1 across the beam
  attribute float aTravel;      // 0 at the glass, 1 at the wall
  attribute float aWavelength;  // nm, or -1 for the white input
  varying vec3 vCol;
  varying float vProfile;
  varying float vTravel;
  varying float vWave;
  varying vec2 vWorld;
  void main(){
    vCol = aColor;
    vProfile = aProfile;
    vTravel = aTravel;
    vWave = aWavelength;
    vWorld = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/**
 * The caustic: the SAME light mesh drawn a second time, as light landing on the wall.
 *
 * Adapted from the reference's caustic.wgsl. Three things make it read as a surface being lit
 * rather than as a second copy of the beam:
 *
 *   SATURATING. `1 - exp(-energy·strength)` instead of a straight add, so the wash approaches full
 *   coverage and never blows out however much energy arrives.
 *
 *   IT OUTLIVES THE BEAM. Its falloff scales are 0.12 on the rate and 0.5 on the power, so where
 *   the beam's own glow has died the caustic is still going — which is exactly the relationship
 *   between a light and the wall it lights.
 *
 *   IT GOES NEUTRAL WITH DISTANCE. Saturated spectrum near the glass, washing toward a pale glow
 *   far away, because a real caustic loses its separation as it spreads.
 *
 * Drawn at the same depth as the beam, deliberately: the reference notes that putting exterior
 * rays on the wall and interior rays inside the glass makes the shared entry and exit vertices
 * project to different pixels under perspective, and the mesh tears.
 */
export const CAUSTIC_FRAG = /* glsl */ `
  precision highp float;
  uniform float uEdgeFalloff, uFalloffRate, uFalloffPower;
  uniform float uStrength, uCoverage, uFarDesat, uFarBright, uTravelScale;
  uniform float uRateScale, uPowerScale, uNormalInfluence, uNormalElevation;
  uniform float uWallScale, uWallNormal;
  uniform vec2  uBeamDir;
  varying vec3 vCol;
  varying float vProfile;
  varying float vTravel;
  varying float vWave;
  varying vec2 vWorld;

  float hash12c(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise2(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12c(i), hash12c(i + vec2(1.0, 0.0)), u.x),
               mix(hash12c(i + vec2(0.0, 1.0)), hash12c(i + vec2(1.0)), u.x), u.y);
  }

  void main(){
    float r = abs(vProfile);
    float radial = exp(-uEdgeFalloff * r * r) * (1.0 - smoothstep(0.55, 1.0, r));
    float distance = clamp(vTravel / max(uTravelScale, 0.001), 0.0, 1.0);
    float outgoing = 1.0 / pow(
      1.0 + max(uFalloffRate, 0.0) * max(uRateScale, 0.0) * max(vTravel, 0.0),
      max(uFalloffPower * max(uPowerScale, 0.0), 0.0001));

    // The wall's own relief modulates what lands on it — ridges facing the beam catch more. The
    // reference reads this from its baked normal map; the same value-noise field the wall mode
    // uses stands in, so the two agree about where the plaster is high.
    float e = 0.02;
    float m0 = noise2(vWorld * uWallScale * 3.7);
    float mx = noise2((vWorld + vec2(e, 0.0)) * uWallScale * 3.7);
    float my = noise2((vWorld + vec2(0.0, e)) * uWallScale * 3.7);
    vec3 N = normalize(vec3((m0 - mx) * uWallNormal, (m0 - my) * uWallNormal, 1.0));
    float elev = clamp(uNormalElevation, 1.0, 89.0) * 0.01745329252;
    vec3 incident = normalize(vec3(normalize(uBeamDir) * cos(elev), sin(elev)));
    float flat0 = max(incident.z, 0.05);
    float relative = clamp(max(dot(N, incident), 0.0) / flat0, 0.0, 2.5);
    float surface = mix(1.0, relative, clamp(uNormalInfluence, 0.0, 1.0));

    float energy = max(max(vCol.r, max(vCol.g, vCol.b)), 0.0) * radial * outgoing;
    float bounded = 1.0 - exp(-energy * max(uStrength, 0.0));
    float farMix = smoothstep(0.16, 0.92, distance) * uFarDesat;
    vec3 spectral = vCol;
    vec3 neutral = vec3(max(max(spectral.r, spectral.g), spectral.b) + uFarBright * distance);
    vec3 tint = clamp(mix(spectral, neutral, farMix) * (0.62 + bounded * 0.68), 0.0, 1.45);
    float coverage = clamp(bounded * uCoverage, 0.0, 1.0);
    // The wall is already shaded; emit premultiplied radiance at ZERO alpha into an additive draw
    // so no wavelength can darken the surface underneath.
    gl_FragColor = vec4(tint * coverage * surface * step(0.0, vWave), 0.0);
  }`;

export const BEAM_FRAG = /* glsl */ `
  precision highp float;
  uniform float uIntensity, uEdgeFalloff, uFalloffRate, uFalloffPower, uReveal;
  varying vec3 vCol;
  varying float vProfile;
  varying float vTravel;

  /**
   * Open the bundle from its CENTRE LINE outward — adapted from the reference's beam-reveal.wgsl.
   *
   * A beam that fades up in brightness reads as a lamp being turned on; one that opens from the
   * middle reads as a beam arriving, which is what this scene is about. The two branches are what
   * keep it honest at the ends: at zero the mask is exactly zero rather than a residual hairline
   * down the axis, and at one it is exactly one rather than a smoothstep that never quite closes.
   *
   * The feather has a FLOOR because the outgoing fan carries one flat profile per slice, so
   * fwidth is zero across a cell's interior and adjacent slices would step against each other.
   */
  float widthReveal(float profile){
    if (uReveal <= 0.0) return 0.0;
    if (uReveal >= 1.0) return 1.0;
    float antialias = max(fwidth(profile) * 1.5, 0.04);
    return 1.0 - smoothstep(max(uReveal - antialias, 0.0), min(uReveal + antialias, 1.0),
                            abs(profile));
  }

  void main(){
    float r = abs(vProfile);
    float radial = exp(-uEdgeFalloff * r * r) * (1.0 - smoothstep(0.55, 1.0, r))
                 * widthReveal(vProfile);
    float longitudinal = 1.0 / pow(1.0 + max(uFalloffRate, 0.0) * max(vTravel, 0.0),
                                   max(uFalloffPower, 0.0001));
    // Alpha is ZERO. An additive layer must not add coverage, or the post pass's un-premultiply
    // darkens exactly the pixels it was meant to brighten. The reference writes 0 here too.
    gl_FragColor = vec4(vCol * radial * longitudinal * uIntensity, 0.0);
  }`;

/**
 * Multi-scale bloom, adapted from Vercel's vgpu (MIT) — see THIRD-PARTY-NOTICES.md.
 *
 * The post pass's own bloom is a golden-angle gather at ONE radius, taken in the same loop as the
 * depth of field. That is cheap and it is enough for a pale studio where the bloom is a bit of
 * glow around a saturated core. It cannot represent a light source: a real halo spans several
 * octaves at once — a tight core, a mid falloff and a very broad wash — and a single-radius gather
 * has to pick one of those and lose the others.
 *
 * This is the standard answer: threshold the highlights, build a half-resolution pyramid, blur
 * each level separably, then recombine. Wider kernels are nearly free on the smaller levels, which
 * is what buys the broad wash. Four levels; the widest is reserved for lighting dust motes rather
 * than being composited as visible glow.
 */
export const BLOOM_EXTRACT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform float uThreshold;
  uniform vec2 uTexel;
  varying vec2 vUvIn;
  void main(){
    // Box-filtered, because this step is ALSO a downsample: the source is the full-resolution
    // frame and the target is already half of it. Reading a single texel here discards three
    // quarters of the frame before the pyramid even starts, and a thin diagonal highlight arrives
    // at level 0 as a staircase that every level below then blurs back over the picture.
    vec2 o = uTexel * 0.5;
    vec3 c = max(
      (texture2D(tSrc, vUvIn + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUvIn + vec2(o.x, -o.y)).rgb
       + texture2D(tSrc, vUvIn + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUvIn + vec2(o.x, o.y)).rgb)
        * 0.25,
      vec3(0.0));
    float b = max(max(c.r, c.g), c.b);
    float t = max(uThreshold, 0.0);
    // A soft knee rather than a hard cut. A step at the threshold makes the bloom's edge track a
    // contour of the image, which reads as a bright outline drawn around things.
    float knee = max(t * 0.5, 0.0001);
    float soft = clamp(b - t + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 0.0001);
    gl_FragColor = vec4(c * (max(b - t, soft) / max(b, 0.0001)), 1.0);
  }`;

export const BLOOM_BLUR_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform vec2 uDir;       // (1,0) or (0,1)
  uniform vec2 uTexel;
  uniform float uSigma;
  varying vec2 vUvIn;

  void main(){
    // Coefficients are evaluated inline rather than uploaded: a Gaussian is two multiplies and an
    // exp, and at these tap counts that costs less than the uniform array the reference needs to
    // work around WGSL's lack of dynamic indexing.
    //
    // Taps are read in PAIRS, which is the reference's bloom-blur-paired trick and is exact rather
    // than an approximation. A sample placed between texels i and i+1 comes back from a linear
    // sampler as (1-f)·T(i) + f·T(i+1); choosing f = w(i+1)/(w(i)+w(i+1)) makes that precisely the
    // two weighted taps the loop would otherwise have fetched separately. The eighteen-tap level
    // goes from thirty-five fetches to nineteen for a bit-identical result — the sampler does the
    // arithmetic either way, and it does it for free.
    //
    // It relies on the source being LINEAR filtered and on the offsets being in texel units from a
    // texel centre. Both hold for the pyramid; a nearest-filtered source would silently snap every
    // pair to one of its two taps and narrow the kernel.
    float total = 1.0;
    vec3 acc = texture2D(tSrc, vUvIn).rgb;
    for (int i = 1; i < BLOOM_TAPS; i += 2){
      float a = float(i);
      float b = float(i + 1);
      float wa = exp(-0.5 * a * a / (uSigma * uSigma));
      // The last pair is a lone tap when the count is even; its partner weighs nothing.
      float wb = i + 1 < BLOOM_TAPS ? exp(-0.5 * b * b / (uSigma * uSigma)) : 0.0;
      float w = wa + wb;
      vec2 off = uDir * uTexel * ((a * wa + b * wb) / w);
      acc += (texture2D(tSrc, vUvIn + off).rgb + texture2D(tSrc, vUvIn - off).rgb) * w;
      total += 2.0 * w;
    }
    gl_FragColor = vec4(max(acc / total, vec3(0.0)), 1.0);
  }`;

/**
 * Halve the resolution with a 4-tap box, which is the only correct way down a pyramid.
 *
 * Point-sampling instead — reading one texel of the level above — throws away three quarters of
 * the signal, and on anything thin and diagonal that is catastrophic: the beam becomes a staircase
 * at half resolution, and every level below inherits and blurs those blocks back over the frame as
 * hatching and fog around it. The artefact appears NEXT to the bright thing, not on it, which is
 * what makes it read as atmosphere rather than as aliasing.
 */
export const BLOOM_DOWN_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUvIn;
  void main(){
    vec2 o = uTexel * 0.5;
    vec3 c = texture2D(tSrc, vUvIn + vec2(-o.x, -o.y)).rgb
           + texture2D(tSrc, vUvIn + vec2( o.x, -o.y)).rgb
           + texture2D(tSrc, vUvIn + vec2(-o.x,  o.y)).rgb
           + texture2D(tSrc, vUvIn + vec2( o.x,  o.y)).rgb;
    gl_FragColor = vec4(max(c * 0.25, vec3(0.0)), 1.0);
  }`;

/**
 * The particle light field, built straight from the HDR scene — adapted from the reference's
 * particle-light-downsample.wgsl.
 *
 * An 8x8 area filter reducing all the way to a sixteenth in ONE step, rather than chaining four
 * box downsamples. Chaining is cheaper but it walks over the intermediate levels, and those hold
 * the thresholded bloom the composite still needs. Reducing in one step leaves them alone.
 *
 * Deliberately UNTHRESHOLDED: this is what a grain of dust sees, and dust is lit by all the light
 * in the room, not only by the part bright enough to bloom.
 */
export const PARTICLE_DOWN_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;   // 1 / source size
  uniform vec2 uScale;   // source size / target size
  varying vec2 vUvIn;

  /**
   * Display to linear, ON THE DISPLAY RANGE ONLY.
   *
   * The curve is defined on [0,1] and this target is HDR: the beam sits in the hundreds. Feeding
   * that to the transfer function is not an approximation, it is a different function — 500 comes
   * back as 2.6 million — and the wide blur below then spreads a number that size over the entire
   * frame, so every grain in it saturates the response and the field lights up everywhere. Above
   * one the value is already radiance and passes through.
   */
  vec3 srgbToLinear3(vec3 c){
    vec3 v = max(c, vec3(0.0));
    vec3 clamped = min(v, vec3(1.0));
    vec3 lo = mix(clamped / 12.92, pow((clamped + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), clamped));
    return mix(lo, v, step(vec3(1.0), v));
  }

  void main(){
    vec3 c = vec3(0.0);
    for (int y = 0; y < 8; y++){
      for (int x = 0; x < 8; x++){
        vec2 grid = vec2(float(x), float(y)) - vec2(3.5);
        // Decoded per TAP, before the average. This renderer's working space is display-referred —
        // a preset's sRGB hex is used as-is and written out as-is — and the reference's is linear
        // radiance. Its response constant is calibrated against the latter, so the field has to be
        // linearized before that constant means anything. Decoding after the average would be a
        // different filter: sixty-four display values do not average to the display value of their
        // linear mean.
        c += srgbToLinear3(texture2D(tSrc, vUvIn + grid * 0.125 * uScale * uTexel).rgb);
      }
    }
    gl_FragColor = vec4(max(c / 64.0, vec3(0.0)), 1.0);
  }`;

export const BLOOM_COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tL0, tL1, tL2;
  uniform float uRadius;
  varying vec2 vUvIn;
  void main(){
    // Radius moves weight from the near scale to the far one WITHOUT widening any kernel, so the
    // halo grows continuously instead of stepping as taps are added.
    vec3 f = vec3(1.0, 0.8, 0.55);
    float w0 = mix(f.x, f.z, clamp(uRadius, 0.0, 1.0));
    float w1 = f.y;
    float w2 = mix(f.z, f.x, clamp(uRadius, 0.0, 1.0));
    vec3 c = texture2D(tL0, vUvIn).rgb * w0
           + texture2D(tL1, vUvIn).rgb * w1
           + texture2D(tL2, vUvIn).rgb * w2;
    gl_FragColor = vec4(max(c / max(w0 + w1 + w2, 0.0001), vec3(0.0)), 1.0);
  }`;

/**
 * Sparse volumetric dust, adapted from Vercel's vgpu (MIT) — see THIRD-PARTY-NOTICES.md.
 *
 * Every instance is a screen-facing quad whose seed selects one of four progressively rarer
 * populations: mostly just-resolved powder, some readable flakes, rare soft motes and the odd
 * defocused bokeh. Sizes are in PIXELS rather than world units, which is the point — real dust
 * near the lens is enormous and out of focus while dust across the room is a pinprick, and a
 * world-space sphere cannot express both.
 *
 * What makes it read as air rather than as confetti is that dust is only visible where light
 * actually is. Each grain samples the BROADEST bloom level at its own screen position and raises
 * it to a high power, so the field lights up along the beam and in the fan and stays invisible in
 * the dark two thirds of the frame.
 */
export const DUST_VERT = /* glsl */ `
  attribute vec2 aCorner;   // -1..1 across the quad
  attribute float aId;      // per-grain index; every other property is hashed from it
  uniform vec2  uRes;
  uniform float uTime, uSize, uDrift, uPlaneZ, uCamDist;
  uniform vec3  uExtent;
  varying vec2  vCorner;
  varying vec2  vLightUv;
  varying float vSoft;
  varying float vOpacity;
  varying float vSparkle;
  varying vec2  vPrismA, vPrismB, vPrismC;
  uniform vec3  uPrismA, uPrismB, uPrismC;   // cross-section corners, world space

  float hash11(float v){ return fract(sin(v * 127.1) * 43758.5453); }

  /** Screen uv of a world point, for the prism-occlusion test in the fragment. */
  vec2 projectUv(vec3 p){
    vec4 c = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vec2 n = c.xy / max(c.w, 1e-5);
    return vec2(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5);
  }

  /** Diameter in pixels and profile softness for one progressively rarer population. */
  vec2 appearance(float cls, float size){
    if (cls < 0.82) return vec2(mix(1.05, 1.75, size * size), 0.04);
    if (cls < 0.95) return vec2(mix(1.8, 3.8, pow(size, 1.4)), 0.18);
    if (cls < 0.99) return vec2(mix(4.2, 9.0, pow(size, 0.75)), 0.58);
    if (cls < 0.996) return vec2(mix(12.0, 28.0, pow(size, 0.8)), 1.0);
    return vec2(mix(32.0, 72.0, pow(size, 0.8)), 1.0);
  }

  void main(){
    vCorner = aCorner;
    float id = aId + 1.0;

    // A LIFECYCLE, not a wrap. When a grain's time is up a new one is spawned somewhere else
    // entirely; the position only ever changes at the zero-opacity seam between cycles, so nothing
    // is seen to teleport. A wrapping field, by contrast, marches every grain along the same axis
    // and reads as drifting snow.
    float seedLife = hash11(id * 19.127 + 71.0);
    float seedPhase = hash11(id * 23.417 + 83.0);
    float lifeDuration = mix(1.0, 7.0, seedLife);
    float lifeClock = uTime * uDrift + seedPhase * lifeDuration;
    float generation = floor(lifeClock / lifeDuration);
    float lifePhase = fract(lifeClock / lifeDuration);

    float spawn = id * 7.919 + generation * 131.7;
    float sx = hash11(spawn + 1.3), sy = hash11(spawn + 5.7), sz = hash11(spawn + 11.1);
    float sDepth = hash11(spawn + 17.9);
    float seedSize = hash11(id * 7.731 + 31.0);
    float seedClass = hash11(id * 9.173 + 37.0);
    float seedEnergy = hash11(id * 11.917 + 43.0);
    float seedShape = hash11(id * 13.531 + 47.0);
    float seedAngle = hash11(id * 17.273 + 59.0);

    // A TRIANGULAR depth distribution — the sum of two uniforms — concentrates most motes on the
    // light sheet's own plane. The remaining spread still reads as volume without the violent
    // parallax of grains sitting right against the lens.
    float z = uPlaneZ + (sz + sDepth - 1.0) * uExtent.z;
    vec3 p = vec3((sx * 2.0 - 1.0) * uExtent.x, (sy * 2.0 - 1.0) * uExtent.y, z);
    // The extent describes the far plane, so narrow it toward the camera and every depth slice
    // fills roughly the same frustum instead of throwing most near grains off-screen.
    float depthScale = clamp((uCamDist - p.z) / max(uCamDist, 0.001), 0.08, 1.0);
    p.xy *= depthScale;
    p += vec3(
      sin(uTime * mix(0.09, 0.17, sy) + sz * 6.2831853) * mix(0.008, 0.035, seedSize),
      sin(uTime * mix(0.07, 0.14, sz) + sx * 6.2831853) * mix(0.01, 0.04, sy),
      sin(uTime * mix(0.05, 0.10, sx) + sy * 6.2831853) * mix(0.006, 0.025, sz)) * uExtent.x;

    vec4 clip = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vec2 ndc = clip.xy / max(clip.w, 1e-5);
    // Anchor the billboard on a physical pixel centre. A one-pixel mote may then MOVE between
    // pixels but can never sit between two and swap its raster coverage every frame, which is what
    // makes a fine dust field crawl and sparkle when it should be still.
    vec2 uv = vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    vec2 snapped = (floor(uv * max(uRes, vec2(1.0))) + 0.5) / max(uRes, vec2(1.0));
    // FLIPPED for the sampler. The reference is WGSL, where a screen uv and a texture uv share an
    // origin at the top left; GLSL's texture2D has it at the bottom left. Handing a top-down uv
    // straight to the sampler reads the light field mirrored about the horizontal midline, so
    // grains light up in the reflection of the beam rather than on it — and the frame's dark half
    // fills with specks while the bright half is bare.
    vLightUv = vec2(snapped.x, 1.0 - snapped.y);
    ndc = vec2(snapped.x * 2.0 - 1.0, 1.0 - snapped.y * 2.0);

    vec2 look = appearance(seedClass, seedSize);
    vSoft = look.y;
    float radius = look.x * 0.5 * uSize;

    // Powder is not made of perfect discs: small flakes get mild anisotropy at an arbitrary angle,
    // while a large defocused bokeh stays circular because that is a lens footprint, not a grain.
    float aspect = mix(mix(0.68, 1.32, seedShape), 1.0, look.y);
    float a = seedAngle * 6.2831853;
    vec2 ax = vec2(cos(a), sin(a));
    vec2 ay = vec2(-ax.y, ax.x);
    vec2 shaped = ax * aCorner.x * aspect + ay * aCorner.y / max(aspect, 0.001);

    // Every larger mote is dimmer than an equivalently lit smaller one, continuously — with a
    // floor, so sub-pixel grains cannot blink out entirely.
    float opacity = min(1.0, pow(1.5 / max(look.x, 1.5), 0.9));
    float energy = 0.3 + 1.1 * pow(seedEnergy, 3.0);
    float twinkleAmount = mix(0.015, 0.06, look.y);
    float twinkle = 1.0 + twinkleAmount * sin(uTime * mix(0.12, 0.28, seedShape) + a);
    vSparkle = opacity * energy * twinkle;
    // Fade in and out across the life, so a respawn happens at zero and is never seen. A PLATEAU
    // rather than a hump: two slow smoothsteps hold full brightness across most of the life, so
    // dust materialises and dissolves. A sine over the whole cycle peaks only at the midpoint and
    // makes the entire field breathe in and out at once.
    float fadeFraction = mix(0.14, 0.24, seedShape);
    vOpacity = smoothstep(0.0, fadeFraction, lifePhase)
             * (1.0 - smoothstep(1.0 - fadeFraction, 1.0, lifePhase));

    vPrismA = projectUv(uPrismA);
    vPrismB = projectUv(uPrismB);
    vPrismC = projectUv(uPrismC);
    clip.xy = ndc * clip.w + shaped * radius * 2.0 / max(uRes, vec2(1.0)) * clip.w;
    gl_Position = clip;
  }`;

export const DUST_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tLight, tColor;
  uniform float uIntensity, uResponse, uFalloffPower, uExposure;
  uniform vec2 uRes;
  varying vec2 vCorner;
  varying vec2 vLightUv;
  varying float vSoft;
  varying float vOpacity;
  varying float vSparkle;
  varying vec2 vPrismA, vPrismB, vPrismC;

  float edgeSide(vec2 a, vec2 b, vec2 p){
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  }

  bool insideTriangle(vec2 p, vec2 a, vec2 b, vec2 c){
    float s0 = edgeSide(a, b, p);
    float s1 = edgeSide(b, c, p);
    float s2 = edgeSide(c, a, p);
    bool neg = s0 < 0.0 || s1 < 0.0 || s2 < 0.0;
    bool pos = s0 > 0.0 || s1 > 0.0 || s2 > 0.0;
    return !(neg && pos);
  }

  vec3 tonemapAces(vec3 v){
    vec3 c = max(v, vec3(0.0));
    c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
    return clamp(c, 0.0, 1.0);
  }

  vec3 linearToSrgb3(vec3 c){
    vec3 v = max(c, vec3(0.0));
    return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
  }

  vec3 srgbToLinear3(vec3 c){
    vec3 v = max(c, vec3(0.0));
    return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v));
  }

  void main(){
    float r2 = dot(vCorner, vCorner);
    if (r2 > 1.0) discard;

    // Dust does not draw over the glass, and the test is per-FRAGMENT rather than per-grain: a
    // large defocused bokeh straddling the silhouette has to be clipped along the edge, not kept
    // or dropped whole on where its centre happens to land.
    vec2 frag = vec2(gl_FragCoord.x, max(uRes.y, 1.0) - gl_FragCoord.y) / max(uRes, vec2(1.0));
    if (insideTriangle(frag, vPrismA, vPrismB, vPrismC)) discard;

    vec3 colorLight = srgbToLinear3(max(texture2D(tColor, vLightUv).rgb, vec3(0.0)));
    vec3 light = max(texture2D(tLight, vLightUv).rgb, vec3(0.0));
    float brightness = max(max(light.r, light.g), light.b);
    if (light.r == 0.0 && light.g == 0.0 && light.b == 0.0) discard;

    // No THRESHOLD: a saturating response, so weak blurred samples fade off continuously instead
    // of drawing a hard particle halo at the edge of the light volume.
    float lightResponse = 1.0 - exp(-brightness * uResponse);
    float illumination = pow(clamp(lightResponse, 0.0, 1.0), uFalloffPower);

    // Core plus halo, not a single taper: a grain has a tight centre and a faint surround, and
    // softness widens the core rather than just blurring the edge.
    float edgeFade = 1.0 - smoothstep(0.62, 1.0, r2);
    float core = exp(-r2 * mix(6.5, 1.8, vSoft));
    float halo = exp(-r2 * 1.25) * vSoft * 0.2;
    float radial = (core + halo) * edgeFade;

    // Hue comes from the bloom, not from the light field. The field is a heavy sixteenth-res blur
    // used only to decide how much light reaches a grain; taking colour from it too smears a
    // mote's tint across everything nearby, so a speck beside the red end of the fan comes out
    // pink. It falls back to the field only where the bloom is empty.
    float colorBrightness = max(max(colorLight.r, colorLight.g), colorLight.b);
    vec3 hueSource = colorBrightness > 1e-7 ? colorLight : light;
    float hueBrightness = max(max(hueSource.r, hueSource.g), hueSource.b);
    vec3 lightColor = linearToSrgb3(clamp(hueSource / max(hueBrightness, 1e-6), 0.0, 1.0));

    // Tone mapped IN ISOLATION and encoded here, because this draws over the finished frame. A
    // grain is a point of light in its own right, not part of the scene beneath it: mapping the
    // sum instead would crush every mote sitting on the beam, which is exactly where they are
    // brightest and most worth seeing.
    float energy = illumination * radial * vSparkle * uExposure * uIntensity;
    float displayEnergy = linearToSrgb3(tonemapAces(vec3(energy))).r;

    // Alpha stays ZERO — an additive layer must not add coverage, or a premultiplied compositor
    // darkens exactly the pixels it was meant to brighten.
    gl_FragColor = vec4(lightColor * displayEnergy * vOpacity, 0.0);
  }`;

/**
 * The prism's INNER interface, adapted from the reference's glass-back.wgsl.
 *
 * Their glass is two passes and this is the one that gives a solid an interior. It draws the
 * BACK-facing triangles and, for each fragment, follows the camera ray on into the glass — through
 * however many total internal reflections it takes — until it escapes, then samples the studio
 * along that exit direction. It never reads the scene: its job is to put reflected room light
 * INSIDE the body, so the far faces return light back through the near ones.
 *
 * Drawn into the PLATE, because the plate is what the main pass's glass refracts. That is the same
 * ordering the reference relies on: the front interface refracts the resolved back interface.
 */
export const BACKGLASS_VERT = /* glsl */ `
  varying vec3 vWp;
  varying vec3 vNp;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWp = wp.xyz;
    vNp = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

export const BACKGLASS_FRAG = /* glsl */ `
  precision highp float;
  ${GLASS_CHUNK}
  ${ENV_CHUNK}
  ${ENV_LOOKUP}
  uniform float uIOR, uBackStrength, uPlateDepth;
  varying vec3 vWp;
  varying vec3 vNp;

  float dielectricFresnel(float f0, float facing){
    float m = 1.0 - clamp(facing, 0.0, 1.0);
    float m2 = m * m;
    return f0 + (1.0 - f0) * m2 * m2 * m;
  }

  void main(){
    vec3 V = normalize(cameraPosition - vWp);
    vec3 incident = -V;
    // The camera ray reaches a back face from INSIDE the solid, having already crossed the front.
    // The face's outward normal is therefore the one it is leaving through.
    vec3 outward = normalize(vNp);
    float f0 = pow((uIOR - 1.0) / (uIOR + 1.0), 2.0);

    // Evaluate the event AT this surface. Marching outward from here first — looking for a "next"
    // surface — is meaningless for a convex solid: the ray is already on the boundary heading out,
    // so the search finds some far plane and reports a path through empty space. Which plane it
    // finds changes by region, and that partition is precisely the wedges it drew.
    float facing = clamp(dot(-incident, outward), 0.0, 1.0);
    float fresnel = dielectricFresnel(f0, facing);

    // The transmitted branch is the see-through, and the plate below already carries it. What this
    // pass contributes is the part that REFLECTS back into the glass — follow that until it gets
    // out, and whatever room it then sees is what this fragment shows.
    vec3 dir = normalize(reflect(incident, outward));
    vec3 pos = vWp;
    float escaped = 0.0;
    vec3 lastN = outward;

    for (int b = 0; b < 4; b++){
      vec3 faceN;
      float t = prismExitN(pos + dir * 2e-4, dir, faceN);
      if (t <= 0.0) break;
      pos = pos + dir * (t + 2e-4);
      lastN = faceN;
      vec3 refracted = refract(dir, -faceN, uIOR);
      if (dot(refracted, refracted) > 1e-6){
        dir = normalize(refracted);
        escaped = 1.0;
        break;
      }
      dir = reflect(dir, faceN);
    }

    // A reflection still trapped inside shows nothing: only light that made it back out to the
    // room can be what this fragment is displaying.
    float exitFacing = clamp(dot(dir, lastN), 0.0, 1.0);
    float transmission = escaped > 0.5 ? (1.0 - dielectricFresnel(f0, exitFacing)) : 0.0;
    // Through the same cone lookup the front interface uses. Mirror-smooth, so the cone is zero
    // and the level comes entirely from the screen footprint — which is what stops the room
    // aliasing where a face turns away and compresses it into a handful of pixels.
    vec3 env = studioCone(dir, 0.0) * uBackStrength * fresnel * transmission;

    gl_FragColor = vec4(env, uPlateDepth);
  }`;
