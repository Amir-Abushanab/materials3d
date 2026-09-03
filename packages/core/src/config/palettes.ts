/**
 * Named lamp palettes.
 *
 * Materials3D has no surface-mapped palette: a shape's colour is not painted on, it is the LAMP
 * FIELD behind the glass, seen through it. So a palette here is a set of lamp colours.
 *
 * `reference` is the measured one, the colours the whole renderer was calibrated against. The
 * others deliberately leave that family; see the hue-distribution note in the studio's randomizer
 * for why the reference has no green and no cyan at all, and why an evenly-swept palette never
 * reproduces it.
 *
 * Colours are display-space hex, like every other colour in the config.
 */
export const LAMP_PALETTES = {
  // The shipped default: warm through magenta into blue-violet.
  reference: [
    "#f8c852",
    "#f59d3e",
    "#ef5a4d",
    "#ea4776",
    "#e55392",
    "#d45cb4",
    "#b461cb",
    "#8a72d6",
    "#c4d368",
    "#719cdd",
  ],
  // Warm only, sunset through amber, no cool end at all.
  ember: ["#ffd166", "#f9a03f", "#f4713b", "#e8543f", "#d63f4e", "#b8325f", "#f2b544", "#ff8c42"],
  // Cool only. The counterpart to `ember`, and the one that most changes the glass's character.
  glacier: ["#7ee8fa", "#61c3f2", "#5a9ee8", "#6f7fdc", "#8a72d6", "#4fd1c5", "#5eead4", "#93c5fd"],
  // Deep and saturated, for a dark backdrop rather than the near-white studio.
  nocturne: [
    "#5b21b6",
    "#7c3aed",
    "#a21caf",
    "#c026d3",
    "#db2777",
    "#4338ca",
    "#6d28d9",
    "#9333ea",
  ],
  // Pale and low-chroma, the glass reads as glass rather than as coloured light.
  bone: ["#f5efe6", "#e8dfd0", "#dcd3c4", "#cfc7bd", "#e3d9c9", "#efe7db", "#d8cfc0", "#f0e9de"],
  // Primary-ish and deliberately unsubtle.
  signal: ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#007aff", "#5856d6", "#af52de", "#ff2d55"],
} as const satisfies Record<string, readonly string[]>;

/** The name of a shipped lamp palette. */
export type LampPaletteName = keyof typeof LAMP_PALETTES;

export const LAMP_PALETTE_NAMES = Object.keys(LAMP_PALETTES) as LampPaletteName[];

/** True for a string that names a shipped palette. */
export function isLampPaletteName(name: string): name is LampPaletteName {
  return Object.hasOwn(LAMP_PALETTES, name);
}

/**
 * Recolour a lamp field from a palette, in place, leaving every position and radius alone.
 *
 * The palette cycles when there are more lamps than colours: the arrangement is the composition and
 * the palette is only its colour, so changing one must never move the other.
 */
export function applyLampPalette(lamps: { color: string }[], name: string): void {
  if (!isLampPaletteName(name)) return;
  const palette: readonly string[] = LAMP_PALETTES[name];
  for (const [index, lamp] of lamps.entries()) lamp.color = palette[index % palette.length];
}
