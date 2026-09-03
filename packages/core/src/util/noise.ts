/**
 * Simplex noise on the skewed simplicial lattice, adapted from Vercel's `@vgpu/wgsl-std` (MIT,
 * see THIRD-PARTY-NOTICES.md). Algorithms are Perlin 2001 / Gustavson's "Simplex noise
 * demystified"; this is a TypeScript transcription of their WGSL, not of any GLSL original.
 *
 * It exists because the alternative is worse in a specific way. A field built from a product of
 * sines, which is what this replaced, has its zeros on a regular lattice and its extrema on
 * another, so anything displaced by it acquires structure aligned to the axes. On a shape meant to
 * read as organic that is exactly the wrong artefact, and no amount of octave stacking removes it
 * because every octave has the same alignment.
 *
 * Two of their decisions are load-bearing and deliberately kept:
 *
 *   The kernel radius squared is 0.5, not the widespread 0.6. Their note is precise about why: at
 *   0.6 the support radius exceeds the four-corner traversal's reach, so the corner the traversal
 *   drops still carries weight and dropping it is a C0 crack. At 0.5 that corner contributes
 *   exactly zero with vanishing first and second derivatives, so the field stays smooth across
 *   every simplex face.
 *
 *   Gradients come from an integer hash rather than a permutation table, which gives a 2^32-cell
 *   period instead of the folklore period-289 float hash, worth having here because a blob is
 *   seeded and a short period would make different seeds visibly rhyme.
 */

/** (sqrt(3) - 1) / 2 and friends, as literals, the reference spells them out for determinism. */
const F3 = 1 / 3;
const G3 = 1 / 6;
const G3_2 = 1 / 3;
const G3_3 = 0.5;

/** Their pcg3d, in 32-bit integer arithmetic. */
function pcg3d(x: number, y: number, z: number): number {
  let hx = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  let hy = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  let hz = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  hx = (hx + Math.imul(hy, hz)) >>> 0;
  hy = (hy + Math.imul(hz, hx)) >>> 0;
  hz = (hz + Math.imul(hx, hy)) >>> 0;
  hx ^= hx >>> 16;
  hy ^= hy >>> 16;
  hz ^= hz >>> 16;
  hx = (hx + Math.imul(hy, hz)) >>> 0;
  return hx >>> 0;
}

/**
 * Perlin's twelve cube-edge gradients, dotted with `d`.
 *
 * The pair index picks which two components take part and the low bits are their signs, so the
 * whole dot product is an add and two negations, no table, no multiplies.
 */
function gradDot3(index: number, dx: number, dy: number, dz: number): number {
  const pair = Math.floor(index / 4);
  const a = pair === 2 ? dy : dx;
  const b = pair === 2 ? dz : pair === 1 ? dz : dy;
  const sa = (index & 1) !== 0 ? -a : a;
  const sb = (index & 2) !== 0 ? -b : b;
  return sa + sb;
}

function kernel(cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): number {
  const t = 0.5 - (dx * dx + dy * dy + dz * dz);
  if (t <= 0) return 0;
  const t2 = t * t;
  return t2 * t2 * gradDot3(pcg3d(cx, cy, cz) % 12, dx, dy, dz);
}

/** Simplex noise in three dimensions. Bounded by ±0.98854 for every finite input. */
export function simplex3d(x: number, y: number, z: number): number {
  const skew = (x + y + z) * F3;
  const bx = Math.floor(x + skew);
  const by = Math.floor(y + skew);
  const bz = Math.floor(z + skew);
  const unskew = (bx + by + bz) * G3;
  const d0x = x - (bx - unskew);
  const d0y = y - (by - unskew);
  const d0z = z - (bz - unskew);

  // The ranking of d0's components, which is the classic error-prone step. Each branch names an
  // ordering; collapsing them into arithmetic on comparisons swaps a corner for at least one of
  // the six, which a statistical test would not catch.
  let o1x = 0;
  let o1y = 0;
  let o1z = 0;
  let o2x = 0;
  let o2y = 0;
  let o2z = 0;
  if (d0x >= d0y) {
    if (d0y >= d0z) {
      o1x = 1;
      o2x = 1;
      o2y = 1;
    } else if (d0x >= d0z) {
      o1x = 1;
      o2x = 1;
      o2z = 1;
    } else {
      o1z = 1;
      o2x = 1;
      o2z = 1;
    }
  } else if (d0y < d0z) {
    o1z = 1;
    o2y = 1;
    o2z = 1;
  } else if (d0x < d0z) {
    o1y = 1;
    o2y = 1;
    o2z = 1;
  } else {
    o1y = 1;
    o2x = 1;
    o2y = 1;
  }

  let total = kernel(bx, by, bz, d0x, d0y, d0z);
  total += kernel(bx + o1x, by + o1y, bz + o1z, d0x - o1x + G3, d0y - o1y + G3, d0z - o1z + G3);
  total += kernel(
    bx + o2x,
    by + o2y,
    bz + o2z,
    d0x - o2x + G3_2,
    d0y - o2y + G3_2,
    d0z - o2z + G3_2,
  );
  total += kernel(bx + 1, by + 1, bz + 1, d0x - 1 + G3_3, d0y - 1 + G3_3, d0z - 1 + G3_3);
  // Their normalizer: the raw supremum is 0.0130071572, so 76 sits just under 1/sup and the result
  // is never clipped. The folkloric webgl-noise factors exceed 1 and force callers to clamp.
  return 76 * total;
}

/**
 * Amplitude-normalized fBm. Dividing by the summed amplitudes is what carries the ±1 bound
 * through the octaves rather than merely hoping the sum stays small.
 */
export function fbmSimplex3d(
  x: number,
  y: number,
  z: number,
  octaves = 3,
  lacunarity = 2.05,
  gain = 0.5,
): number {
  let sum = 0;
  let amplitude = 1;
  let weight = 0;
  let frequency = 1;
  for (let i = 0; i < Math.max(1, Math.min(16, octaves)); i++) {
    sum += amplitude * simplex3d(x * frequency, y * frequency, z * frequency);
    weight += amplitude;
    amplitude *= Math.max(0, Math.min(1, gain));
    frequency *= lacunarity;
  }
  return sum / Math.max(weight, 1e-6);
}
