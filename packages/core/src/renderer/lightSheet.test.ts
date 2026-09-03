import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  aimBeam,
  aimBeamAtAngle,
  preparePolygon,
  traceSolids,
  type Solid,
  buildLightSheet,
  crossSectionFor,
  fresnelTransmittance,
  iorAt,
  prismCrossSection,
  tracePrism,
  wavelengthToBeamRgb,
  type BeamOptions,
} from "./lightSheet";
import { PRESETS } from "../presets";
import { ensureSceneConfig } from "../config/model";

/** The beam options the `prism` preset resolves to, so these check the SHIPPED numbers rather
 *  than a set invented here that could drift away from them. */
function presetBeam(): BeamOptions {
  const beam = ensureSceneConfig(PRESETS.prism()).beam;
  if (!beam) throw new Error("the prism preset must carry a beam");
  const polygon = crossSectionFor(
    { kind: "prism", r: beam.radius, sides: beam.sides },
    beam.rotation,
    0,
  )!;
  return {
    polygon,
    ...aimBeamAtAngle(polygon, beam.entryAngle ?? 0, beam.incidence, beam.width, beam.distance),
    halfWidth: beam.width,
    z: beam.z,
    ior: beam.ior,
    dispersion: beam.dispersion,
    samples: beam.samples,
    slices: beam.slices,
    // The renderer derives this from the frustum; a fixed span is fine for the maths under test.
    wallHalfExtent: new THREE.Vector2(1.6, 0.9),
    exposure: beam.exposure,
    edgeFalloff: beam.edgeFalloff,
  };
}

const peak = (c: THREE.Color) => Math.max(c.r, c.g, c.b);

describe("wavelengthToBeamRgb", () => {
  it("puts each named hue in the right channel", () => {
    expect(wavelengthToBeamRgb(450).b).toBeGreaterThan(wavelengthToBeamRgb(450).r);
    expect(wavelengthToBeamRgb(530).g).toBeGreaterThan(wavelengthToBeamRgb(530).b);
    expect(wavelengthToBeamRgb(680).r).toBeGreaterThan(wavelengthToBeamRgb(680).g);
  });

  /**
   * The point of using the CIE curves rather than a hue ramp. The eye's photopic response peaks
   * near 555nm, so a real spectrum is far brighter in the green than at either end, which is what
   * gives it a luminous core instead of reading as equal-weight coloured bars.
   */
  it("weights by the eye's photopic response, so green outshines both ends", () => {
    expect(peak(wavelengthToBeamRgb(555))).toBeGreaterThan(peak(wavelengthToBeamRgb(410)));
    expect(peak(wavelengthToBeamRgb(555))).toBeGreaterThan(peak(wavelengthToBeamRgb(690)));
  });

  it("never emits a negative channel, since spectral colours sit outside sRGB", () => {
    for (let nm = 400; nm <= 700; nm += 5) {
      const c = wavelengthToBeamRgb(nm);
      expect(Math.min(c.r, c.g, c.b)).toBeGreaterThanOrEqual(0);
    }
  });

  it("integrates to something near neutral, which is what the white balance is for", () => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let nm = 400; nm <= 700; nm += 2) {
      const c = wavelengthToBeamRgb(nm);
      r += c.r;
      g += c.g;
      b += c.b;
    }
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    expect(max / min).toBeLessThan(1.25);
  });
});

describe("fresnelTransmittance", () => {
  const down = new THREE.Vector2(0, -1);
  const up = new THREE.Vector2(0, 1);

  it("transmits nearly everything at normal incidence", () => {
    expect(fresnelTransmittance(down, up, 1, 1.5)).toBeGreaterThan(0.95);
  });

  it("falls off toward grazing incidence", () => {
    const shallow = new THREE.Vector2(Math.cos(-0.15), Math.sin(-0.15)).normalize();
    const grazing = new THREE.Vector2(Math.cos(-0.02), Math.sin(-0.02)).normalize();
    expect(fresnelTransmittance(grazing, up, 1, 1.5)).toBeLessThan(
      fresnelTransmittance(shallow, up, 1, 1.5),
    );
  });

  it("returns exactly zero past the critical angle, rather than treating it as an error", () => {
    // Critical angle for 1.5 -> 1 is ~41.8°; 60° from the normal is well past it.
    const past = new THREE.Vector2(Math.sin(Math.PI / 3), -Math.cos(Math.PI / 3)).normalize();
    expect(fresnelTransmittance(past, up, 1.5, 1)).toBe(0);
  });
});

