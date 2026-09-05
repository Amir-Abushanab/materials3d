/**
 * A beam of white light, refracted through a shape and dispersed into a spectrum.
 *
 * The rest of this renderer bends a *plate*, colour that already exists behind the glass, sampled
 * in screen space and offset by the surface normal. That model cannot produce this effect. A prism
 * beam is not a distortion of something behind the glass; it is a ray with its own geometry, whose
 * exit angle differs per wavelength, and which keeps travelling through empty space after it
 * leaves the glass. There is nothing behind it to sample.
 *
 * So the beam is traced rather than sampled. Everything here is 2D: the sheet is planar, the
 * cross-section it traces against is a polygon in that plane, and the result is lifted into 3D
 * only when the vertex buffer is written.
 *
 * ---
 *
 * The optics, colorimetry and mesh topology here are **derived from Vercel's `vgpu` prism
 * background** (MIT, see THIRD-PARTY-NOTICES.md). Four ideas came from that source, and each one
 * is the difference between a picture that reads as light and one that reads as coloured bands:
 *
 *   1. FRESNEL. Transmission at each boundary is the real Fresnel average of both polarizations,
 *      accumulated at entry and exit and folded into vertex intensity. A beam approaching the
 *      critical angle then dims into total internal reflection instead of vanishing abruptly,
 *      which matters enormously once the beam is allowed to move.
 *   2. COLORIMETRY. Wavelength becomes colour through the CIE 1931 matching functions, weighted by
 *      the D65 daylight spectrum and the eye's photopic response. Green is inherently brighter
 *      than violet, exactly as in a real spectrum. A naive hue ramp gives every wavelength the
 *      same peak energy and reads as a flat cartoon rainbow.
 *   3. TOPOLOGY. The outgoing fan is a CONNECTED sheet spanning adjacent wavelengths, not N
 *      independent overlapping ribbons, so colour interpolates in the rasterizer and cannot band.
 *   4. DENSITY. Vertex brightness is flux divided by the angular spread between neighbouring
 *      wavelengths, a Jacobian. Where the fan compresses it brightens; where it spreads it dims,
 *      and the total is invariant under subdivision. This is what gives a spectrum its
 *      characteristic bright core and soft ends.
 */
import * as THREE from "three";
import type { ShapeKind } from "../config/model";
import { fitOutline, isConvex, traceableOutline } from "./svgPath";
import { cachedMesh } from "./glb";
import { sliceGeometry } from "./meshSlice";

/** Visible range, in nanometres. */
const LAMBDA_MIN = 400;
const LAMBDA_MAX = 700;

/** Keeps a ray from immediately re-hitting the surface it just left. */
const SURFACE_EPS = 1e-4;

/** Internal reflections to follow before the solver gives up on a ray. */
const MAX_BOUNCES = 3;

/** The collimated source is emissive HDR rather than painted white, so it blooms like a source. */
const INPUT_BEAM_RADIANCE = 6;

export interface BeamOptions {
  /** Cross-section the beam refracts through, as a convex polygon in the sheet plane. */
  polygon: THREE.Vector2[];
  /**
   * Further solids the beam may cross AFTER the first, each with its own base index.
   *
   * The order is found by the tracer, not given here: whichever the ray reaches next is the one it
   * enters. Absent or empty, the beam behaves exactly as it always has.
   */
  extraSolids?: { polygon: THREE.Vector2[]; ior: number }[];
  /** Centre of the beam at its source. See {@link aimBeam}, which derives this. */
  origin: THREE.Vector2;
  /** Direction of travel. Normalized internally. */
  direction: THREE.Vector2;
  /** Half-width of the collimated beam, in world units. */
  halfWidth: number;
  /** The plane the sheet lives on. */
  z: number;
  /** Cauchy base index. See {@link iorAt}. */
  ior: number;
  /** Cauchy strength term, how far the fan spreads. */
  dispersion: number;
  /** Wavelength vertices across the visible range. */
  samples: number;
  /** Additive sheets integrating the finite width of the beam. */
  slices: number;
  /**
   * Half-extents of the WALL the beam lands on, in world units.
   *
   * Rays terminate here rather than after a fixed distance, and that is not bookkeeping: it is
   * what makes the fan a thing that arrives somewhere. The spectral density divides flux by the
   * spread it occupies, so the exposure that balances the picture is a function of how far the
   * light travels before it stops, which is why the reference's `PRISM_LIGHT_EXPOSURE` only makes
   * sense against a wall of a particular size.
   */
  wallHalfExtent: THREE.Vector2;
  /** Display exposure for the spectral integral the mesh represents. */
  exposure: number;
  /** Gaussian tightness across the beam's width. Higher is a harder-edged beam. */
  edgeFalloff: number;
}

export interface LightSheet {
  geometry: THREE.BufferGeometry;
  stats: {
    samples: number;
    slices: number;
    /** Wavelengths that reached the glass and produced a drawable path. */
    validBands: number;
    /** Strips dropped because the beam's two edges disagreed, see {@link matchingTopology}. */
    rejectedTopology: number;
    quads: number;
    /** First vertex of the outgoing fan. The mesh is written white → internal → fan, so this is
     *  the boundary that lets a caller reason about the fan alone. */
    fanFirstVertex: number;
  };
}

// ------------------------------------------------------------------ colour --

/**
 * Analytic approximations of the CIE 1931 colour matching functions.
 * Wyman, Sloan and Shirley, JCGT 2013, via vgpu (MIT).
 */
function cieX(nm: number): number {
  const t1 = (nm - 442) * (nm < 442 ? 0.0624 : 0.0374);
  const t2 = (nm - 599.8) * (nm < 599.8 ? 0.0264 : 0.0323);
  const t3 = (nm - 501.1) * (nm < 501.1 ? 0.049 : 0.0382);
  return (
    0.362 * Math.exp(-0.5 * t1 * t1) +
    1.056 * Math.exp(-0.5 * t2 * t2) -
    0.065 * Math.exp(-0.5 * t3 * t3)
  );
}

function cieY(nm: number): number {
  const t1 = (nm - 568.8) * (nm < 568.8 ? 0.0213 : 0.0247);
  const t2 = (nm - 530.9) * (nm < 530.9 ? 0.0613 : 0.0322);
  return 0.821 * Math.exp(-0.5 * t1 * t1) + 0.286 * Math.exp(-0.5 * t2 * t2);
}

function cieZ(nm: number): number {
  const t1 = (nm - 437) * (nm < 437 ? 0.0845 : 0.0278);
  const t2 = (nm - 459) * (nm < 459 ? 0.0385 : 0.0725);
  return 1.217 * Math.exp(-0.5 * t1 * t1) + 0.681 * Math.exp(-0.5 * t2 * t2);
}

/** CIE standard illuminant D65 at 10nm intervals, 400–700nm. Source: CIE.DS.hjfjmt59. */
const D65 = [
  82.7549, 91.486, 93.4318, 86.6823, 104.865, 117.008, 117.812, 114.861, 115.923, 108.811, 109.354,
  107.802, 104.79, 107.689, 104.405, 104.046, 100, 96.3342, 95.788, 88.6856, 90.0062, 89.5991,
  87.6987, 83.2886, 83.6992, 80.0268, 80.2146, 82.2778, 78.2842, 69.7213, 71.6091,
];

/** Peak of D65(λ)·ȳ(λ) over 400–700nm. */
const D65_PHOTOPIC_PEAK = 1.0347;
/** One photographic shoulder shared by every wavelength. */
const SPECTRAL_EXPOSURE = 4.5;
/** Global adaptation that makes the gamut-mapped D65 spectrum integrate to white. */
const WHITE_BALANCE = [1.1868, 1, 2.2495] as const;

function d65Power(nm: number): number {
  const coord = Math.min(D65.length - 1, Math.max(0, (nm - LAMBDA_MIN) / 10));
  const lower = Math.min(D65.length - 2, Math.floor(coord));
  const f = coord - lower;
  return (D65[lower] * (1 - f) + D65[lower + 1] * f) / 100;
}

/**
 * Positive linear-sRGB radiance for one wavelength under daylight D65.
 *
 * Monochromatic colours lie outside sRGB, so the matrix product goes negative in a channel for
 * most of the spectrum. Shifting the whole triplet toward the neutral axis is the smallest
 * positive gamut mapping that preserves hue ordering, and it happens BEFORE the shared exposure,
 * which is what makes integrating across the range reconstruct D65 white rather than handing every
 * wavelength the same peak energy.
 *
 * Fresnel is deliberately absent: the tracer folds the real entry and exit losses into each
 * vertex's intensity instead, so they vary along the beam rather than tinting the palette.
 */
