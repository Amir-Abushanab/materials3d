/**
 * Filtering the control panel down to what a search matches.
 *
 * Separated from `ControlPanel` because it is the one part of the panel that is a pure function of
 * DOM plus a string, and therefore the one part worth testing directly: the panel itself needs a
 * live Tweakpane and a real config to exist at all, and a filter that quietly stops matching is
 * exactly the sort of thing nobody notices until they need it.
 *
 * It only ever decides what SHOWS. Tweakpane owns this DOM and rebuilds it wholesale whenever the
 * shape list changes, so anything that restructured it would be undone without warning — and worse,
 * would be undone silently.
 */

/** Applied rather than removing nodes; see the note above. */
export const HIDDEN_CLASS = "tp-search-hidden";

const FOLDER = "tp-fldv";
const FOLDER_TITLE = ".tp-fldv_t";
const FOLDER_BODY = ".tp-fldv_c";
const LABEL = ".tp-lblv_l";
/** Buttons carry their text here instead of in a label. */
const BUTTON = ".tp-btnv_b";

/** Undo any filtering, leaving the panel exactly as Tweakpane drew it. */
export function clearSearch(host: Element): void {
  for (const el of host.querySelectorAll(`.${HIDDEN_CLASS}`)) el.classList.remove(HIDDEN_CLASS);
}

const text = (el: Element | null | undefined): string => (el?.textContent ?? "").toLowerCase();

/**
 * Hide every control the query does not reach, and report the folders that should be opened.
 *
 * A folder survives if its own title matches OR it contains a match, and a folder matching by
 * title keeps ALL of its contents: searching "post" should hand back that section intact rather
 * than an empty folder with a matching name.
 *
 * Returns the folders worth revealing rather than revealing them, because opening one is a
 * Tweakpane concern — the caller drives it through the same toggle a person would click.
 */
export function applySearch(host: Element, query: string): HTMLElement[] {
  const needle = query.trim().toLowerCase();
  clearSearch(host);
  if (!needle) return [];

  const reveal: HTMLElement[] = [];

  // Depth-first: a folder can only be judged once its children have been.
  const walk = (container: Element, inherited: boolean): boolean => {
    let anyVisible = false;
    for (const child of Array.from(container.children)) {
      if (child.classList.contains(FOLDER)) {
        const self = text(child.querySelector(FOLDER_TITLE)).includes(needle);
        const body = child.querySelector(FOLDER_BODY);
        const inside = body ? walk(body, inherited || self) : false;
        const keep = self || inside;
        child.classList.toggle(HIDDEN_CLASS, !keep);
        if (keep) {
          anyVisible = true;
          reveal.push(child as HTMLElement);
        }
        continue;
      }
      // The label, or a button's own text — buttons carry no label. Deliberately NOT the row's
      // whole text: that would match VALUES too, so searching "0.5" would surface every slider
      // that happens to sit there, and a renamed Tweakpane class would degrade to that silently
      // instead of failing.
      const label = text(child.querySelector(LABEL)) || text(child.querySelector(BUTTON));
      const keep = inherited || label.includes(needle);
      child.classList.toggle(HIDDEN_CLASS, !keep);
      if (keep) anyVisible = true;
    }
    return anyVisible;
  };

  walk(host.querySelector(".tp-rotv_c") ?? host, false);
  return reveal;
}