describe("iorAt", () => {
  it("bends short wavelengths harder, which is the whole reason a prism disperses", () => {
    expect(iorAt(400, 1.245, 0.06)).toBeGreaterThan(iorAt(700, 1.245, 0.06));
  });

  it("collapses to a single index when dispersion is off", () => {
    expect(iorAt(400, 1.5, 0)).toBe(iorAt(700, 1.5, 0));
  });
});

describe("prismCrossSection", () => {
  it("returns `sides` vertices on the circumradius", () => {
    const poly = prismCrossSection(4, 3);
    expect(poly).toHaveLength(3);
    for (const v of poly) expect(v.length()).toBeCloseTo(4, 6);
  });

  it("puts a vertex at the top by default, matching a prism item rotated -90° about X", () => {
    const [apex] = prismCrossSection(4, 3);
    expect(apex.x).toBeCloseTo(0, 6);
    expect(apex.y).toBeCloseTo(4, 6);
  });
});

describe("tracePrism", () => {
  const poly = prismCrossSection(4, 3);

  it("reports the faces it crossed and a transmission below one", () => {
    const path = tracePrism(
      poly,
      new THREE.Vector2(-18, 1.2),
      new THREE.Vector2(Math.cos(0.14), Math.sin(0.14)),
      1.44,
    );
    expect(path).toBeDefined();
    expect(path?.bounces).toBe(0);
    expect(path?.points).toHaveLength(2); // entry, exit
    expect(path?.transmission).toBeGreaterThan(0);
    expect(path?.transmission).toBeLessThan(1);
    // Fresnel is lossy at both boundaries, so the round trip is below the entry alone.
    expect(path!.transmission).toBeLessThan(path!.entryTransmission);
  });

  it("returns undefined for a ray that never reaches the glass", () => {
    expect(
      tracePrism(poly, new THREE.Vector2(-18, 40), new THREE.Vector2(1, 0), 1.44),
    ).toBeUndefined();
  });

  it("bounces instead of leaving when the index traps the ray", () => {
    const trapped = tracePrism(
      poly,
      new THREE.Vector2(-18, 1.2),
      new THREE.Vector2(Math.cos(0.14), Math.sin(0.14)),
      2.4,
    );
    // Either it escapes after reflecting, or it never escapes at all, both mean bounces > 0.
    expect(trapped === undefined || trapped.bounces > 0).toBe(true);
  });
});