export function wavelengthToBeamRgb(nm: number, target = new THREE.Color()): THREE.Color {
  const w = Math.min(LAMBDA_MAX, Math.max(LAMBDA_MIN, nm));
  const x = cieX(w);
  const y = cieY(w);
  const z = cieZ(w);
  const linear = [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
  const neutral = Math.min(0, ...linear);
  const positive = linear.map((c) => c - neutral);
  const huePeak = Math.max(...positive, Number.EPSILON);
  const photopic = (d65Power(w) * y) / D65_PHOTOPIC_PEAK;
  const display =
    (1 - Math.exp(-SPECTRAL_EXPOSURE * photopic)) / (1 - Math.exp(-SPECTRAL_EXPOSURE));
  return target.setRGB(
    (positive[0] / huePeak) * display * WHITE_BALANCE[0],
    (positive[1] / huePeak) * display * WHITE_BALANCE[1],
    (positive[2] / huePeak) * display * WHITE_BALANCE[2],
  );
}

/**
 * The polygon a shape cuts in the beam's plane, or undefined if it cuts nothing the tracer can use.
 *
 * The tracer is shape-agnostic, it refracts against edges, and a circle is a polygon with enough
 * of them, so making a beam follow a sphere needs nothing but the right outline. What it cannot do
 * is guess. Three things have to be read per kind:
 *
 *   `sides` counts FACES on a prism and radial SEGMENTS everywhere else, so the two are read
 *   differently and everything round becomes a smooth ring at the mesh's own segment count. A
 *   lathe with 72 segments is a 72-gon optically as well as visually.
 *
 *   The slice is taken at the lathe's widest section, which is only the sheet's own plane when the
 *   shape is centred on it. A `cone` tapers, so its half-height slice is half its base.
 *
 *   `beamRotation` applies to the lathes and NOT to `path`. It exists to reconcile conventions: a
 *   lathe's cross-section is generated here from scratch, in XZ, and the beam's default rotation is
 *   what puts a vertex at the top to match a `prism` rolled -90° about X. A `path` is drawn in XY
 *   already, the sheet's own plane, so the same rotation would spin the drawn outline away from
 *   where the mesh actually sits. Only the item's own `roll` applies to it.
 *
 * Undefined for the kinds whose slice the tracer cannot make sense of, and returning a circle for
 * them, which is what this used to do for six of eleven kinds, is not a rough approximation but
 * a different solid: a `ring` is an annulus with a hole the light should cross, `slab` and `arrow`
 * are extrusions whose cross-section is their outline rather than anything lathed, and a `blob` is
 * bumpy by construction.
 *
 * Two kinds answer per SHAPE rather than per kind, and they are the two that carry their own
 * geometry. `path` reads the outline someone authored. `model` MEASURES one, by cutting the loaded
 * mesh at the sheet, which is the only way to answer for geometry that has no parameters: see
 * {@link SlicePose} for what that needs and why a lathe never needed it.
 *
 * Neither has to be convex, `clipEntry` scans a re-entrant outline edge by edge, only SIMPLE. A
 * self-crossing contour is refused, and that is the one gate worth keeping: a figure-of-eight has
 * no inside for the tracer's entering-and-leaving bookkeeping to be right about, so it would not
 * look approximate, it would look random.
 */
export function crossSectionFor(
  shape: { kind: ShapeKind; r: number; sides: number; outline?: string; model?: string },
  beamRotation: number,
  roll: number,
  centre?: { x: number; y: number },
  pose?: SlicePose,
): THREE.Vector2[] | undefined {
  const { kind, r, sides } = shape;
  if (kind === "path") {
    const traceable = shape.outline ? traceablePath(shape.outline, r) : undefined;
    return traceable && posePolygon(traceable, roll, centre);
  }
  if (kind === "model") {
    // `roll` and `centre` are ignored here, and that is not an oversight: they are the flattened
    // stand-in a drawn outline needs because it is authored in its own frame, and a pose carries
    // the real thing. Without one there is nothing to cut, so the target is skipped as before.
    return shape.model && pose ? modelSection(shape.model, r, pose) : undefined;
  }
  const segments = Math.max(3, Math.round(sides));
  const radius =
    kind === "prism" ||
    kind === "hex" ||
    kind === "rod" ||
    kind === "disc" ||
    kind === "sphere" ||
    kind === "droplet"
      ? r
      : // Averaged over its height, which is where a sheet through the middle cuts it.
        kind === "cone"
        ? r / 2
        : 0;
  if (radius <= 0) return undefined;
  return prismCrossSection(radius, kind === "hex" ? 6 : segments, beamRotation + roll, centre);
}

/**
 * What cutting a mesh needs and cutting a lathe never did.
 *
 * A lathe's cross-section is the same at every height, so `crossSectionFor` could answer from `r`
 * and `sides` and place it with a roll and a centre. A `path` extrudes along Z, so its slice is
 * likewise constant and the same two numbers place it. A mesh has neither property: the contour
 * changes with where the sheet sits AND with how the item is turned out of the sheet's plane, so
 * the full transform is the only honest input.
 */
export interface SlicePose {
  /** The sheet's world Z: the plane the mesh is cut by. */
  z: number;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

/**
 * The outline of a loaded `.glb` where the sheet cuts it.
 *
 * THE LARGEST CONTOUR ONLY, which is the same bargain `path` strikes when it reads the first
 * subpath and leaves the counters to the renderer. A plane through a pair of glasses returns the
 * frame and both lens openings; the tracer's bookkeeping is a single inside, so handing it three
 * loops would not make it right about the holes, it would make it wrong about the frame. Aim
 * through solid material and the traced path and the drawn solid agree.
 *
 * Undefined when the mesh has not loaded, when the sheet misses it, or when the slice is not
 * simple. The first is temporary and fixes itself on the rebuild the load triggers.
 */
function modelSection(url: string, r: number, pose: SlicePose): THREE.Vector2[] | undefined {
  const key =
    `${url}|${r}|${pose.z}|${pose.position.x},${pose.position.y},${pose.position.z}` +
    `|${pose.rotation.x},${pose.rotation.y},${pose.rotation.z}` +
    `|${pose.scale.x},${pose.scale.y},${pose.scale.z}`;
  if (modelSections.has(key)) {
    const hit = modelSections.get(key);
    modelSections.delete(key);
    modelSections.set(key, hit);
    return hit;
  }
  const entry = cachedMesh(url);
  let traceable: THREE.Vector2[] | undefined;
  if (entry) {
    // The cached mesh is fitted to a unit half-extent, so `r` scales it exactly as `buildShape`
    // does before the item's own scale applies. Same composition, same solid.
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(pose.rotation.x, pose.rotation.y, pose.rotation.z),
      ),
      new THREE.Vector3(pose.scale.x * r, pose.scale.y * r, pose.scale.z * r),
    );
    const [outer] = sliceGeometry(entry.geometry, matrix, pose.z);
    traceable = outer ? traceableOutline(outer, r) : undefined;
  }
  // A mesh still loading is NOT cached as a miss: the rebuild its arrival triggers retraces, and
  // an entry saying "no section" would outlive the reason for it.
  if (entry) {
    modelSections.set(key, traceable);
    if (modelSections.size > TRACEABLE_PATHS_MAX) {
      for (const oldest of modelSections.keys()) {
        modelSections.delete(oldest);
        break;
      }
    }
  }
  return traceable;
}

/** Slices already cut, simplified and checked, keyed by the mesh and the pose that cut it. A
 *  pointer binding retraces on every move and the cut is the expensive half. */
const modelSections = new Map<string, THREE.Vector2[] | undefined>();

/**
 * Drawn outlines already fitted, simplified and checked, keyed by the outline and the radius it
 * was fitted to.
 *
 * A `path` target is read again on every retrace, and a pointer binding retraces on every move.
 * Parsing, tessellating, simplifying and the quadratic simplicity check come to a few milliseconds
 * for a pasted outline, all of it for an answer that cannot change while the string and the radius
 * do not. Kept small and least-recently-used: a scene names a handful of targets, and an editor
 * cycling through outlines should not pin every one it has ever tried.
 */
const traceablePaths = new Map<string, THREE.Vector2[] | undefined>();
const TRACEABLE_PATHS_MAX = 8;

function traceablePath(outline: string, r: number): THREE.Vector2[] | undefined {
  const key = `${r}|${outline}`;
  if (traceablePaths.has(key)) {
    const hit = traceablePaths.get(key);
    // Re-inserted so the map's order is recency, which is what the eviction below reads.
    traceablePaths.delete(key);
    traceablePaths.set(key, hit);
    return hit;
  }
  const [outer] = fitOutline(outline, r);
  const traceable = outer ? traceableOutline(outer, r) : undefined;
  traceablePaths.set(key, traceable);
  if (traceablePaths.size > TRACEABLE_PATHS_MAX) {
    for (const oldest of traceablePaths.keys()) {
      traceablePaths.delete(oldest);
      break;
    }
  }
  return traceable;
}

/** Spin a drawn outline about its own centre and put it where the item stands. `prismCrossSection`
 *  does the same for a generated polygon by construction; this one already has its points. */
function posePolygon(
  polygon: readonly THREE.Vector2[],
  rotation: number,
  centre?: { x: number; y: number },
): THREE.Vector2[] {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const ox = centre?.x ?? 0;
  const oy = centre?.y ?? 0;
  return polygon.map(
    (p) => new THREE.Vector2(ox + p.x * cos - p.y * sin, oy + p.x * sin + p.y * cos),
  );
}

