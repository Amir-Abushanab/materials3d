/** Terse typed DOM lookups. Throws on a missing id: every one of these is in index.html, so a
 *  miss is a build mistake, not a runtime condition to handle. */
export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export function on<K extends keyof HTMLElementEventMap>(
  el: HTMLElement | Document | Window,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  el.addEventListener(type, handler as EventListener);
}

/**
 * Add a stylesheet to the document once. Modules that build their own DOM (overlays, editors,
 * the icon pass) ship their CSS this way so the studio stylesheet need not know they exist; the
 * id keeps a second instance, or a second import under HMR, from stacking a duplicate.
 */
export function injectStyle(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for `innerHTML`. Covers attribute context too, so one helper serves every site. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Is the focus somewhere that types or picks, where a bare key belongs to the control? */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return true;
  const role = target.getAttribute("role");
  return role === "listbox" || role === "combobox" || role === "textbox";
}

/**
 * Whether a keyboard shortcut should stand down for this event.
 *
 * One answer for every shortcut in the studio, so the panel's `<select>`s, the search field, the
 * code dialog and a held-down key are handled the same way everywhere. `allowRepeat` is for undo
 * and redo, where holding the key down to step back several times is the expected behaviour.
 */
export function shortcutBlocked(event: KeyboardEvent, allowRepeat = false): boolean {
  if (event.repeat && !allowRepeat) return true;
  if (document.querySelector("dialog[open]")) return true;
  return isEditableTarget(event.target);
}
