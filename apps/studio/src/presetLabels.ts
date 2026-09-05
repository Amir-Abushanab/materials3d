/** Display names for the shipped presets. One copy, because the picker, the history labels and
 *  the export filenames all name the same thing. Anything unlisted is its key, capitalised, so a
 *  new preset shows up with a readable name rather than waiting on an entry here. */
const PRESET_LABELS: Record<string, string> = {
  skewer: "Skewer",
  assembly: "Assembly",
  staircase: "Staircase",
  slimes: "Slimes",
  reactions: "Reactions",
  materials: "Materials",
  prism: "Prism",
  knot: "Knot",
};

export function presetLabel(name: string): string {
  return PRESET_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}