/**
 * Where a beam starts and which way it points, from a BEARING around the outline rather than a
 * face index.
 *
 * A face index is the handle for a faceted solid and means nothing on a round one, and it jumps at
 * every vertex; a bearing walks the outline continuously, which is what lets a pointer sweep the
 * entry point around a sphere as smoothly as along one face of a prism. It is measured about the
 * polygon's own centroid, not the world origin, because a solid stands wherever the scene puts it,
 * and a bearing from anywhere else strikes the wrong face or misses.
 *
 * Incidence is measured from the struck face's normal, exactly as in {@link aimBeam}.
 */
export function aimBeamAtAngle(
  polygon: THREE.Vector2[],
  entryDegrees: number,
  incidenceDegrees: number,
  halfWidth: number,
  distance: number,
): { origin: THREE.Vector2; direction: THREE.Vector2 } {
  const theta = (entryDegrees * Math.PI) / 180;
  const ray = new THREE.Vector2(Math.cos(theta), Math.sin(theta));
  const centre = centroid(polygon);
  const sign = windingSign(polygon);

  // Where the ray from the centroid leaves the outline, and which edge it leaves through. Walking
  // every edge rather than solving for one keeps this correct for a polygon that is not regular.
  let bestT = Infinity;
  let point = centre.clone().add(ray);
  let inward = new THREE.Vector2(-ray.x, -ray.y);
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const edge = b.clone().sub(a);
    const denominator = ray.x * edge.y - ray.y * edge.x;
    if (Math.abs(denominator) < 1e-12) continue;
    const u = ((a.x - centre.x) * edge.y - (a.y - centre.y) * edge.x) / denominator;
    if (u <= 1e-9 || u >= bestT) continue;
    const hit = centre.clone().addScaledVector(ray, u);
    const along = edge.dot(hit.clone().sub(a)) / Math.max(edge.lengthSq(), 1e-12);
    if (along < -1e-6 || along > 1 + 1e-6) continue;
    bestT = u;
    const length = edge.length() || 1;
    inward = new THREE.Vector2((edge.y * sign) / length, (-edge.x * sign) / length).negate();

    // Pulled clear of both corners by the beam's own footprint. An angle can land exactly ON a
    // vertex, 30° is one on a hexagon at this rotation, and a beam striking a corner physically
    // splits between two faces, which the tracer does not model: it follows one of them and the
    // half of the beam that belongs to the other simply goes missing. The footprint along the face
    // grows as 1/cos(incidence), so the clearance has to grow with it.
    const incidenceRadians = (incidenceDegrees * Math.PI) / 180;
    const footprint = halfWidth / Math.max(0.05, Math.abs(Math.cos(incidenceRadians)));
    const margin = Math.min(0.45, footprint / length + 1e-4);
    point = a.clone().addScaledVector(edge, Math.min(1 - margin, Math.max(margin, along)));
  }

  const incidence = (incidenceDegrees * Math.PI) / 180;
  const cos = Math.cos(incidence);
  const sin = Math.sin(incidence);
  const direction = new THREE.Vector2(
    inward.x * cos - inward.y * sin,
    inward.x * sin + inward.y * cos,
  );
  return { origin: point.addScaledVector(direction, -distance), direction };
}

/**
 * Where a beam starts and which way it points, from an angle of incidence and a point of impact.
 *
 * Incidence is measured from the entry face's NORMAL, not from world X, and that is the whole
 * reason this function exists. Angle-from-world couples "how steeply does it hit" to "where does it
 * hit": swing it and the entry point slides off the face, so the usable range collapses to a
 * degree or two. Measured from the normal, the two are independent: the prism never moves, the
 * source swings around it on a fixed radius, and the pointer can drive incidence and impact point
 * on separate axes.
 *
 * Adapted from Vercel's vgpu (MIT), see THIRD-PARTY-NOTICES.md.
 */
export function aimBeam(
  polygon: THREE.Vector2[],
  face: number,
  incidenceDegrees: number,
  entry: number,
  halfWidth: number,
  distance: number,
): { origin: THREE.Vector2; direction: THREE.Vector2 } {
  const a = polygon[face % polygon.length];
  const b = polygon[(face + 1) % polygon.length];
  const edge = b.clone().sub(a);
  const length = edge.length() || 1;

  // The inward normal: a beam travelling along it strikes the face head on, at zero incidence.
  const sign = windingSign(polygon);
  const inward = new THREE.Vector2((edge.y * sign) / length, (-edge.x * sign) / length).negate();
  const incidence = (incidenceDegrees * Math.PI) / 180;
  const cos = Math.cos(incidence);
  const sin = Math.sin(incidence);
  const direction = new THREE.Vector2(
    inward.x * cos - inward.y * sin,
    inward.x * sin + inward.y * cos,
  );

  // Keep BOTH edges of the finite beam on the face even when the pointer reaches the extreme. The
  // footprint along the face grows as 1/cos(incidence), so at oblique angles the aim point has to
  // stay further from the corners than it does head on.
  const margin = Math.min(0.45, halfWidth / (length * Math.max(0.05, Math.abs(cos))) + 1e-4);
  const t = margin + (1 - 2 * margin) * Math.min(1, Math.max(0, entry));
  const point = a.clone().addScaledVector(edge, t);
  return { origin: point.addScaledVector(direction, -distance), direction };
}

// ------------------------------------------------------------------ optics --

/**
 * Cauchy's empirical dispersion law, wavelength in nanometres.
 *
 * This is `base + strength/µm²`, NOT normalized around the middle of the range: `ior` is the index
 * at infinite wavelength, and the real index across the visible band sits well above it. That is
 * the reference implementation's parameterization, kept so its glass presets transfer unchanged,
 * `BEAM_DISPERSION` in `presets.ts` carries matched pairs so nobody has to hold it in their head.
 */
export function iorAt(nm: number, ior: number, dispersion: number): number {
  const um = nm / 1000;
  return ior + dispersion / (um * um);
}

/**
 * Vertex scratch, reused between retraces.
 *
 * The sheet is over three thousand quads at the shipped settings, and each vertex was nine
 * `Array.push` calls into five growing JS arrays, around 170,000 of them per retrace, which is a
 * retrace every frame the pointer moves. Profiling put that push at 14% of the trace and the
 * garbage it made at another 16%, together more than the ray casting it exists to record.
 *
 * Written by index into typed arrays instead, grown on demand and kept: the buffers outlive the
 * call, so a steady pointer sweep allocates nothing here at all. The attributes are `slice`d out
 * at the end, which is the one copy the geometry needs regardless.
 */
const vertexScratch = {
  capacity: 0,
  positions: new Float32Array(0),
  colors: new Float32Array(0),
  profiles: new Float32Array(0),
  travels: new Float32Array(0),
  waves: new Float32Array(0),
};

function ensureVertexCapacity(vertices: number): void {
  if (vertexScratch.capacity >= vertices) return;
  // Doubled, with the part already written carried over, because a sheet's size is only known
  // once it has been traced: a fan cell is one quad for a beam that leaves one solid cleanly and
  // about thirty for one that bounces its way through six, and sizing every retrace for the second
  // holds tens of megabytes open for a mesh that needs a few hundred kilobytes.
  const capacity = Math.max(vertices, vertexScratch.capacity * 2);
  const grow = (old: Float32Array<ArrayBuffer>, width: number): Float32Array<ArrayBuffer> => {
    const next = new Float32Array(capacity * width);
    next.set(old);
    return next;
  };
  vertexScratch.capacity = capacity;
  vertexScratch.positions = grow(vertexScratch.positions, 3);
  vertexScratch.colors = grow(vertexScratch.colors, 3);
  vertexScratch.profiles = grow(vertexScratch.profiles, 1);
  vertexScratch.travels = grow(vertexScratch.travels, 1);
  vertexScratch.waves = grow(vertexScratch.waves, 1);
}

const cross2 = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/**
 * The outline flattened for the tracer, built once per sheet.
 *
 * A retrace runs `samples × (slices + 2)` rays, over three thousand at the shipped settings, and
 * each one walks every edge two to four times. At three edges that is nothing; a sphere is traced
 * as ninety-six, and the same work is then thirty-two times as much. Everything here is loop-
 * invariant and was being recomputed inside it: the winding sign is an O(n) pass that `tracePrism`
 * ran per RAY, and the outward normals are fixed per edge but were normalized per candidate hit.
 *
 * Typed arrays rather than `Vector2[]` for the same reason, the inner loop reads eight numbers
 * per edge, and reading them from flat arrays avoids a pointer chase and a modulo per edge.
 */
