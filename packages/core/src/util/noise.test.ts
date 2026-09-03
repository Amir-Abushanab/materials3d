import { describe, expect, it } from "vitest";
import { fbmSimplex3d, simplex3d } from "./noise";

const sines = (x: number, y: number, z: number) =>
  Math.sin(x * 1.7) * Math.sin(y * 1.3) * Math.sin(z * 2.1);
const autocorrelation = (f: (x: number, y: number, z: number) => number, lag: number) => {
  let sum = 0;
  let energy = 0;
  for (let i = 0; i < 4000; i++) {
    const x = i * 0.037;
    const a = f(x, 0.4, 0.9);
    sum += a * f(x + lag, 0.4, 0.9);
    energy += a * a;
  }
  return Math.abs(sum / Math.max(energy, 1e-9));
};

describe("simplex3d", () => {
  it("stays inside the reference's proven bound", () => {
    // Their normalizer is chosen so the field never clips: raw sup 0.0130071572 against a factor
    // of 76 gives 0.98854. A port that drifts past 1 has almost certainly lost the kernel radius
    // or the gradient set, and the symptom downstream is a shape that clamps flat at its extremes
    // rather than anything that looks like noise.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 60000; i++) {
      const v = simplex3d(
        ((i * 0.113) % 97) - 48,
        ((i * 0.271) % 89) - 44,
        ((i * 0.577) % 83) - 41,
      );
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(Math.max(Math.abs(lo), Math.abs(hi))).toBeLessThanOrEqual(0.98854);
    // And it must actually use the range, a bound satisfied by returning zero is not a test.
    expect(hi).toBeGreaterThan(0.5);
    expect(lo).toBeLessThan(-0.5);
  });

  it("is continuous across a simplex face", () => {
    // The reason the reference pins the kernel radius at 0.5 rather than the widespread 0.6: at
    // 0.6 the corner the four-corner traversal drops still carries weight, and dropping it is a
    // visible crack. Stepping across a lattice boundary is where that shows.
    for (const axis of [0, 1, 2]) {
      const p = [1.0, 0.3, 0.7];
      const before = simplex3d(p[0], p[1], p[2]);
      p[axis] -= 1e-7;
      expect(Math.abs(simplex3d(p[0], p[1], p[2]) - before)).toBeLessThan(1e-5);
    }
  });

  it("has no axis-aligned structure, which is the whole reason it replaced the sines", () => {
    // A product of sines, what the blob used before, has its zeros on a regular lattice, so a
    // field sampled along an axis correlates strongly with itself one period later. Simplex does
    // not. Comparing the two directly is the only check that speaks to the actual defect.
    // One full period of the sine field along x.
    const lag = (2 * Math.PI) / 1.7;
    expect(autocorrelation(sines, lag)).toBeGreaterThan(0.9);
    expect(autocorrelation(simplex3d, lag)).toBeLessThan(0.3);
  });

  it("is deterministic and seed-separable", () => {
    // Pinned rather than compared with itself: the same coordinates must give the same lump on
    // every machine and in every export, and a port that drifts in its hash or its kernel moves
    // this value.
    expect(simplex3d(1.5, -2.25, 0.75)).toBeCloseTo(-0.25048828125, 12);
    // Different seeds must not rhyme. The integer hash gives a 2^32-cell period where the folklore
    // float hash repeats every 289 cells, which at blob scale is close enough to be visible.
    const a = Array.from({ length: 64 }, (_, i) => simplex3d(i * 0.3, 11.0, 0.5));
    const b = Array.from({ length: 64 }, (_, i) => simplex3d(i * 0.3, 900.0, 0.5));
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0) * b.reduce((s, v) => s + v * v, 0));
    expect(Math.abs(dot / norm)).toBeLessThan(0.3);
  });
});

describe("fbmSimplex3d", () => {
  it("is exactly simplex3d at one octave", () => {
    expect(fbmSimplex3d(0.3, 0.6, 0.9, 1)).toBeCloseTo(simplex3d(0.3, 0.6, 0.9), 12);
  });

  it("keeps the bound through the octaves", () => {
    let peak = 0;
    for (let i = 0; i < 20000; i++) {
      const v = fbmSimplex3d(((i * 0.19) % 71) - 35, ((i * 0.41) % 67) - 33, ((i * 0.7) % 61) - 30);
      peak = Math.max(peak, Math.abs(v));
    }
    // Amplitude normalization is what carries the guarantee through, rather than hoping the sum
    // stays small.
    expect(peak).toBeLessThanOrEqual(1);
  });
});
