/** Display names for the shipped presets. One copy, because the picker, the history labels and
 *  the export filenames all name the same thing. Anything unlisted falls back to its key. */
export const PRESET_LABELS: Record<string, string> = {
  skewer: "Skewer",
  assembly: "Assembly",
  staircase: "Staircase",
  slimes: "Slimes",
  reactions: "Reactions",
  materials: "Materials",
  spectacles: "Spectacles",
};

export function presetLabel(name: string): string {
  return PRESET_LABELS[name] ?? name;
}