export interface PreparedPolygon {
  readonly points: THREE.Vector2[];
  readonly count: number;
  /** Edge start and vector. */
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly ex: Float64Array;
  readonly ey: Float64Array;
  /** Unit normal pointing OUT of the polygon, per edge. */
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  /**
   * Set when the outline is a regular polygon about the origin, which every cross-section built
   * by {@link prismCrossSection} is. It lets a ray find its edge by ANGLE instead of by scanning:
   * the circumcircle is a two-term quadratic, and where it crosses tells you which few edges of
   * the inscribed polygon can possibly be the answer. At seventy-two segments that turns the
   * hottest loop in the renderer from seventy-two half-plane tests into about seven.
   */
  readonly circumradius: number;
  readonly phase: number;
  readonly regular: boolean;
  /** Centre the regularity and the angular window are measured about. */
  readonly cx: number;
  readonly cy: number;
  /**
   * Set when the outline turns the same way at every vertex, which decides WHICH CLIPPER it gets.
   *
   * A convex polygon is the intersection of its edges' half-planes, so Cyrus-Beck finds entry and
   * exit in one pass of dots and divides. A re-entrant one is not, and has to be scanned edge by
   * edge as segments. Both are correct; the first is materially cheaper, and every lathe
   * cross-section in the language is convex, so the fast path is the one almost everything takes.
   */
  readonly convex: boolean;
}

export function preparePolygon(
  poly: THREE.Vector2[],
  /** Off to force the full scan. Exists so the windowed path can be tested against the thing it
   *  is meant to be indistinguishable from; there is no reason to turn it off in a scene. */
  angularLookup = true,
): PreparedPolygon {
  const count = poly.length;
  const ax = new Float64Array(count);
  const ay = new Float64Array(count);
  const ex = new Float64Array(count);
  const ey = new Float64Array(count);
  const nx = new Float64Array(count);
  const ny = new Float64Array(count);
  const sign = windingSign(poly);
  for (let i = 0; i < count; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % count];
    ax[i] = a.x;
    ay[i] = a.y;
    ex[i] = b.x - a.x;
    ey[i] = b.y - a.y;
    // Rotating the edge against the winding points out of the polygon.
    const px = ey[i] * sign;
    const py = -ex[i] * sign;
    const length = Math.hypot(px, py) || 1;
    nx[i] = px / length;
    ny[i] = py / length;
  }
  // Regular means every vertex the same distance from the CENTROID and evenly spaced, which is
  // what makes the angular lookup exact. About the centroid rather than the origin because a scene
  // puts its solids where it likes, and a polygon that is regular about its own centre is still
  // regular after being moved. Checked rather than assumed: the fallback is a full scan, so an
  // outline that fails this is slower but never wrong.
  const { x: cx, y: cy } = centroid(poly);
  const circumradius = count > 0 ? Math.hypot(poly[0].x - cx, poly[0].y - cy) : 0;
  const phase = count > 0 ? Math.atan2(poly[0].y - cy, poly[0].x - cx) : 0;
  const step = (Math.PI * 2) / Math.max(count, 1);
  let regular = angularLookup && count >= 3 && circumradius > 0;
  for (let i = 1; i < count && regular; i++) {
    const wanted = phase + step * i;
    if (Math.abs(Math.hypot(poly[i].x - cx, poly[i].y - cy) - circumradius) > circumradius * 1e-9) {
      regular = false;
    } else if (
      Math.abs(cx + Math.cos(wanted) * circumradius - poly[i].x) > circumradius * 1e-9 ||
      Math.abs(cy + Math.sin(wanted) * circumradius - poly[i].y) > circumradius * 1e-9
    ) {
      regular = false;
    }
  }
  return {
    points: poly,
    count,
    ax,
    ay,
    ex,
    ey,
    nx,
    ny,
    circumradius,
    phase,
    regular,
    cx,
    cy,
    convex: isConvex(poly),
  };
}

/**
 * Where a ray enters and leaves the solid, in ONE pass. Cyrus–Beck clipping.
 *
 * Requires a CONVEX outline, which every cross-section here is: a convex polygon is the
 * intersection of its edges' half-planes, so a ray is inside exactly between the last half-plane
 * it enters and the first it leaves. Testing edges as half-planes rather than as segments drops
 * the per-edge cost to a dot, a divide and a compare, the segment form needs a second divide and
 * two more compares just to ask whether the crossing landed between the endpoints, and a convex
 * outline makes that question redundant.
 *
 * Results go to module scalars rather than an object: this runs two to four times for each of the
 * three thousand rays a retrace casts, and one allocation there is thousands per frame.
 */
const traceNormal = new THREE.Vector2();
const traceFlipped = new THREE.Vector2();
const traceInside = new THREE.Vector2();
const traceOut = new THREE.Vector2();
const traceHeading = new THREE.Vector2();

let clipEnterT = 0;
let clipExitT = 0;
let clipEnterEdge = -1;
let clipExitEdge = -1;

/**
 * The few edges a chord of a regular polygon can enter and leave through.
 *
 * The polygon is inscribed in its circumcircle, so wherever the ray crosses that circle bounds
 * where it can cross the polygon: within one edge either side, plus a margin. Writes the two
 * window centres and returns false when the ray misses the circumcircle entirely, which is a
 * genuine miss, since the polygon is inside it.
 */
let windowEnter = 0;
let windowExit = 0;

function angularWindow(
  poly: PreparedPolygon,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
): boolean {
  const { circumradius, phase, count } = poly;
  // Shifted into the outline's own frame, so a solid away from the origin gets the same treatment.
  ox -= poly.cx;
  oy -= poly.cy;
  const b = ox * dx + oy * dy;
  const c = ox * ox + oy * oy - circumradius * circumradius;
  const discriminant = b * b - c * (dx * dx + dy * dy);
  if (discriminant <= 0) return false;
  const root = Math.sqrt(discriminant) / (dx * dx + dy * dy);
  const centre = -b / (dx * dx + dy * dy);
  // Inlined rather than a helper closure: this runs once per ray, and allocating a closure there
  // showed up as its own line in the profile.
  const step = (Math.PI * 2) / count;
  const near = centre - root;
  const far = centre + root;
  windowEnter = Math.floor((Math.atan2(oy + dy * near, ox + dx * near) - phase) / step);
  windowExit = Math.floor((Math.atan2(oy + dy * far, ox + dx * far) - phase) / step);
  return true;
}

/**
 * The clip of {@link clipConvex} over a contiguous run of edges, wrapping.
 *
 * Exact for any run that CONTAINS the true edge: at the real entry point the ray is inside every
 * half-plane, so no other entering edge reports a larger `t`, and the max over a subset holding
 * the right one is the max over all of them. The exit is the mirror, as a min. Whether the run
 * held the right edge is checked by the caller, which is cheaper than proving the window's bounds.
 */
function clipRange(
  poly: PreparedPolygon,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  from: number,
  span: number,
  wantEnter: boolean,
): number {
  const { count, ax, ay, nx, ny } = poly;
  let bestT = wantEnter ? -Infinity : Infinity;
  let bestEdge = -1;
  for (let k = 0; k < span; k++) {
    const i = (((from + k) % count) + count) % count;
    const normalX = nx[i];
    const normalY = ny[i];
    const denominator = dx * normalX + dy * normalY;
    if (denominator === 0) continue;
    if (wantEnter ? denominator >= 0 : denominator <= 0) continue;
    const t = ((ax[i] - ox) * normalX + (ay[i] - oy) * normalY) / denominator;
    if (wantEnter ? t > bestT : t < bestT) {
      bestT = t;
      bestEdge = i;
    }
  }
  rangeT = bestT;
  return bestEdge;
}

let rangeT = 0;

/** Whether the crossing at `t` really lands between edge `i`'s endpoints, which is the proof that
 *  a windowed scan looked at the right edge. */
function onSegment(
  poly: PreparedPolygon,
  i: number,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  t: number,
): boolean {
  const { ax, ay, ex, ey } = poly;
  const px = ox + dx * t - ax[i];
  const py = oy + dy * t - ay[i];
  const lengthSq = ex[i] * ex[i] + ey[i] * ey[i];
  if (lengthSq <= 0) return false;
  const along = (px * ex[i] + py * ey[i]) / lengthSq;
  return along >= -1e-9 && along <= 1 + 1e-9;
}

