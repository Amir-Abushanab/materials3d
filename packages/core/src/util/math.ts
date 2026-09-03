/** Shared numeric helpers. Dependency-free, a private copy so the renderer core carries no
 *  cross-package imports (the studio keeps its own copy under apps/studio/src/util). */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * mulberry32, a small, fast, seedable PRNG. Scene scatter has to be reproducible: the same
 * config must generate the same rods on every machine and in every export, or the poster
 * captured at build time would not match what the browser renders.
 */
export function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
