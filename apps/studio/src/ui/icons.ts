/**
 * Monochrome inline SVG icons for the Tweakpane headers and buttons.
 *
 * Tweakpane has no icon API, so the panel labels its folders and buttons with a leading emoji and
 * this module swaps them for stroke icons after the pane is built. Emoji would work, but they
 * render at whatever weight and colour the platform font decides; next to a near-white studio
 * render that reads as noise, and the same panel looks different on every OS.
 *
 * Icons are drawn on a 16×16 grid at 13px, so anything with more than a few strokes turns to mush.
 */

import { escapeHtml, injectStyle } from "../util/dom";

const STROKE = 1.5;

function svg(inner: string): string {
  return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

/** Buttons: keyed by the emoji that prefixes their title. */
const BUTTON_ICONS: Record<string, string> = {
  "🎲": svg(
    '<path d="M1.6 4.6 8 1.2l6.4 3.4L8 8 1.6 4.6Z"/><path d="M1.6 4.6v6.8L8 14.8V8"/><path d="M14.4 4.6v6.8L8 14.8"/>',
  ),
  "🔄": svg('<path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9"/><path d="M13.8 2.4v3.1h-3.1"/>'),
  "💾": svg('<path d="M8 1.9v7"/><path d="M5.2 6.2 8 9l2.8-2.8"/><path d="M2.6 12.6h10.8"/>'),
  "📂": svg('<path d="M1.9 4.3h4l1.4 1.8h6.8v6.6H1.9z"/>'),
  "📷": svg(
    '<rect x="1.9" y="4.9" width="12.2" height="8.2" rx="1.2"/><circle cx="8" cy="9" r="2.2"/><path d="M5.7 4.9 6.7 3.1h2.6l1 1.8"/>',
  ),
  "🔗": svg(
    '<path d="M6.6 9.4 9.4 6.6"/><path d="M7.3 4.7 8.5 3.5a2.5 2.5 0 0 1 3.6 3.6L10.9 8.3"/><path d="M8.7 11.3 7.5 12.5a2.5 2.5 0 0 1-3.6-3.6L5.1 7.7"/>',
  ),
  "🎬": svg(
    '<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none"/>',
  ),
  "⏹": svg(
    '<rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor" stroke="none"/>',
  ),
  "✏": svg(
    '<path d="M2.7 13.3 3.6 9.9 10.4 3.1l2.5 2.5-6.8 6.8-3.4.9Z"/><path d="M9 4.5l2.5 2.5"/>',
  ),
  "⟨⟩": svg(
    '<path d="M5.6 4.7 2.2 8l3.4 3.3"/><path d="M10.4 4.7 13.8 8l-3.4 3.3"/><path d="M9 3.6 7 12.4"/>',
  ),
  "🖥": svg(
    '<rect x="1.9" y="2.9" width="12.2" height="8.4" rx="1.2"/><path d="M5.6 14h4.8M8 11.3V14"/>',
  ),
  // A globe: the gallery is the one action that leaves this machine.
  "🌍": svg(
    '<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><ellipse cx="8" cy="8" rx="2.7" ry="6"/>',
  ),
  // A frame with a play mark: picking a video source, not recording one (that is the dot above).
  "🎞": svg(
    '<rect x="1.9" y="3.6" width="12.2" height="8.8" rx="1.2"/><path d="M6.7 6.3 10.6 8l-3.9 1.7z" fill="currentColor" stroke="none"/>',
  ),
  // A framed picture: sun over a horizon.
  "🖼": svg(
    '<rect x="1.9" y="3" width="12.2" height="10" rx="1.2"/><circle cx="10.9" cy="6.1" r="1.1"/><path d="m2.4 11.4 3.2-3.2 2.2 2 1.6-1.5 4.1 3.8"/>',
  ),
  // A reticle: "show me where this one is".
  "◎": svg(
    '<circle cx="8" cy="8" r="4.2"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2"/>',
  ),
  "⟲": svg(
    '<path d="M3 5.6V3h2.6"/><path d="M10.4 3H13v2.6"/><path d="M13 10.4V13h-2.6"/><path d="M5.6 13H3v-2.6"/>',
  ),
  "＋": svg('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  "✕": svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  "↻": svg('<path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9"/><path d="M2.2 2.4v3.1h3.1"/>'),
  // Two overlapping squares: the mark every layout tool uses for "these are one object".
  "⛓": svg(
    '<rect x="1.9" y="1.9" width="8.6" height="8.6" rx="1.2"/><path d="M5.5 12.9v.4a.8.8 0 0 0 .8.8h7a.8.8 0 0 0 .8-.8v-7a.8.8 0 0 0-.8-.8h-.4"/>',
  ),
  "⤫": svg('<path d="M2.4 2.4 7 7M9 9l4.6 4.6"/><path d="M13.6 2.4 9 7M7 9l-4.6 4.6"/>'),
};

/** Folder headers: keyed by the folder title, so titles must stay in sync with these keys. */
const FOLDER_ICONS: Record<string, string> = {
  // A dot with rays: the lamp field behind the glass.
  Lamps: svg(
    '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.7v1.6M8 12.7v1.6M1.7 8h1.6M12.7 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  ),
  // A plane behind a shape, seen in section: the backplate the refracted ray is cast at.
  Backplate: svg('<path d="M2 3.4h12v8.2H2z"/><path d="M5.6 6.2h4.8v6.4H5.6z" fill="#0000"/>'),
  Camera: svg(
    '<rect x="1.9" y="4.9" width="12.2" height="8.2" rx="1.2"/><circle cx="8" cy="9" r="2.2"/><path d="M5.7 4.9 6.7 3.1h2.6l1 1.8"/>',
  ),
  // An aperture blade ring: the post stack is mostly depth of field.
  Post: svg(
    '<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4 5.2 12.6M8 2.4l5.2 7.4M2.8 9.8h10.4"/>',
  ),
  // A rod, a disc and a hex in a row.
  Shapes: svg(
    '<rect x="1.8" y="3.4" width="2.6" height="9.2" rx="1.3"/><ellipse cx="8.4" cy="8" rx="2.3" ry="4.6"/><path d="M13 4.6l1.4.9v3l-1.4.9-1.4-.9v-3z"/>',
  ),
  // A leaning barrel and its arc: a shape rolling on a shared axis.
  Motion: svg(
    '<path d="M2.2 11.4c3.4-4.6 8.2-4.6 11.6 0"/><path d="M3 13.2h10"/><path d="M8 4.2v3"/>',
  ),
  Scene: svg(
    '<rect x="2" y="2.8" width="12" height="10.4" rx="1.4"/><circle cx="10.8" cy="5.8" r="1.2"/><path d="m2.5 11 3.2-3.2 2.2 2 1.6-1.5 4 3.7"/>',
  ),
  Material: svg('<path d="m8 1.9 1.4 4.1 4.1 1-4.1 1L8 12.1 6.6 8l-4.1-1 4.1-1z"/>'),
  Output: svg('<path d="M2 3.2h12v9.6H2z"/><path d="M5.2 12.8v1.5M10.8 12.8v1.5M4 14.3h8"/>'),
  Actions: svg('<path d="M8.5 1.6 3 9h3.4L7 14.4 13 7H9.6z"/>'),
  // A framed grid: the preview aids, not the scene.
  View: svg(
    '<rect x="2" y="2.6" width="12" height="10.8" rx="1.3"/><path d="M6 2.6v10.8M10 2.6v10.8M2 6.2h12M2 9.8h12"/>',
  ),
  Performance: svg(
    '<path d="M2.4 11.6a6 6 0 1 1 11.2 0"/><path d="M8 11.6 10.9 6.9"/><circle cx="8" cy="11.6" r=".9" fill="currentColor" stroke="none"/>',
  ),
};

/**
 * Gesture icons for the controls tooltip. A mouse body with the relevant button filled in says
 * "this button" faster than the words do, which is the whole point of a hover cheatsheet.
 *
 * Drawn on the same 16×16 grid, but with a heavier stroke than the panel icons: these sit on a
 * dark tooltip, where a hairline disappears.
 */
function mouse(inner: string): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="1.5" width="9" height="13" rx="4.5"/>${inner}</svg>`;
}

/** A filled QUARTER of the mouse body, centre line out to the edge, down to where the buttons
 *  end. A smaller mark reads as a smudge at this size rather than as "this button". */
const LEFT_BUTTON =
  '<path d="M8 1.55v5.4H3.55V6A4.45 4.45 0 0 1 8 1.55Z" fill="currentColor" stroke="none"/>';
const RIGHT_BUTTON =
  '<path d="M8 1.55v5.4h4.45V6A4.45 4.45 0 0 0 8 1.55Z" fill="currentColor" stroke="none"/>';
const DIVIDER = '<path d="M3.6 6.95h8.8"/>';

export const GESTURE_ICONS = {
  /** Left button filled. */
  left: mouse(`${LEFT_BUTTON}${DIVIDER}`),
  /** Right button filled. */
  right: mouse(`${RIGHT_BUTTON}${DIVIDER}`),
  /** Scroll wheel filled, both buttons empty. */
  wheel: mouse(
    `${DIVIDER}<path d="M8 1.6v5.3"/><rect x="7.1" y="2.6" width="1.8" height="3.2" rx=".9" fill="currentColor" stroke="none"/>`,
  ),
  /** A selection box with its corner handles: the scale affordance. */
  handles: svg(
    '<rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1"/><rect x="1.7" y="1.7" width="3.2" height="3.2" rx=".6" fill="currentColor" stroke="none"/><rect x="11.1" y="11.1" width="3.2" height="3.2" rx=".6" fill="currentColor" stroke="none"/>',
  ),
  /** A keycap. */
  key: svg('<rect x="1.6" y="4.2" width="12.8" height="7.6" rx="1.8"/><path d="M4.9 8h6.2"/>'),
};

const STYLE_ID = "g3-icon-style";
const CSS =
  ".g3-ic{display:inline-flex;align-items:center;vertical-align:-2px;margin-right:6px;opacity:.8}";

/** A group's folder header, keyed by CLASS rather than by title: a group's title is whatever the
 *  author called it, so there is no fixed name to look up. Same mark as the group button. */
const GROUP_ICON = BUTTON_ICONS["⛓"];

/**
 * Swap leading emoji on buttons, and add an icon to each folder header, inside `container`.
 * Idempotent: safe to re-run after a label changes (the export button retitles itself when the
 * image format changes).
 *
 * Folder titles and button labels can carry user-authored text (a group's name reaches its folder
 * title verbatim, and configs arrive from share URLs and pasted JSON), so anything read back off
 * the pane is escaped before it is re-inserted through `innerHTML`.
 */
export function applyIcons(container: HTMLElement): void {
  injectStyle(STYLE_ID, CSS);

  for (const el of container.querySelectorAll<HTMLElement>(".tp-btnv_t")) {
    const text = el.textContent ?? "";
    for (const [emoji, icon] of Object.entries(BUTTON_ICONS)) {
      if (!text.startsWith(emoji)) continue;
      // Strip the emoji plus any leftover variation selector (U+FE0F) and spaces, so only the
      // label follows the icon.
      el.innerHTML = `<span class="g3-ic">${icon}</span>${escapeHtml(
        text.slice(emoji.length).replace(/^[️\s]+/, ""),
      )}`;
      break;
    }
  }

  for (const el of container.querySelectorAll<HTMLElement>(".tp-fldv_t")) {
    const text = (el.textContent ?? "").trim();
    // Titles carry a live count ("Shapes · 16"); look the icon up by the name alone.
    const icon = el.closest(".tp-fldv")?.classList.contains("g3-group")
      ? GROUP_ICON
      : FOLDER_ICONS[text.split("\u00b7")[0].trim()];
    if (icon && !el.querySelector(".g3-ic")) {
      el.innerHTML = `<span class="g3-ic">${icon}</span>${escapeHtml(text)}`;
    }
  }
}