function clipConvex(
  poly: PreparedPolygon,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
): boolean {
  // The angular fast path, worth its overhead only once the scan it replaces is long.
  if (poly.regular && poly.count > 16 && angularWindow(poly, ox, oy, dx, dy)) {
    const enterEdge = clipRange(poly, ox, oy, dx, dy, windowEnter - 2, 5, true);
    const enterT = rangeT;
    const exitEdge = clipRange(poly, ox, oy, dx, dy, windowExit - 2, 5, false);
    const exitT = rangeT;
    if (
      enterEdge >= 0 &&
      exitEdge >= 0 &&
      enterT <= exitT &&
      onSegment(poly, enterEdge, ox, oy, dx, dy, enterT) &&
      onSegment(poly, exitEdge, ox, oy, dx, dy, exitT)
    ) {
      clipEnterT = enterT;
      clipExitT = exitT;
      clipEnterEdge = enterEdge;
      clipExitEdge = exitEdge;
      return true;
    }
    // The window missed. Correctness never rested on it, so fall through and scan everything.
  }
  const { count, ax, ay, nx, ny } = poly;
  let enterT = -Infinity;
  let exitT = Infinity;
  clipEnterEdge = -1;
  clipExitEdge = -1;
  for (let i = 0; i < count; i++) {
    const normalX = nx[i];
    const normalY = ny[i];
    const denominator = dx * normalX + dy * normalY;
    const distance = (ax[i] - ox) * normalX + (ay[i] - oy) * normalY;
    if (denominator === 0) {
      // Parallel to this edge. Outside its half-plane means the ray misses the solid entirely.
      if (distance < 0) return false;
      continue;
    }
    const t = distance / denominator;
    if (denominator < 0) {
      if (t > enterT) {
        enterT = t;
        clipEnterEdge = i;
      }
    } else if (t < exitT) {
      exitT = t;
      clipExitEdge = i;
    }
    if (enterT > exitT) return false;
  }
  clipEnterT = enterT;
  clipExitT = exitT;
  return clipEnterEdge >= 0 && clipExitEdge >= 0;
}

/**
 * Where a ray ENTERS a solid, whatever shape it is.
 *
 * A convex outline goes to {@link clipConvex}. A re-entrant one is not the intersection of its
 * half-planes, so a half-plane test reports crossings on the far side of a notch that the ray
 * never makes, and it is scanned edge by edge as segments instead: the nearest forward crossing
 * where the ray is heading INWARD, against the edge's outward normal, and lands between that
 * edge's endpoints. Both qualifiers matter. Without the direction test a ray leaving through the
 * far wall counts as an entry, and without the segment test every edge's infinite line does.
 *
 * `SURFACE_EPS` is applied here, not left to the caller. A ray stepping on from a previous exit
 * starts exactly on this solid's boundary, so the edge it just left crosses at t of about 0, and
 * returning that would make the caller skip the solid as "behind the ray", which is precisely what
 * has to work for a beam to leave a notch and come back into the same shape.
 */
function clipEntry(poly: PreparedPolygon, ox: number, oy: number, dx: number, dy: number): boolean {
  if (poly.convex) return clipConvex(poly, ox, oy, dx, dy);
  const { count, ax, ay, nx, ny } = poly;
  let bestT = Infinity;
  let bestEdge = -1;
  for (let i = 0; i < count; i++) {
    const denominator = dx * nx[i] + dy * ny[i];
    if (denominator >= 0) continue; // parallel, or heading out through this edge
    const t = ((ax[i] - ox) * nx[i] + (ay[i] - oy) * ny[i]) / denominator;
    if (t <= SURFACE_EPS || t >= bestT) continue;
    if (!onSegment(poly, i, ox, oy, dx, dy, t)) continue;
    bestT = t;
    bestEdge = i;
  }
  if (bestEdge < 0) return false;
  clipEnterT = bestT;
  clipEnterEdge = bestEdge;
  return true;
}

/**
 * Where a ray already INSIDE a solid leaves it. The mirror of {@link clipEntry}: nearest forward
 * crossing where the ray is heading OUTWARD.
 *
 * Requiring the outward direction rather than taking the nearest crossing of any kind is what
 * keeps the refraction honest, the exit normal is read straight off this edge, so picking an
 * inward-facing one would refract the ray through a wall it is not standing at.
 */
function clipExit(poly: PreparedPolygon, ox: number, oy: number, dx: number, dy: number): boolean {
  if (poly.convex) return clipConvex(poly, ox, oy, dx, dy);
  const { count, ax, ay, nx, ny } = poly;
  let bestT = Infinity;
  let bestEdge = -1;
  for (let i = 0; i < count; i++) {
    const denominator = dx * nx[i] + dy * ny[i];
    if (denominator <= 0) continue;
    const t = ((ax[i] - ox) * nx[i] + (ay[i] - oy) * ny[i]) / denominator;
    if (t <= SURFACE_EPS || t >= bestT) continue;
    if (!onSegment(poly, i, ox, oy, dx, dy, t)) continue;
    bestT = t;
    bestEdge = i;
  }
  if (bestEdge < 0) return false;
  clipExitT = bestT;
  clipExitEdge = bestEdge;
  return true;
}

/** Mean of the vertices, which is the centre a regular polygon is regular about. */
function centroid(poly: readonly THREE.Vector2[]): THREE.Vector2 {
  const count = poly.length;
  let cx = 0;
  let cy = 0;
  for (const v of poly) {
    cx += v.x / count;
    cy += v.y / count;
  }
  return new THREE.Vector2(cx, cy);
}

/** Positive for counter-clockwise winding, which decides which perpendicular faces outward. */
function windingSign(poly: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area >= 0 ? 1 : -1;
}

/**
 * Snell's law in the plane, written INTO `out`; false on total internal reflection.
 *
 * In place because a retrace refracts three thousand rays two to four times each, and a fresh
 * vector from each made the garbage collector a tenth of the trace on its own.
 */
function refractInto(out: THREE.Vector2, d: THREE.Vector2, n: THREE.Vector2, eta: number): boolean {
  const cosI = -(d.x * n.x + d.y * n.y);
  const sinT2 = eta * eta * (1 - cosI * cosI);
  if (sinT2 > 1) return false;
  const cosT = Math.sqrt(1 - sinT2);
  out.x = eta * d.x + (eta * cosI - cosT) * n.x;
  out.y = eta * d.y + (eta * cosI - cosT) * n.y;
  return true;
}

function reflectInto(out: THREE.Vector2, d: THREE.Vector2, n: THREE.Vector2): void {
  const k = 2 * (d.x * n.x + d.y * n.y);
  out.x = d.x - k * n.x;
  out.y = d.y - k * n.y;
}

/**
 * Fraction of unpolarized light transmitted by one ideal dielectric boundary.
 *
 * The exact Fresnel equations, averaging the two polarizations; `normal` faces the incident
 * medium. Total internal reflection therefore returns 0 rather than being a special case, which is
 * what lets the beam fade out smoothly as it approaches the critical angle instead of
 * disappearing between one frame and the next.
 */
export function fresnelTransmittance(
  d: THREE.Vector2,
  n: THREE.Vector2,
  iorIn: number,
  iorOut: number,
): number {
  const cosI = Math.min(1, Math.max(0, -d.dot(n)));
  const eta = iorIn / iorOut;
  const sinT2 = eta * eta * (1 - cosI * cosI);
  if (sinT2 >= 1) return 0;
  const cosT = Math.sqrt(1 - sinT2);
  const s = (iorIn * cosI - iorOut * cosT) / (iorIn * cosI + iorOut * cosT);
  const p = (iorIn * cosT - iorOut * cosI) / (iorIn * cosT + iorOut * cosI);
  return 1 - 0.5 * (s * s + p * p);
}

export interface PrismPath {
  /** Where the ray left the glass. */
  origin: THREE.Vector2;
  direction: THREE.Vector2;
  bounces: number;
  /** Entry, every reflection point, then the exit, in traversal order. */
  points: THREE.Vector2[];
  /** Polygon edge index for each entry in {@link points}. */
  edges: number[];
  /** Which solid each of those surfaces belongs to, so two paths through DIFFERENT solids in the
   *  same order are not mistaken for the same route. */
  solids: number[];
  /**
   * Index in {@link points} of the exit from the FIRST solid.
   *
   * The mesh treats the two halves differently and the split has to be recorded rather than
   * assumed. Up to here every wavelength still overlaps every other, so the beam is drawn as one
   * white-summing ribbon per wavelength; past it they have visibly separated and everything,
   * the air gaps between solids and the interiors of the later ones alike, has to be drawn as a
   * fan spanning adjacent wavelengths, or the spectrum bands into stripes.
   */
  firstExit: number;
  /** Fresnel transmission accumulated at entry and exit. */
  transmission: number;
  /** Fresnel transmission at the air-to-glass boundary alone. */
  entryTransmission: number;
}

/** One convex solid the beam may pass through, with its own base index of refraction. */
export interface Solid {
  outline: PreparedPolygon;
  /** Cauchy base index. Per solid, so a scene can put flint next to crown and see the difference. */
  ior: number;
}

/** How many solids one ray may cross before it is abandoned. */
const MAX_SOLIDS = 6;

/**
 * Refract one ray through the polygon and return the ray that comes out the far side.
 *
 * `origin` is outside the glass and `direction` points into it. Total internal reflection at the
 * exit face is a real outcome rather than an error, so the ray keeps bouncing until it escapes or
 * runs out of budget; a ray that never escapes returns undefined and is simply not drawn.
 */
export function tracePrism(
  poly: THREE.Vector2[] | PreparedPolygon,
  origin: THREE.Vector2,
  direction: THREE.Vector2,
  ior: number,
): PrismPath | undefined {
  const outline = Array.isArray(poly) ? preparePolygon(poly) : poly;
  return traceSolids([{ outline, ior }], origin, direction);
}

