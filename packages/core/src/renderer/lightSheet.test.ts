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
  return {
    polygon: crossSectionFor("prism", beam.radius, beam.sides, beam.rotation)!,
    ...aimBeamAtAngle(
      crossSectionFor("prism", beam.radius, beam.sides, beam.rotation)!,
      beam.entryAngle ?? 0,
      beam.incidence,
      beam.width,
      beam.distance,
    ),
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
   * near 555nm, so a real spectrum is far brighter in the green than at either end — which is what
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
    // Either it escapes after reflecting, or it never escapes at all — both mean bounces > 0.
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
    // One white quad PER SLICE — the entry face is slanted, so the slices cannot share one quad.
    expect(geometry.getAttribute("position").count).toBe(o.slices * 6);
  });

  /**
   * The regression this file exists for.
   *
   * The preset's entry angle is eight degrees above horizontal, and that is load-bearing: level or
   * downward puts the internal ray past the critical angle at the exit face, so the violet half of
   * the spectrum totally internally reflects out through the base while the red half leaves
   * normally, and the rainbow splits into two unrelated streaks. It is a convincing-looking
   * failure — the frame is still full of colour — so it needs a test rather than an eye.
   */
  /**
   * The pointer sweeps incidence across the critical angle on purpose, so what has to hold over
   * the whole range is not "never bounces" — it is that every position produces a beam that is
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
   * reflects — and the tracer has to follow that rather than dropping the ray, or the low end of
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
   * Subdivision invariance — the point of dividing flux by the Jacobian.
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
});

describe("crossSectionFor", () => {
  it("follows the mesh's own segment count", () => {
    // A lathe with 72 segments is a 72-gon optically as well as visually. Tracing some other
    // number puts the bend a fraction of a degree off the edge it is drawn on, and refracts a
    // deliberately faceted low-poly shape as if it were smooth.
    expect(crossSectionFor("sphere", 1, 72, Math.PI / 2)!).toHaveLength(72);
    expect(crossSectionFor("rod", 1, 16, Math.PI / 2)!).toHaveLength(16);
    expect(crossSectionFor("prism", 1, 3, Math.PI / 2)!).toHaveLength(3);
  });

  it("refuses the kinds whose slice is not a convex polygon", () => {
    // Returning a circle for these is not a rough approximation, it is a different solid — and the
    // tracer's clipping assumes convexity, so it would report crossings that are not there.
    for (const kind of ["ring", "slab", "arrow", "blob"]) {
      expect(crossSectionFor(kind, 1, 72, Math.PI / 2)).toBeUndefined();
    }
  });

  it("slices a cone at its half-height, not its base", () => {
    const [first] = crossSectionFor("cone", 2, 72, 0)!;
    expect(Math.hypot(first.x, first.y)).toBeCloseTo(1, 9);
  });

  it("puts the outline where the solid is", () => {
    const moved = crossSectionFor("prism", 1, 3, Math.PI / 2, { x: 5, y: -2 })!;
    expect(moved[0].x).toBeCloseTo(5, 9);
    expect(moved[0].y).toBeCloseTo(-1, 9);
    // Still regular about its own centre, which is what keeps the angular fast path available.
    expect(preparePolygon(moved).regular).toBe(true);
  });

  it("ignores the field on a hex, whose builder does too", () => {
    expect(crossSectionFor("hex", 1, 3, Math.PI / 2)).toHaveLength(6);
    expect(crossSectionFor("hex", 1, 72, Math.PI / 2)!).toHaveLength(6);
  });

  it("matches the lathe's own vertex angles", () => {
    // LatheGeometry sweeps from 0 and the item is rotated -90 about X, which puts a vertex at the
    // top in world XY. If these disagree the beam refracts through a solid that is rotated off
    // the visible one, and the error is a few degrees — visible, and hard to attribute.
    const [apex] = crossSectionFor("prism", 4, 3, Math.PI / 2)!;
    expect(apex.x).toBeCloseTo(0, 9);
    expect(apex.y).toBeCloseTo(4, 9);
  });
});

describe("aimBeamAtAngle", () => {
  const triangle = crossSectionFor("prism", 1, 3, Math.PI / 2)!;

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
    const hexagon = crossSectionFor("hex", 1, 6, Math.PI / 2)!;
    const width = 0.08;
    const { origin, direction } = aimBeamAtAngle(hexagon, 90, 0, width, 5);
    const hit = origin.clone().addScaledVector(direction, 5);
    const nearest = Math.min(...hexagon.map((v) => v.distanceTo(hit)));
    expect(nearest).toBeGreaterThan(width);
  });

  it("is continuous across a face boundary, unlike a face index", () => {
    // The point this parameterization exists for: sweeping the bearing walks the outline instead
    // of jumping when it crosses a vertex.
    const circle = crossSectionFor("sphere", 1, 3, Math.PI / 2)!;
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
    // falling back to the full scan when it does not. This pins BOTH halves — that the two paths
    // are indistinguishable, and that the fast one really fires, since a window that silently
    // never triggered would pass an agreement test trivially.
    const smooth = crossSectionFor("sphere", 1, 72, Math.PI / 2)!;
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

/** The three outlines the `cascade` scene puts in the light's way, in world space. */
function cascadeSolids() {
  const scene = ensureSceneConfig(PRESETS.cascade());
  const beam = scene.beam!;
  const named = (name: string) => scene.items.find((i) => i.name === name)!;
  return (beam.targets ?? []).map((name) => {
    const item = named(name);
    const polygon = crossSectionFor(
      item.shape.kind,
      item.shape.r,
      item.shape.sides,
      beam.rotation + item.rotation.z,
      { x: item.position.x, y: item.position.y },
    )!;
    return { outline: preparePolygon(polygon), ior: item.material.ior ?? 1.5 };
  });
}

/** Retune every solid to one wavelength. The BASE indices are passed in, because `Solid.ior` is
 *  overwritten in place and reading it back would compound the dispersion sample by sample. */
function tune(solids: Solid[], base: number[], nm: number, dispersion: number): void {
  for (const [i, s] of solids.entries()) s.ior = iorAt(nm, base[i], dispersion);
}

describe("the cascade preset's route", () => {
  it("threads all three solids across the whole pointer sweep", () => {
    // The point of the scene, and the thing that silently stops being true. A chain only looks
    // like a chain while the light actually reaches every link; miss the second shape and it
    // degrades to a single prism with no error anywhere.
    const scene = ensureSceneConfig(PRESETS.cascade());
    const beam = scene.beam!;
    const solids = cascadeSolids();
    const bases = solids.map((s) => s.ior);
    let threaded = 0;
    let positions = 0;
    for (let e = 0; e <= 1.0001; e += 0.125) {
      for (let y = 0; y <= 1.0001; y += 0.25) {
        positions++;
        const incidence = -27 + (-43 - -27) * y;
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
    const solids = cascadeSolids();
    const bases = solids.map((s) => s.ior);
    const beam = ensureSceneConfig(PRESETS.cascade()).beam!;
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
