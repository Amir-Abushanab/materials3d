/**
 * What the two gradient editors have in common: their small DOM builders, and the pointer and
 * keyboard lifecycle of a draggable handle. The two editors had drifted into two copies of this;
 * one copy means one set of accessibility behaviour.
 */

export function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

export function makeColorInput(label: string, onInput: (value: string) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "color";
  el.setAttribute("aria-label", label);
  el.addEventListener("input", () => onInput(el.value));
  return el;
}

/** Three decimals: the precision a drag can steer to, and short enough to read in the config. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface HandleHooks {
  onDown(event: PointerEvent): void;
  onMove(event: PointerEvent): void;
  /** Arrow-key nudge: dx and dy are each -1, 0 or 1; `coarse` is shift held. */
  onNudge(dx: number, dy: number, coarse: boolean): void;
  /** Double-click removes the handle. */
  onRemove(): void;
}

/**
 * A draggable handle: a real `<button>`, so it is focusable and the arrow keys can nudge it, with
 * pointer capture for the drag. Returns the element; the caller positions and styles it.
 */
export function makeHandle(
  className: string,
  label: string,
  hooks: HandleHooks,
): HTMLButtonElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = className;
  handle.setAttribute("aria-label", label);
  let dragging = false;
  const release = (event: PointerEvent): void => {
    dragging = false;
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already have been released; nothing to undo.
    }
  };
  handle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    hooks.onDown(event);
  });
  handle.addEventListener("pointermove", (event) => {
    if (dragging) hooks.onMove(event);
  });
  handle.addEventListener("pointerup", release);
  // Backstop (same as OutputResizeHandle): the OS stealing the pointer mid-drag would otherwise
  // leave `dragging` set, and the next hover would drag with no button held.
  handle.addEventListener("pointercancel", release);
  handle.addEventListener("lostpointercapture", release);
  handle.addEventListener("keydown", (event) => {
    const dx = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const dy = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (dx === 0 && dy === 0) return;
    event.preventDefault();
    hooks.onNudge(dx, dy, event.shiftKey);
  });
  handle.addEventListener("dblclick", (event) => {
    event.stopPropagation(); // the bar's own dblclick would otherwise add one straight back
    hooks.onRemove();
  });
  return handle;
}