/**
 * Refract one ray through a SCENE of solids, in whatever order it happens to meet them.
 *
 * The order is found rather than given: at each step the nearest solid the ray actually enters
 * wins, so moving a shape changes the route without anything having to be re-authored. Between
 * solids the ray travels in air and keeps the direction it left with, which is where the spectrum
 * does most of its visible separating, a fan leaving one prism arrives at the next already
 * spread, and each wavelength then refracts on its own terms.
 *
 * A ray that never escapes the last solid it entered returns undefined and is not drawn, exactly
 * as a single-solid ray trapped in total internal reflection does.
 */
export function traceSolids(
  solids: Solid[],
  origin: THREE.Vector2,
  direction: THREE.Vector2,
): PrismPath | undefined {
  const points: THREE.Vector2[] = [];
  const edges: number[] = [];
  const solidTrail: number[] = [];
  let transmission = 1;
  let entryTransmission = 1;
  let firstExit = -1;
  let bounces = 0;

  let fromX = origin.x;
  let fromY = origin.y;
  const heading = traceHeading;
  heading.copy(direction);

  for (let crossing = 0; crossing < MAX_SOLIDS; crossing++) {
    // The nearest solid this ray actually enters. A solid it merely grazes past, or one already
    // behind it, reports no forward entry and is skipped.
    let nearest = -1;
    let nearestT = Infinity;
    let entryEdge = -1;
    for (let i = 0; i < solids.length; i++) {
      if (!clipEntry(solids[i].outline, fromX, fromY, heading.x, heading.y)) continue;
      if (clipEnterT <= SURFACE_EPS || clipEnterT >= nearestT) continue;
      nearestT = clipEnterT;
      nearest = i;
      entryEdge = clipEnterEdge;
    }
    if (nearest < 0) break;

    const { outline, ior } = solids[nearest];
    const entryNormal = traceNormal;
    entryNormal.set(outline.nx[entryEdge], outline.ny[entryEdge]);

    const inside = traceInside;
    if (!refractInto(inside, heading, entryNormal, 1 / ior)) break;

    let position = new THREE.Vector2(fromX + heading.x * nearestT, fromY + heading.y * nearestT);
    points.push(position);
    edges.push(entryEdge);
    solidTrail.push(nearest);
    const entering = fresnelTransmittance(heading, entryNormal, 1, ior);
    if (crossing === 0) entryTransmission = entering;
    transmission *= entering;

    const flipped = traceFlipped;
    let escaped = false;
    for (let b = 0; b <= MAX_BOUNCES; b++) {
      // From INSIDE, so the near clip is behind the ray and the far one is the surface it leaves by.
      if (!clipExit(outline, position.x, position.y, inside.x, inside.y)) break;
      const exitEdge = clipExitEdge;
      if (clipExitT <= SURFACE_EPS) break;
      position = new THREE.Vector2(
        position.x + inside.x * clipExitT,
        position.y + inside.y * clipExitT,
      );
      points.push(position);
      edges.push(exitEdge);
      solidTrail.push(nearest);
      // The exit normal points out and Snell wants the one facing the ray, so it is used negated
      // and flipped back for the bounce.
      flipped.set(-outline.nx[exitEdge], -outline.ny[exitEdge]);
      if (refractInto(traceOut, inside, flipped, ior)) {
        transmission *= fresnelTransmittance(inside, flipped, ior, 1);
        heading.copy(traceOut).normalize();
        bounces += b;
        escaped = true;
        break;
      }
      flipped.set(-flipped.x, -flipped.y);
      reflectInto(inside, inside, flipped);
    }
    // Trapped inside: the ray never gets to whatever is beyond, so there is nothing to draw.
    if (!escaped) return undefined;
    if (firstExit < 0) firstExit = points.length - 1;
    fromX = position.x;
    fromY = position.y;
  }

  if (points.length < 2 || firstExit < 0) return undefined;
  return {
    origin: points[points.length - 1],
    direction: heading.clone(),
    bounces,
    points,
    edges,
    solids: solidTrail,
    firstExit,
    transmission,
    entryTransmission,
  };
}

/**
 * Whether two rays took the same route through the glass.
 *
 * The two edges of a finite beam only bound a band if they entered the same face, bounced the same
 * number of times and left the same face. When they disagree, which happens whenever the beam
 * straddles a vertex, or one edge total-internally-reflects and the other does not, connecting
 * them draws a quad across the inside of the prism that corresponds to no light at all. Dropping
 * the band is the honest answer, and `stats.rejectedTopology` counts how often it happens.
 */
function matchingTopology(a: PrismPath, b: PrismPath): boolean {
  if (a.bounces !== b.bounces || a.edges.length !== b.edges.length) return false;
  if (a.firstExit !== b.firstExit) return false;
  return a.edges.every((edge, i) => edge === b.edges[i] && a.solids[i] === b.solids[i]);
}

// -------------------------------------------------------------------- mesh --

/**
 * Scratch for the mesh pass, for the same reason the tracer has its own: the pass ran to tens of
 * thousands of short-lived vectors per retrace, and a retrace happens on every pointer move.
 */
const meshStart = new THREE.Vector2();
const meshStartLo = new THREE.Vector2();
const meshStartHi = new THREE.Vector2();
const meshEndLo = new THREE.Vector2();
const meshEndHi = new THREE.Vector2();

/** Origin at a normalized coordinate across the finite collimated beam, written into `out`. */
function profileOrigin(
  o: BeamOptions,
  dir: THREE.Vector2,
  profile: number,
  out: THREE.Vector2,
): THREE.Vector2 {
  const offset = o.halfWidth * Math.min(1, Math.max(-1, profile));
  out.x = o.origin.x + -dir.y * offset;
  out.y = o.origin.y + dir.x * offset;
  return out;
}

interface Node {
  nm: number;
  /** Path through the centre of each slice; drives the outgoing fan. */
  paths: (PrismPath | undefined)[];
  /** Path along a slice BOUNDARY; gives the internal strips their width. Sparse, only the two
   *  outer entries are filled eagerly, the rest on demand via {@link Node.traceBoundary}. */
  boundaries: (PrismPath | undefined)[];
  /** Fills in an interior boundary, for the rare case where the outer pair disagree. */
  traceBoundary: (i: number) => PrismPath | undefined;
}

/**
 * How far downstream of the exit face the spectral spread is measured, in world units.
 *
 * Not at the exit itself, and the difference is not subtle. Adjacent wavelengths leave the glass
 * from very nearly the same point, they differ in ANGLE, not position, so the spread measured at
 * the face is close to zero and the density that divides by it goes to infinity. One unit
 * downstream the fan has actually opened, which is where the quantity is meaningful. Ported from
 * the reference; its exposure constant only makes sense against this.
 */
const DENSITY_MEASURE_DISTANCE = 1;

/**
 * Spectral energy density at one wavelength vertex.
 *
 * A finite difference against the neighbouring wavelengths estimates how much width a normalized
 * wavelength interval occupies once it has left the glass. Dividing flux by that Jacobian is what
 * keeps total energy stable as the mesh is subdivided, and, far more visibly, it is what gives
 * the fan a bright core where the wavelengths crowd together and soft ends where they spread.
 */
function spectralDensity(
  nodes: Node[],
  index: number,
  slice: number,
  exposure: number,
  inputWidth: number,
  weight: number,
): number {
  const path = nodes[index].paths[slice];
  if (!path) return 0;

  // Walk out to the nearest neighbour on each side that actually traced, so a wavelength whose
  // band was rejected does not zero the density of the ones beside it.
  let left = index;
  for (let i = index - 1; i >= 0; i--) {
    if (nodes[i].paths[slice]) {
      left = i;
      break;
    }
  }
  let right = index;
  for (let i = index + 1; i < nodes.length; i++) {
    if (nodes[i].paths[slice]) {
      right = i;
      break;
    }
  }
  if (left === right) return 0;

  const lp = nodes[left].paths[slice];
  const rp = nodes[right].paths[slice];
  if (!lp || !rp || !matchingTopology(lp, rp)) return 0;

  // Scalars, in the order three's vector methods would apply them, so the result is the same to
  // the bit without the three vectors a call used to leave for the collector.
  let dx = lp.direction.x + rp.direction.x;
  let dy = lp.direction.y + rp.direction.y;
  const inverse = 1 / (Math.sqrt(dx * dx + dy * dy) || 1);
  dx *= inverse;
  dy *= inverse;
  // Measured downstream, where the wavelengths have separated; see DENSITY_MEASURE_DISTANCE.
  const spanX =
    rp.origin.x +
    rp.direction.x * DENSITY_MEASURE_DISTANCE -
    (lp.origin.x + lp.direction.x * DENSITY_MEASURE_DISTANCE);
  const spanY =
    rp.origin.y +
    rp.direction.y * DENSITY_MEASURE_DISTANCE -
    (lp.origin.y + lp.direction.y * DENSITY_MEASURE_DISTANCE);
  const width = Math.abs(cross2(spanX, spanY, dx, dy));
  const normalized = (right - left) / (nodes.length - 1);
  const jacobian = width / normalized;
  if (jacobian <= 1e-9) return 0;
  return (exposure * inputWidth * weight * path.transmission) / jacobian;
}

