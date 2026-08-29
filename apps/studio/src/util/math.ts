/** Studio-local numeric helpers (the core keeps its own copy, so neither reaches into the other). */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