describe("buildLightSheet", () => {
  it("emits geometry whose attributes agree on the vertex count", () => {
    const { geometry, stats } = buildLightSheet(presetBeam());
    const n = geometry.getAttribute("position").count;
    expect(n).toBeGreaterThan(0);
    expect(geometry.getAttribute("aColor").count).toBe(n);
    expect(stats.validBands).toBe(stats.samples);
  });

  it("keeps the sheet planar", () => {
    const { geometry } = buildLightSheet({ ...presetBeam(), z: 2.5 });
    const pos = geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) expect(pos.getZ(i)).toBe(2.5);
  });

  it("still draws the white input beam when the shape is missed entirely", () => {
    const o = presetBeam();
    const { geometry, stats } = buildLightSheet({ ...o, origin: new THREE.Vector2(-18, 40) });
    expect(stats.validBands).toBe(0);
    // One white quad PER SLICE, the entry face is slanted, so the slices cannot share one quad.
    expect(geometry.getAttribute("position").count).toBe(o.slices * 6);
  });

  /**
   * The pointer sweeps incidence across the critical angle on purpose, so what has to hold over
   * the whole range is not "never bounces", it is that every position produces a beam that is
   * actually ON the face and actually traced. A ray that misses the glass, or one that never
   * escapes at all, is the failure; total internal reflection is a feature.
   */
  it("produces a traced beam everywhere the pointer bindings can drive it", () => {
    const cfg = ensureSceneConfig(PRESETS.prism());
    const beam = cfg.beam!;
    const polygon = prismCrossSection(beam.radius, beam.sides, beam.rotation);
    const find = (t: string) => cfg.interaction?.bindings?.find((b) => b.target === t);
    const inc = find("beamIncidence");
    const ent = find("beamEntry");
    expect(inc, "preset must bind beamIncidence").toBeDefined();
    expect(ent, "preset must bind beamEntry").toBeDefined();

    for (let i = 0; i <= 6; i++) {
      for (let j = 0; j <= 4; j++) {
        const incidence = (inc!.from ?? 0) + ((inc!.to - (inc!.from ?? 0)) * i) / 6;
        const entry = (ent!.from ?? 0) + ((ent!.to - (ent!.from ?? 0)) * j) / 4;
        const aim = aimBeam(polygon, beam.face, incidence, entry, beam.width, beam.distance);
        const at = `incidence ${incidence.toFixed(0)}deg entry ${entry.toFixed(2)}`;
        // The mid-spectrum ray, at both edges of the finite beam, must reach the glass.
        for (const edge of [-1, 0, 1]) {
          const perp = new THREE.Vector2(-aim.direction.y, aim.direction.x);
          const origin = aim.origin.clone().addScaledVector(perp, beam.width * edge);
          const path = tracePrism(
            polygon,
            origin,
            aim.direction,
            iorAt(550, beam.ior, beam.dispersion),
          );
          expect(path, `${at} edge ${edge}`).toBeDefined();
        }
      }
    }
  });

  /**
   * The half of the sweep that exists to show light bouncing INSIDE the glass. At shallow
   * incidence the internal ray meets the exit face past the critical angle and cannot leave, so it
   * reflects, and the tracer has to follow that rather than dropping the ray, or the low end of
   * the pointer's range renders as nothing at all.
   */
  it("totally internally reflects at the shallow end of the pointer's range", () => {
    const beam = ensureSceneConfig(PRESETS.prism()).beam!;
    const polygon = prismCrossSection(beam.radius, beam.sides, beam.rotation);
    const aim = aimBeam(polygon, beam.face, 12, 0.5, beam.width, beam.distance);
    const path = tracePrism(
      polygon,
      aim.origin,
      aim.direction,
      iorAt(550, beam.ior, beam.dispersion),
    );
    expect(path?.bounces ?? 0).toBeGreaterThan(0);
    // Every bounce adds a point, so the internal polyline is longer than entry + exit.
    expect(path!.points.length).toBeGreaterThan(2);
  });

  /**
   * Subdivision invariance, the point of dividing flux by the Jacobian.
   *
   * Each wavelength vertex carries a DENSITY, so the physical quantity is the Riemann sum
   * `Σ density · Δλ`, and Δλ shrinks as 1/samples. Doubling the sample count must therefore
   * roughly double the summed density and leave `Σ / samples` where it was; without the Jacobian
   * that quotient stays flat while the total scales, and the frame gets brighter every time the
   * mesh is refined. `fanFirstVertex` isolates the outgoing fan: the white input beam is a fixed
   * count, and the internal strips carry a separate normalization, so neither belongs here.
   */
  it("keeps total emitted energy stable when the spectrum is subdivided further", () => {
    const base = presetBeam();
    const fanEnergyPerSample = (samples: number) => {
      const { geometry, stats } = buildLightSheet({ ...base, samples });
      const c = geometry.getAttribute("aColor");
      let total = 0;
      for (let i = stats.fanFirstVertex; i < c.count; i++) {
        total += c.getX(i) + c.getY(i) + c.getZ(i);
      }
      return total / samples;
    };
    const ratio = fanEnergyPerSample(128) / fanEnergyPerSample(32);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  it("fans through a second solid in several segments, not one run to the wall", () => {
    // With one solid every fan cell is a single quad from the exit face to the wall. A second
    // solid on the way adds the air gap, its interior and the run beyond, each a quad of its own,
    // so the mesh grows well past one quad per cell and the scratch it is written into grows too.
    const base = presetBeam();
    const beam = ensureSceneConfig(PRESETS.prism()).beam!;
    const centre = tracePrism(
      base.polygon,
      base.origin,
      base.direction,
      iorAt(550, base.ior, base.dispersion),
    )!;
    const at = centre.origin.clone().addScaledVector(centre.direction, 0.5);
    const hex = prismCrossSection(0.12, 6, beam.rotation, { x: at.x, y: at.y });
    const alone = buildLightSheet(base).stats;
    const chained = buildLightSheet({ ...base, extraSolids: [{ polygon: hex, ior: 1.7 }] }).stats;
    expect(alone.quads).toBe(alone.slices + alone.samples + (alone.samples - 1) * alone.slices);
    expect(chained.validBands).toBe(chained.samples);
    expect(chained.quads).toBeGreaterThan(alone.quads * 2);
  });

  it("counts the strips it refuses to draw when the beam straddles a vertex", () => {
    // A wide beam aimed down at a triangle's apex: the half left of the apex enters the left face
    // and the rest the right, so the beam's outer edges disagree, the strip falls back to slices,
    // and the slice across the apex has no honest quad. One per wavelength, and counted.
    const { stats } = buildLightSheet({
      ...presetBeam(),
      polygon: prismCrossSection(1, 3),
      origin: new THREE.Vector2(0.02, 5),
      direction: new THREE.Vector2(0, -1),
      halfWidth: 0.3,
      slices: 3,
      samples: 16,
      wallHalfExtent: new THREE.Vector2(6, 6),
    });
    expect(stats.validBands).toBe(stats.samples);
    expect(stats.rejectedTopology).toBe(stats.samples);
  });
});

describe("crossSectionFor", () => {
  it("follows the mesh's own segment count", () => {
    // A lathe with 72 segments is a 72-gon optically as well as visually. Tracing some other
    // number puts the bend a fraction of a degree off the edge it is drawn on, and refracts a
    // deliberately faceted low-poly shape as if it were smooth.
    expect(crossSectionFor({ kind: "sphere", r: 1, sides: 72 }, Math.PI / 2, 0)!).toHaveLength(72);
    expect(crossSectionFor({ kind: "rod", r: 1, sides: 16 }, Math.PI / 2, 0)!).toHaveLength(16);
    expect(crossSectionFor({ kind: "prism", r: 1, sides: 3 }, Math.PI / 2, 0)!).toHaveLength(3);
  });

  it("refuses the kinds whose slice is not a convex polygon", () => {
    // Returning a circle for these is not a rough approximation, it is a different solid, and the
    // tracer's clipping assumes convexity, so it would report crossings that are not there.
    for (const kind of ["ring", "slab", "arrow", "blob"] as const) {
      expect(crossSectionFor({ kind, r: 1, sides: 72 }, Math.PI / 2, 0)).toBeUndefined();
    }
  });

  it("traces a convex drawn outline", () => {
    // `path` is the one kind that answers "maybe": its outline is authored, so convexity is a
    // property of the shape rather than of the kind.
    const lozenge = crossSectionFor(
      { kind: "path", r: 2, sides: 72, outline: "M0 0 H40 V20 H0 Z" },
      0,
      0,
    );
    expect(lozenge).toBeDefined();
    expect(Math.max(...lozenge!.map((p) => p.x))).toBeCloseTo(2, 4);
  });

  it("traces a re-entrant drawn outline too", () => {
    // Convexity used to be the gate. It is now only a choice of clipper, a star is a perfectly
    // good solid and the tracer follows one.
    const star =
      "M50 0 L61.8 33.8 L97.6 34.5 L69 56.2 L79.4 90.5 L50 70 L20.6 90.5 L31 56.2 L2.4 34.5 L38.2 33.8 Z";
    expect(crossSectionFor({ kind: "path", r: 2, sides: 72, outline: star }, 0, 0)).toBeDefined();
  });

  it("refuses a self-crossing drawn outline", () => {
    // The one gate worth keeping: a figure-of-eight has no inside, so entering and leaving it has
    // nothing to be right about.
    const bowtie = "M0 0 L10 10 L10 0 L0 10 Z";
    expect(
      crossSectionFor({ kind: "path", r: 2, sides: 72, outline: bowtie }, 0, 0),
    ).toBeUndefined();
  });

  it("has nothing to trace for a path with no outline", () => {
    expect(crossSectionFor({ kind: "path", r: 2, sides: 72 }, 0, 0)).toBeUndefined();
  });

  it("answers a repeated drawn outline from its cache, as a fresh copy each time", () => {
    // A path target is read on every retrace, so the fitted outline is kept. What comes back is
    // posed anew each time: a caller that moved one answer must not have moved the next.
    const star =
      "M50 0 L61.8 33.8 L97.6 34.5 L69 56.2 L79.4 90.5 L50 70 L20.6 90.5 L31 56.2 L2.4 34.5 L38.2 33.8 Z";
    const shape = { kind: "path", r: 2, sides: 72, outline: star } as const;
    const first = crossSectionFor(shape, 0, 0.3, { x: 1, y: 2 })!;
    const second = crossSectionFor(shape, 0, 0.3, { x: 1, y: 2 })!;
    expect(second.map((p) => [p.x, p.y])).toEqual(first.map((p) => [p.x, p.y]));
    expect(second[0]).not.toBe(first[0]);
    // And a different radius is a different fit, not a stale hit.
    const larger = crossSectionFor({ ...shape, r: 4 }, 0, 0.3, { x: 1, y: 2 })!;
    expect(Math.max(...larger.map((p) => p.x))).toBeGreaterThan(Math.max(...first.map((p) => p.x)));
  });

  it("spares a drawn outline the beam's own rotation, and applies the item's roll", () => {
    // `beamRotation` reconciles the LATHE convention, a lathe's slice is generated here in XZ and
    // the default rotation is what puts a vertex at the top. A path is drawn in XY already, so the
    // same rotation would spin the outline away from where the mesh actually sits.
    const shape = { kind: "path", r: 2, sides: 72, outline: "M0 0 H40 V20 H0 Z" } as const;
    const spun = crossSectionFor(shape, Math.PI / 2, 0)!;
    const still = crossSectionFor(shape, 0, 0)!;
    expect(spun.map((p) => [p.x, p.y])).toEqual(still.map((p) => [p.x, p.y]));
    const rolled = crossSectionFor(shape, 0, Math.PI / 2)!;
    expect(Math.max(...rolled.map((p) => p.y))).toBeCloseTo(2, 4);
  });

  it("puts a drawn outline where the item stands", () => {
    const moved = crossSectionFor(
      { kind: "path", r: 1, sides: 72, outline: "M0 0 H10 V10 H0 Z" },
      0,
      0,
      { x: 5, y: -2 },
    )!;
    expect(Math.max(...moved.map((p) => p.x))).toBeCloseTo(6, 4);
    expect(Math.min(...moved.map((p) => p.y))).toBeCloseTo(-3, 4);
  });

  it("slices a cone at its half-height, not its base", () => {
    const [first] = crossSectionFor({ kind: "cone", r: 2, sides: 72 }, 0, 0)!;
    expect(Math.hypot(first.x, first.y)).toBeCloseTo(1, 9);
  });

  it("puts the outline where the solid is", () => {
    const moved = crossSectionFor({ kind: "prism", r: 1, sides: 3 }, Math.PI / 2, 0, {
      x: 5,
      y: -2,
    })!;
    expect(moved[0].x).toBeCloseTo(5, 9);
    expect(moved[0].y).toBeCloseTo(-1, 9);
    // Still regular about its own centre, which is what keeps the angular fast path available.
    expect(preparePolygon(moved).regular).toBe(true);
  });

  it("ignores the field on a hex, whose builder does too", () => {
    expect(crossSectionFor({ kind: "hex", r: 1, sides: 3 }, Math.PI / 2, 0)).toHaveLength(6);
    expect(crossSectionFor({ kind: "hex", r: 1, sides: 72 }, Math.PI / 2, 0)!).toHaveLength(6);
  });

  it("matches the lathe's own vertex angles", () => {
    // LatheGeometry sweeps from 0 and the item is rotated -90 about X, which puts a vertex at the
    // top in world XY. If these disagree the beam refracts through a solid that is rotated off
    // the visible one, and the error is a few degrees, visible, and hard to attribute.
    const [apex] = crossSectionFor({ kind: "prism", r: 4, sides: 3 }, Math.PI / 2, 0)!;
    expect(apex.x).toBeCloseTo(0, 9);
    expect(apex.y).toBeCloseTo(4, 9);
  });
});

describe("aimBeamAtAngle", () => {
  const triangle = crossSectionFor({ kind: "prism", r: 1, sides: 3 }, Math.PI / 2, 0)!;

  it("hits the outline at the requested bearing", () => {
    // 30 degrees is the midpoint of the upper-right face on a triangle at this rotation.
    const { origin, direction } = aimBeamAtAngle(triangle, 30, 0, 0.01, 5);
    const hit = origin.clone().addScaledVector(direction, 5);
    expect((Math.atan2(hit.y, hit.x) * 180) / Math.PI).toBeCloseTo(30, 4);
  });

  it("aims INTO the solid, not away from it", () => {
    for (const angle of [0, 30, 95, 180, 250, 330]) {
      const { origin, direction } = aimBeamAtAngle(triangle, angle, 0, 0.01, 5);
      // The origin sits outside and the ray travels toward the centre.
      expect(origin.length()).toBeGreaterThan(1);
      expect(direction.dot(origin.clone().normalize())).toBeLessThan(0);
    }
  });

  it("keeps the whole beam clear of a vertex", () => {
    // 90 degrees IS the apex. A beam striking a corner splits between two faces and the tracer
    // follows only one, so half of it would silently vanish.
    const hexagon = crossSectionFor({ kind: "hex", r: 1, sides: 6 }, Math.PI / 2, 0)!;
    const width = 0.08;
    const { origin, direction } = aimBeamAtAngle(hexagon, 90, 0, width, 5);
    const hit = origin.clone().addScaledVector(direction, 5);
    const nearest = Math.min(...hexagon.map((v) => v.distanceTo(hit)));
    expect(nearest).toBeGreaterThan(width);
  });

  it("measures the bearing from the polygon's centroid, not the world origin", () => {
    // A solid stands wherever the scene puts it. Measured from the origin, a bearing toward a
    // triangle at (5, 0) strikes whichever face happens to face the origin, or nothing at all.
    const centred = crossSectionFor({ kind: "prism", r: 1, sides: 3 }, Math.PI / 2, 0)!;
    const moved = crossSectionFor({ kind: "prism", r: 1, sides: 3 }, Math.PI / 2, 0, {
      x: 5,
      y: 0,
    })!;
    // A few degrees off the normal, so no ray runs through the centroid and out of a far vertex.
    for (const bearing of [0, 40, 90, 135, 180, 250, 300]) {
      const c = aimBeamAtAngle(centred, bearing, 5, 0.01, 5);
      const m = aimBeamAtAngle(moved, bearing, 5, 0.01, 5);
      const reference = c.origin.clone().addScaledVector(c.direction, 5);
      const hit = m.origin.clone().addScaledVector(m.direction, 5);
      // The same point on the outline, carried along with it.
      expect(hit.x - 5, `bearing ${bearing}`).toBeCloseTo(reference.x, 9);
      expect(hit.y, `bearing ${bearing}`).toBeCloseTo(reference.y, 9);
      expect(m.direction.x).toBeCloseTo(c.direction.x, 9);
      expect(m.direction.y).toBeCloseTo(c.direction.y, 9);
      expect(tracePrism(centred, c.origin, c.direction, 1.5), `bearing ${bearing}`).toBeDefined();
      expect(tracePrism(moved, m.origin, m.direction, 1.5), `bearing ${bearing}`).toBeDefined();
    }
  });

  it("is continuous across a face boundary, unlike a face index", () => {
    // The point this parameterization exists for: sweeping the bearing walks the outline instead
    // of jumping when it crosses a vertex.
    const circle = crossSectionFor({ kind: "sphere", r: 1, sides: 3 }, Math.PI / 2, 0)!;
    let previous: THREE.Vector2 | undefined;
    for (let a = 0; a <= 360; a += 3) {
      const { origin, direction } = aimBeamAtAngle(circle, a, 0, 0.001, 5);
      const hit = origin.clone().addScaledVector(direction, 5);
      if (previous) expect(hit.distanceTo(previous)).toBeLessThan(0.1);
      previous = hit;
    }
  });
});

describe("the angular fast path", () => {
  it("agrees with a full scan on every ray, and is actually taken", () => {
    // The windowed clip is only ever a speed-up: exact when its window holds the right edge, and
    // falling back to the full scan when it does not. This pins BOTH halves, that the two paths
    // are indistinguishable, and that the fast one really fires, since a window that silently
    // never triggered would pass an agreement test trivially.
    const smooth = crossSectionFor({ kind: "sphere", r: 1, sides: 72 }, Math.PI / 2, 0)!;
    const fastOutline = preparePolygon(smooth);
    const scanOutline = preparePolygon(smooth, false);
    expect(fastOutline.regular).toBe(true);
    expect(scanOutline.regular).toBe(false);

    let traced = 0;
    for (let i = 0; i < 6000; i++) {
      const a = (i * 0.61803398875) % 1;
      const b = ((i * 0.41421356) % 1) * 2 - 1;
      const angle = a * Math.PI * 2;
      const origin = new THREE.Vector2(Math.cos(angle) * 6, Math.sin(angle) * 6);
      const aim = new THREE.Vector2(
        -Math.cos(angle) + b * 0.28,
        -Math.sin(angle) + b * 0.19,
      ).normalize();
      const fast = tracePrism(fastOutline, origin, aim, 1.5);
      const scan = tracePrism(scanOutline, origin, aim, 1.5);
      expect(Boolean(fast)).toBe(Boolean(scan));
      if (!fast || !scan) continue;
      traced++;
      expect(fast.bounces).toBe(scan.bounces);
      expect(fast.edges).toEqual(scan.edges);
      expect(fast.origin.x).toBeCloseTo(scan.origin.x, 12);
      expect(fast.origin.y).toBeCloseTo(scan.origin.y, 12);
      expect(fast.direction.x).toBeCloseTo(scan.direction.x, 12);
      expect(fast.direction.y).toBeCloseTo(scan.direction.y, 12);
      expect(fast.transmission).toBeCloseTo(scan.transmission, 12);
    }
    expect(traced).toBeGreaterThan(2000);
  });
});

/**
 * A chain of three DIFFERENT solids for the light to thread, a hexagon, a sphere and a triangular
 * prism, each with its own index.
 *
 * Held here rather than read out of a preset. It used to be `PRESETS.cascade`, and when that
 * preset was replaced the behaviour it covered did not go anywhere: `traceSolids` still walks a
 * scene of solids in whatever order it meets them, and that walk is what lets a beam re-enter a
 * re-entrant outline too. Losing the only test of it along with the scene would have been a real
 * gap, so the geometry moved into the test that needs it.
 */
const CHAIN = [
  { kind: "prism", sides: 3, r: 0.32, x: -0.6, y: 0.14, spin: 0, ior: 1.62 },
  { kind: "sphere", sides: 72, r: 0.28, x: -0.02, y: 0.02, spin: 0, ior: 1.5 },
  { kind: "hex", sides: 6, r: 0.3, x: 0.62, y: 0, spin: Math.PI / 6, ior: 1.74 },
] as const;

/** The beam that threads them: the `prism` preset's optics, re-aimed for a chain. The sweep is
 *  narrow because the route that reaches all three survives only a few degrees. */
function chainBeam() {
  return {
    ...ensureSceneConfig(PRESETS.prism()).beam!,
    entryAngle: 235,
    incidence: 45,
    entrySweep: 26,
  };
}

/** Those three outlines in world space, ready for the tracer. */
function chainSolids(): Solid[] {
  const beam = chainBeam();
  return CHAIN.map((s) => ({
    outline: preparePolygon(
      crossSectionFor({ kind: s.kind, r: s.r, sides: s.sides }, beam.rotation, s.spin, {
        x: s.x,
        y: s.y,
      })!,
    ),
    ior: s.ior,
  }));
}

/** Retune every solid to one wavelength. The BASE indices are passed in, because `Solid.ior` is
 *  overwritten in place and reading it back would compound the dispersion sample by sample. */
function tune(solids: Solid[], base: number[], nm: number, dispersion: number): void {
  for (const [i, s] of solids.entries()) s.ior = iorAt(nm, base[i], dispersion);
}

describe("a chain of solids", () => {
  it("threads all three solids across the whole pointer sweep", () => {
    // The point of the scene, and the thing that silently stops being true. A chain only looks
    // like a chain while the light actually reaches every link; miss the second shape and it
    // degrades to a single prism with no error anywhere.
    const beam = chainBeam();
    const solids = chainSolids();
    const bases = solids.map((s) => s.ior);
    let threaded = 0;
    let positions = 0;
    for (let e = 0; e <= 1.0001; e += 0.125) {
      for (let y = 0; y <= 1.0001; y += 0.25) {
        positions++;
        const incidence = beam.incidence + 8 - 16 * y;
        const aim = aimBeamAtAngle(
          solids[0].outline.points,
          (beam.entryAngle ?? 0) + (e - 0.5) * (beam.entrySweep ?? 90),
          incidence,
          beam.width,
          beam.distance,
        );
        const visited = new Set<number>();
        let traced = 0;
        for (let i = 0; i < 16; i++) {
          const nm = 380 + (750 - 380) * (i / 15);
          tune(solids, bases, nm, beam.dispersion);
          const path = traceSolids(solids, aim.origin, aim.direction);
          if (!path) continue;
          traced++;
          for (const which of path.solids) visited.add(which);
        }
        if (traced >= 15 && visited.size === 3) threaded++;
      }
    }
    // Not all of them: a chain is genuinely fragile to aim, and the scene is arranged to keep most
    // of the sweep rather than to pretend otherwise. Well under half would mean the effect is
    // mostly absent while the pointer moves.
    expect(threaded / positions).toBeGreaterThan(0.55);
  });

  it("keeps the wavelengths on one route, so the fan interpolates", () => {
    const solids = chainSolids();
    const bases = solids.map((s) => s.ior);
    const beam = chainBeam();
    const aim = aimBeamAtAngle(
      solids[0].outline.points,
      beam.entryAngle ?? 0,
      beam.incidence,
      beam.width,
      beam.distance,
    );
    const routes = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const nm = 380 + (750 - 380) * (i / 31);
      tune(solids, bases, nm, beam.dispersion);
      const path = traceSolids(solids, aim.origin, aim.direction);
      if (path) routes.add(`${path.solids.join(",")}|${path.edges.join(",")}`);
    }
    // Adjacent wavelengths only join into a quad when their topologies match, so a route that
    // splinters draws unconnected streaks instead of a spectrum.
    expect(routes.size).toBeLessThanOrEqual(2);
  });
});