/**
 * `nearest`, or the distance to the wall plane at `side` on one axis when that is closer and the
 * ray is still within the other axis's extent `hOther` there.
 */
function wallDistance(
  o: number,
  d: number,
  oOther: number,
  dOther: number,
  side: number,
  hOther: number,
  nearest: number,
): number {
  const distance = (side - o) / d;
  if (distance <= 0 || distance >= nearest) return nearest;
  return Math.abs(oOther + dOther * distance) <= hOther + 1e-6 ? distance : nearest;
}

/**
 * First point at which a forward ray leaves the axis-aligned wall rectangle, written into `out`.
 *
 * Ported from the reference. A ray that never meets the rectangle is returned unmoved, which
 * collapses its quad to nothing rather than drawing a streak off into space.
 */
function rayToWall(
  from: THREE.Vector2,
  dir: THREE.Vector2,
  half: THREE.Vector2,
  out: THREE.Vector2,
): THREE.Vector2 {
  let nearest = Number.POSITIVE_INFINITY;
  // Unrolled in the reference's order, X walls then Y and the near side of each first, so a tie
  // resolves the way it always has.
  if (Math.abs(dir.x) >= 1e-8) {
    nearest = wallDistance(from.x, dir.x, from.y, dir.y, -half.x, half.y, nearest);
    nearest = wallDistance(from.x, dir.x, from.y, dir.y, half.x, half.y, nearest);
  }
  if (Math.abs(dir.y) >= 1e-8) {
    nearest = wallDistance(from.y, dir.y, from.x, dir.x, -half.y, half.x, nearest);
    nearest = wallDistance(from.y, dir.y, from.x, dir.x, half.y, half.x, nearest);
  }
  if (!Number.isFinite(nearest)) return out.copy(from);
  out.x = from.x + dir.x * nearest;
  out.y = from.y + dir.y * nearest;
  return out;
}

/**
 * Build the additive mesh for one beam.
 *
 * Three parts, and they are genuinely different objects rather than three styles of one ribbon:
 *
 *   WHITE INPUT, one quad from source to entry face, drawn once in white. All the wavelengths
 *   share this path, so drawing it per-wavelength would sum N overlapping ribbons to reach a
 *   colour we already know is white.
 *
 *   INTERNAL STRIPS, per wavelength, per slice, per segment between bounces. These are where the
 *   glass looks lit from within.
 *
 *   OUTGOING FAN, quads spanning ADJACENT WAVELENGTHS. This is the important one: the fan is a
 *   continuous surface whose colour interpolates across the rasterizer, so it cannot band no
 *   matter how few samples are used, and the density term makes its brightness physical.
 */
export function buildLightSheet(o: BeamOptions): LightSheet {
  const dir = o.direction.clone().normalize();
  const samples = Math.max(2, Math.floor(o.samples));
  const slices = Math.max(1, Math.floor(o.slices));
  const inputWidth = o.halfWidth * 2;

  // Sized for the common sheet: one white quad per slice, one strip per wavelength and one fan quad
  // per cell. A beam that bounces, or threads several solids, grows into more as it is written.
  ensureVertexCapacity((slices + samples + Math.max(0, samples - 1) * slices) * 6);
  const buffers = vertexScratch;
  let vertexCount = 0;
  let quads = 0;

  const push = (
    p: THREE.Vector2,
    c: readonly [number, number, number],
    profile: number,
    travel: number,
    nm: number,
  ) => {
    if (vertexCount === buffers.capacity) ensureVertexCapacity(vertexCount + 1);
    const i = vertexCount++;
    const j = i * 3;
    buffers.positions[j] = p.x;
    buffers.positions[j + 1] = p.y;
    buffers.positions[j + 2] = o.z;
    buffers.colors[j] = c[0];
    buffers.colors[j + 1] = c[1];
    buffers.colors[j + 2] = c[2];
    buffers.profiles[i] = profile;
    buffers.travels[i] = travel;
    buffers.waves[i] = nm;
  };
  /** `a`,`b` are the near edge pair (colour `ca`); `c`,`d` the far pair (colour `cb`). */
  const quad = (
    a: THREE.Vector2,
    b: THREE.Vector2,
    c: THREE.Vector2,
    d: THREE.Vector2,
    ca: readonly [number, number, number],
    cb: readonly [number, number, number],
    // Profile at the near/far pair's two ends, and travel at the near and far edges.
    pLo = -1,
    pHi = 1,
    tNear = 0,
    tFar = 0,
    nmNear = -1,
    nmFar = -1,
  ) => {
    push(a, ca, pLo, tNear, nmNear);
    push(b, ca, pHi, tNear, nmNear);
    push(d, cb, pHi, tFar, nmFar);
    push(a, ca, pLo, tNear, nmNear);
    push(d, cb, pHi, tFar, nmFar);
    push(c, cb, pLo, tFar, nmFar);
    quads++;
  };

  // Gaussian across the beam's width, normalized so the slices integrate to one. This is the
  // beam's soft edge, and computing it here rather than in the fragment shader means every slice
  // is a flat-shaded quad and the shader stays trivial.
  // Slice centres sit at the MIDPOINT of each boundary interval, not spread across the full width.
  // Spanning [-1,1] with the centres as well as the boundaries puts them half a slice out of step,
  // so the outgoing fan (built from centres) and the internal strips (built from boundaries)
  // disagree about where each slice is, which shows up as hatching across the entry face.
  const profiles: number[] = [];
  const weights: number[] = [];
  let weightSum = 0;
  for (let i = 0; i < slices; i++) {
    const t = ((i + 0.5) / slices) * 2 - 1;
    const w = Math.exp(-o.edgeFalloff * t * t);
    profiles.push(t);
    weights.push(w);
    weightSum += w;
  }
  for (let i = 0; i < slices; i++) weights[i] /= weightSum;

  // ---- trace every wavelength, at slice centres and slice boundaries ----
  const nodes: Node[] = [];
  let validBands = 0;
  let rejectedTopology = 0;

  // Flattened ONCE for the whole sheet: the winding sign and the edge normals are loop-invariant,
  // and deriving them per ray is an O(edges) pass in front of every O(edges) trace.
  const outlines = [
    preparePolygon(o.polygon),
    ...(o.extraSolids ?? []).map((extra) => preparePolygon(extra.polygon)),
  ];
  const extraIors = (o.extraSolids ?? []).map((extra) => extra.ior);
  const solids: Solid[] = outlines.map((outline, i) => ({
    outline,
    ior: i === 0 ? o.ior : extraIors[i - 1],
  }));
  const traceAt = (start: THREE.Vector2, nm: number) => {
    // Dispersion is a property of the LIGHT, so it applies in every solid; the base index is a
    // property of each solid, so it does not.
    for (let i = 0; i < solids.length; i++) {
      solids[i].ior = iorAt(nm, i === 0 ? o.ior : extraIors[i - 1], o.dispersion);
    }
    return traceSolids(solids, start, dir);
  };

  for (let s = 0; s < samples; s++) {
    const nm = LAMBDA_MIN + ((LAMBDA_MAX - LAMBDA_MIN) * s) / (samples - 1);
    const paths = profiles.map((p) => traceAt(profileOrigin(o, dir, p, meshStart), nm));

    // Only the two OUTER boundaries are traced up front. The internal strip is drawn full-width
    // whenever they agree, which is the overwhelmingly common case, and the 23 traces in between
    // would then be thrown away, that is most of the cost of a retrace, and a retrace happens on
    // every frame the pointer moves. The rest are filled in lazily, only when the outer pair
    // disagree and the strip has to be subdivided after all.
    const boundaries: (PrismPath | undefined)[] = Array.from({ length: slices + 1 });
    const traceBoundary = (i: number) => {
      const t = slices === 1 ? (i === 0 ? -1 : 1) : (i / slices) * 2 - 1;
      return traceAt(profileOrigin(o, dir, t, meshStart), nm);
    };
    boundaries[0] = traceBoundary(0);
    boundaries[slices] = traceBoundary(slices);
    if (paths.some(Boolean)) validBands++;
    nodes.push({ nm, paths, boundaries, traceBoundary });
  }

  const densities = nodes.map((_node, i) =>
    profiles.map((_profile, slice) =>
      spectralDensity(nodes, i, slice, o.exposure, inputWidth, weights[slice]),
    ),
  );

  // ---- 1. the white input beam ----
  //
  // One quad PER SLICE, not one for the whole beam. The entry face is slanted, so the slices meet
  // it at staggered points; ending a single wide quad at one shared point leaves its flat end
  // cutting across the face while the internal strips start at their true positions, and the
  // mismatch draws a row of notches across the entry, the beam appears to arrive through a comb.
  // Per-slice quads end exactly where their own strip begins and the seam disappears.
  const reference = nodes.find((n) => n.boundaries.some(Boolean));
  const white = [INPUT_BEAM_RADIANCE, INPUT_BEAM_RADIANCE, INPUT_BEAM_RADIANCE] as const;
  for (let slice = 0; slice < slices; slice++) {
    const tLo = slices === 1 ? -1 : (slice / slices) * 2 - 1;
    const tHi = slices === 1 ? 1 : ((slice + 1) / slices) * 2 - 1;
    const startLo = profileOrigin(o, dir, tLo, meshStartLo);
    const startHi = profileOrigin(o, dir, tHi, meshStartHi);
    // Every wavelength shares the path up to the glass, so any traced boundary gives the entry,
    // but the boundaries are traced lazily, so these have to be materialized rather than read.
    // Left unmaterialized they read as undefined, the fallback runs, and the white beam is drawn
    // straight across the frame as though the prism were not there.
    if (reference) {
      reference.boundaries[slice] ??= reference.traceBoundary(slice);
      reference.boundaries[slice + 1] ??= reference.traceBoundary(slice + 1);
    }
    const endLo =
      reference?.boundaries[slice]?.points[0] ??
      rayToWall(startLo, dir, o.wallHalfExtent, meshEndLo);
    const endHi =
      reference?.boundaries[slice + 1]?.points[0] ??
      rayToWall(startHi, dir, o.wallHalfExtent, meshEndHi);
    quad(startLo, startHi, endLo, endHi, white, white, tLo, tHi, 0, 0);
  }

  // ---- 2. internal strips ----
  // Scaled so the wavelengths, which all overlap inside the glass, sum back to the white source
  // level rather than to N times it.
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const scratch = new THREE.Color();
  for (const node of nodes) {
    wavelengthToBeamRgb(node.nm, scratch);
    sumR += scratch.r;
    sumG += scratch.g;
    sumB += scratch.b;
  }
  const internalScale = INPUT_BEAM_RADIANCE / Math.max(sumR, sumG, sumB, 1);

  for (const node of nodes) {
    wavelengthToBeamRgb(node.nm, scratch);

    // ONE full-width strip per wavelength, not one per slice.
    //
    // Inside the glass every slice still overlaps every other, the beam has been refracted but
    // not yet dispersed apart, so subdividing across the width adds no visible detail. What it
    // does add is 24× the geometry at roughly a PIXEL of width each: at any sane camera distance a
    // slice strip is 0.025 world units across, which lands under one pixel, and a few thousand
    // sub-pixel quads at slightly different angles alias into a hatched comb across the entry
    // face. Full width is both cheaper and the only one of the two that draws a solid beam.
    //
    // The per-slice paths still matter for the FAN, where the wavelengths genuinely separate.
    const outerLo = node.boundaries[0];
    const outerHi = node.boundaries[slices];
    const usable = outerLo && outerHi && matchingTopology(outerLo, outerHi);

    // Fall back to per-slice strips when the beam's two outer edges took different routes, it
    // straddles a vertex, or one edge escaped where the other did not. Narrow quads are the lesser
    // problem when the alternative is a quad spanning a path no light took.
    // [lower path, upper path, share of the beam's flux, profile at each edge]
    const pairs: [PrismPath, PrismPath, number, number, number][] = [];
    if (usable) {
      pairs.push([outerLo, outerHi, 1, -1, 1]);
    } else {
      for (let slice = 0; slice < slices; slice++) {
        node.boundaries[slice] ??= node.traceBoundary(slice);
        node.boundaries[slice + 1] ??= node.traceBoundary(slice + 1);
        const lo = node.boundaries[slice];
        const hi = node.boundaries[slice + 1];
        if (!lo || !hi || !matchingTopology(lo, hi)) {
          rejectedTopology++;
          continue;
        }
        pairs.push([
          lo,
          hi,
          weights[slice],
          (slice / slices) * 2 - 1,
          ((slice + 1) / slices) * 2 - 1,
        ]);
      }
    }

    for (const [lo, hi, share, pairLo, pairHi] of pairs) {
      const gain = internalScale * share * 0.5 * (lo.entryTransmission + hi.entryTransmission);
      const tint = [scratch.r * gain, scratch.g * gain, scratch.b * gain] as const;
      // Only as far as the first exit. Past it the wavelengths have separated and section 3 draws
      // them as a fan; drawing them here as well would lay N overlapping ribbons over a spectrum
      // that is no longer white, and each one would band at its own edges.
      const lastSeg = Math.min(lo.firstExit, hi.firstExit);
      for (let seg = 0; seg < lastSeg; seg++) {
        // Profile spans the strip's own share of the beam width; travel stays 0, since the
        // dilution is a property of the free run after the glass, not of the crossing.
        quad(
          lo.points[seg],
          hi.points[seg],
          lo.points[seg + 1],
          hi.points[seg + 1],
          tint,
          tint,
          pairLo,
          pairHi,
          0,
          0,
          node.nm,
          node.nm,
        );
      }
    }
  }

  // ---- 3. the outgoing fan, spanning adjacent wavelengths ----
  // The COUNT, not the buffer length: the scratch is sized to an upper bound and its tail is
  // unused, so reading its length would put the fan boundary past the end of the mesh.
  const fanFirstVertex = vertexCount;
  const lowRgb = new THREE.Color();
  const highRgb = new THREE.Color();
  for (let i = 0; i < nodes.length - 1; i++) {
    const low = nodes[i];
    const high = nodes[i + 1];
    wavelengthToBeamRgb(low.nm, lowRgb);
    wavelengthToBeamRgb(high.nm, highRgb);

    // Per slice. Collapsing this to one full-width quad per wavelength pair is tempting, the rays
    // of one wavelength do leave parallel, but the quad then has to span the beam's width AND the
    // step in wavelength at once, and those are different directions: the result is a stack of
    // full-width sheets that sum to white and lose the spectrum entirely. The slices stay.
    for (let slice = 0; slice < slices; slice++) {
      const lp = low.paths[slice];
      const hp = high.paths[slice];
      if (!lp || !hp || !matchingTopology(lp, hp)) continue;
      const la = densities[i][slice];
      const ha = densities[i + 1][slice];
      const lc = [lowRgb.r * la, lowRgb.g * la, lowRgb.b * la] as const;
      const hc = [highRgb.r * ha, highRgb.g * ha, highRgb.b * ha] as const;

      // From the first exit to the wall, segment by segment. With one solid that is a single run
      // to the wall and identical to what this always drew; with several it also covers the air
      // gaps between them and the interiors of the later ones, which is the whole point, by then
      // the wavelengths have separated, and a fan spanning adjacent ones is the only topology that
      // interpolates the spectrum instead of banding it.
      //
      // Travel is normalized across the WHOLE run rather than per segment, so the longitudinal
      // falloff keeps dimming the light as it crosses the scene instead of resetting at each solid.
      const segments = lp.points.length - 1 - lp.firstExit;
      for (let seg = 0; seg < segments; seg++) {
        const k = lp.firstExit + seg;
        quad(
          lp.points[k],
          hp.points[k],
          lp.points[k + 1],
          hp.points[k + 1],
          lc,
          hc,
          profiles[slice],
          profiles[slice],
          seg / (segments + 1),
          (seg + 1) / (segments + 1),
          low.nm,
          high.nm,
        );
      }
      quad(
        lp.origin,
        hp.origin,
        rayToWall(lp.origin, lp.direction, o.wallHalfExtent, meshEndLo),
        rayToWall(hp.origin, hp.direction, o.wallHalfExtent, meshEndHi),
        lc,
        hc,
        profiles[slice],
        profiles[slice],
        segments / (segments + 1),
        1,
        low.nm,
        high.nm,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  const attribute = (array: Float32Array, size: number) =>
    new THREE.BufferAttribute(array.slice(0, vertexCount * size), size);
  geometry.setAttribute("position", attribute(buffers.positions, 3));
  geometry.setAttribute("aColor", attribute(buffers.colors, 3));
  geometry.setAttribute("aProfile", attribute(buffers.profiles, 1));
  geometry.setAttribute("aTravel", attribute(buffers.travels, 1));
  geometry.setAttribute("aWavelength", attribute(buffers.waves, 1));

  return {
    geometry,
    stats: { samples, slices, validBands, rejectedTopology, quads, fanFirstVertex },
  };
}

/**
 * The cross-section a `prism`/`hex` shape presents to the sheet.
 *
 * `prism()` builds a {@link THREE.LatheGeometry}, so its cross-section is a regular polygon of
 * `sides` vertices at radius `r`. An item rotated -90° about X brings that into the XY plane with
 * a vertex pointing up, the orientation the effect is named after. Deriving the polygon from the
 * same `r`/`sides` the mesh was built from keeps the traced path and the visible glass in
 * agreement; reading it back off the geometry would also have to undo the fillet, which rounds the
 * silhouette but not the optics.
 */
export function prismCrossSection(
  r: number,
  sides: number,
  rotation = Math.PI / 2,
  centre?: { x: number; y: number },
): THREE.Vector2[] {
  const cx = centre?.x ?? 0;
  const cy = centre?.y ?? 0;
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (Math.PI * 2 * i) / sides;
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}