/** One traced solid from a bare outline. */
function solid(points: THREE.Vector2[], ior = 1.5): Solid {
  return { outline: preparePolygon(points), ior };
}

/**
 * Tracing a re-entrant solid.
 *
 * The clipper the tracer has always used is Cyrus-Beck, which treats each edge as a HALF-PLANE and
 * is therefore convex-only: on a notched outline it reports crossings on the far side of the notch
 * that the ray never makes. These cover the general scan that replaces it for such shapes, and the
 * property that matters most, that the two agree wherever both are valid.
 */

describe("re-entrant cross-sections", () => {
  /** A "C" opening to the right. A ray sent UP its open side crosses glass, air, glass. */
  const C_SHAPE = [
    [-3, -3],
    [3, -3],
    [3, -2],
    [-1, -2],
    [-1, 2],
    [3, 2],
    [3, 3],
    [-3, 3],
  ].map(([x, y]) => new THREE.Vector2(x, y));

  it("knows which clipper an outline needs", () => {
    expect(preparePolygon(prismCrossSection(1, 6, 0)).convex).toBe(true);
    expect(preparePolygon(C_SHAPE).convex).toBe(false);
  });

  it("crosses the same solid twice when the ray passes through its notch", () => {
    // Straight up x = 1, which is inside the notch: the ray enters the lower arm, leaves it into
    // the gap, then enters the upper arm. Cyrus-Beck cannot express this, the notch is not a
    // half-plane of the outline, so the far arm is invisible to it.
    const path = traceSolids([solid(C_SHAPE)], new THREE.Vector2(1, -10), new THREE.Vector2(0, 1));
    expect(path).toBeDefined();
    // Entry, exit, entry, exit, four surface points, all on ONE solid.
    expect(path!.points.length).toBeGreaterThanOrEqual(4);
    expect(path!.solids.every((i) => i === 0)).toBe(true);
  });

  it("puts the notch where the geometry says it is", () => {
    // At an index of ~1 the ray barely bends, so the crossings land on the real walls: the lower
    // arm spans y = -3 to -2, the gap runs to y = 2, and the upper arm ends at y = 3.
    const path = traceSolids(
      [solid(C_SHAPE, 1.0001)],
      new THREE.Vector2(1, -10),
      new THREE.Vector2(0, 1),
    )!;
    const ys = path.points.map((p) => p.y);
    expect(ys).toHaveLength(4);
    expect(ys[0]).toBeCloseTo(-3, 2);
    expect(ys[1]).toBeCloseTo(-2, 2);
    expect(ys[2]).toBeCloseTo(2, 2);
    expect(ys[3]).toBeCloseTo(3, 2);
  });

  it("crosses once where the notch is not in the way", () => {
    // Same solid, same direction, but up its solid back, one entry and one exit.
    const path = traceSolids(
      [solid(C_SHAPE, 1.0001)],
      new THREE.Vector2(-2, -10),
      new THREE.Vector2(0, 1),
    )!;
    expect(path.points).toHaveLength(2);
    expect(path.points[0].y).toBeCloseTo(-3, 2);
    expect(path.points[1].y).toBeCloseTo(3, 2);
  });

  it("misses a solid the ray only passes beside", () => {
    expect(
      traceSolids([solid(C_SHAPE)], new THREE.Vector2(-10, 9), new THREE.Vector2(1, 0)),
    ).toBeUndefined();
  });

  it("agrees with Cyrus-Beck wherever both are valid", () => {
    // The strongest check available: a convex outline traced normally, against the same outline
    // with one collinear point nudged into a shallow reflex vertex so it takes the general scan.
    // The shapes differ by a thousandth of a unit; the traced path must not.
    const square = [
      new THREE.Vector2(-2, -2),
      new THREE.Vector2(0, -2),
      new THREE.Vector2(2, -2),
      new THREE.Vector2(2, 2),
      new THREE.Vector2(-2, 2),
    ];
    const dented = square.map((p, i) => (i === 1 ? new THREE.Vector2(0, -1.999) : p.clone()));
    expect(preparePolygon(square).convex).toBe(true);
    expect(preparePolygon(dented).convex).toBe(false);

    const origin = new THREE.Vector2(-8, -0.7);
    const direction = new THREE.Vector2(1, 0.14).normalize();
    const viaHalfPlanes = traceSolids([solid(square)], origin, direction)!;
    const viaScan = traceSolids([solid(dented)], origin, direction)!;
    expect(viaScan.points).toHaveLength(viaHalfPlanes.points.length);
    for (const [i, point] of viaHalfPlanes.points.entries()) {
      expect(viaScan.points[i].x).toBeCloseTo(point.x, 2);
      expect(viaScan.points[i].y).toBeCloseTo(point.y, 2);
    }
    expect(viaScan.direction.x).toBeCloseTo(viaHalfPlanes.direction.x, 3);
    expect(viaScan.direction.y).toBeCloseTo(viaHalfPlanes.direction.y, 3);
  });
});
