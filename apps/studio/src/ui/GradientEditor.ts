/**
 * A CSS-gradient-style stop editor: a bar with one draggable dot per colour stop.
 *
 * Drag a dot to move it (the spacing IS the design — it decides how fast one colour becomes the
 * next); drag one past another to reorder. Click a dot to select and recolour it, double-click the
 * bar to add a stop, double-click a dot to remove it.
 *
 * Ported from Wave Studio. It mutates the supplied `ColorStop[]` in place and calls `onChange`, so
 * the renderer re-reads the palette. Array ORDER is irrelevant — the shader walks the stops sorted
 * by position, and so does the preview here.
 */
import { parseHex, toHex, type ColorStop } from "@materials3d/core";
import { clamp } from "../util/math";

const STYLE_ID = "g3-gradient-editor-style";

const CSS = `
.g3-ge{display:flex;flex-direction:column;gap:6px;padding:2px 8px 6px;}
.g3-ge-bar{position:relative;height:24px;border-radius:4px;cursor:copy;
  border:1px solid var(--hair);box-shadow:inset 0 0 0 1px rgb(255 255 255 / 45%);touch-action:none;}
.g3-ge-handle{position:absolute;top:50%;width:13px;height:13px;border-radius:50%;
  transform:translate(-50%,-50%);border:2px solid #fff;cursor:ew-resize;box-sizing:border-box;
  box-shadow:0 1px 3px rgb(27 26 31 / 45%);touch-action:none;}
.g3-ge-handle.is-selected{border-color:var(--accent);width:16px;height:16px;
  box-shadow:0 0 0 2px rgb(162 75 200 / 45%);}
.g3-ge-row{display:flex;align-items:center;gap:6px;}
.g3-ge-row input[type=color]{width:36px;height:22px;padding:0;border-radius:4px;cursor:pointer;
  border:1px solid var(--hair);background:none;}
.g3-ge-pos{font-size:11px;color:var(--ink-2);min-width:32px;text-align:right;
  font-variant-numeric:tabular-nums;}
.g3-ge-row button{flex:1;height:22px;font-size:11px;color:var(--ink);cursor:pointer;
  border-radius:4px;background:rgb(27 26 31 / 5%);border:1px solid var(--hair);}
.g3-ge-row button:disabled{opacity:0.4;cursor:default;}
`;

export interface GradientEditorHooks {
  /** Called whenever a stop's colour or position changes. */
  onChange: () => void;
  /** Maximum number of stops. */
  max: number;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Colour partway between two hex values, in the display space the whole renderer authors in. */
function mixHex(a: string, b: string, t: number): string {
  const from = parseHex(a);
  const to = parseHex(b);
  return toHex([
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ]);
}

export class GradientEditor {
  private readonly root: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly colorInput: HTMLInputElement;
  private readonly posLabel: HTMLDivElement;
  private readonly addButton: HTMLButtonElement;
  private readonly removeButton: HTMLButtonElement;
  private handles: HTMLDivElement[] = [];
  private selected = 0;
  private dragging = false;

  constructor(
    parent: HTMLElement,
    private readonly getStops: () => ColorStop[],
    private readonly hooks: GradientEditorHooks,
  ) {
    injectStyle();
    this.root = div("g3-ge");
    this.bar = div("g3-ge-bar");
    this.bar.addEventListener("dblclick", (event) => this.insertStop(this.positionAt(event)));
    this.root.appendChild(this.bar);

    const row = div("g3-ge-row");
    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.addEventListener("input", () => {
      const stop = this.stops[this.selected];
      if (!stop) return;
      stop.color = this.colorInput.value;
      this.paint();
      this.hooks.onChange();
    });
    this.posLabel = div("g3-ge-pos");
    this.addButton = this.makeButton("+ stop", () => this.addStop());
    this.removeButton = this.makeButton("− stop", () => this.removeStop());
    row.append(this.colorInput, this.posLabel, this.addButton, this.removeButton);
    this.root.appendChild(row);

    parent.appendChild(this.root);
    this.rebuildHandles();
    this.paint();
  }

  get element(): HTMLElement {
    return this.root;
  }

  /** Re-read the supplied stops and repaint after an external change. */
  refresh(): void {
    this.selected = clamp(this.selected, 0, Math.max(0, this.stops.length - 1));
    this.rebuildHandles();
    this.paint();
  }

  dispose(): void {
    this.root.remove();
  }

  private get stops(): ColorStop[] {
    return this.getStops();
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.addEventListener("click", onClick);
    return el;
  }

  /** (Re)create the handle elements — only on init / add / remove. */
  private rebuildHandles(): void {
    for (const handle of this.handles) handle.remove();
    this.handles = this.stops.map((_, index) => {
      const handle = div("g3-ge-handle");
      handle.addEventListener("pointerdown", (event) => this.onHandleDown(event, index));
      handle.addEventListener("pointermove", (event) => this.onHandleMove(event, index));
      handle.addEventListener("pointerup", (event) => this.onHandleUp(event));
      // Backstop (same as OutputResizeHandle): the OS stealing the pointer mid-drag would
      // otherwise leave `dragging` set, and the next hover would drag with no button held.
      handle.addEventListener("pointercancel", (event) => this.onHandleUp(event));
      handle.addEventListener("lostpointercapture", (event) => this.onHandleUp(event));
      handle.addEventListener("dblclick", (event) => {
        event.stopPropagation(); // or the bar's own dblclick adds one straight back
        this.selected = index;
        this.removeStop();
      });
      this.bar.appendChild(handle);
      return handle;
    });
    if (this.selected > this.stops.length - 1) this.selected = this.stops.length - 1;
  }

  /** Repaint bar + handle positions/colours. Cheap, and safe to call during a drag. */
  private paint(): void {
    const sorted = [...this.stops].toSorted((a, b) => a.position - b.position);
    this.bar.style.background = `linear-gradient(to right, ${sorted
      .map((stop) => `${stop.color} ${(stop.position * 100).toFixed(1)}%`)
      .join(", ")})`;
    for (const [index, stop] of this.stops.entries()) {
      const handle = this.handles[index];
      if (!handle) continue;
      handle.style.left = `${stop.position * 100}%`;
      handle.style.background = stop.color;
      handle.classList.toggle("is-selected", index === this.selected);
    }
    const selected = this.stops[this.selected];
    if (selected) {
      this.colorInput.value = toHex(parseHex(selected.color));
      this.posLabel.textContent = `${Math.round(selected.position * 100)}%`;
    }
    this.addButton.disabled = this.stops.length >= this.hooks.max;
    this.removeButton.disabled = this.stops.length <= 2;
  }

  private positionAt(event: PointerEvent | MouseEvent): number {
    const rect = this.bar.getBoundingClientRect();
    return clamp01((event.clientX - rect.left) / Math.max(rect.width, 1));
  }

  private onHandleDown(event: PointerEvent, index: number): void {
    event.stopPropagation();
    this.selected = index;
    this.dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.paint();
  }

  private onHandleMove(event: PointerEvent, index: number): void {
    if (!this.dragging) return;
    const stop = this.stops[index];
    if (!stop) return;
    stop.position = Math.round(this.positionAt(event) * 1000) / 1000;
    this.paint();
    this.hooks.onChange();
  }

  private onHandleUp(event: PointerEvent): void {
    this.dragging = false;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already have been released; nothing to undo.
    }
  }

  private addStop(): void {
    // Insert at the midpoint of the WIDEST gap, so the new stop lands somewhere it can be seen
    // rather than on top of an existing one.
    const sorted = [...this.stops].toSorted((a, b) => a.position - b.position);
    let widest = -1;
    let where = 0.5;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1].position - sorted[i].position;
      if (gap > widest) {
        widest = gap;
        where = (sorted[i].position + sorted[i + 1].position) / 2;
      }
    }
    this.insertStop(where);
  }

  private insertStop(position: number): void {
    if (this.stops.length >= this.hooks.max) return;
    // Take the colour the gradient already has there, so adding a stop never changes the picture —
    // it only gives you a handle on it.
    this.stops.push({
      color: this.sampleAt(position),
      position: Math.round(position * 1000) / 1000,
    });
    this.selected = this.stops.length - 1;
    this.rebuildHandles();
    this.paint();
    this.hooks.onChange();
  }

  private removeStop(): void {
    if (this.stops.length <= 2) return;
    this.stops.splice(this.selected, 1);
    this.selected = clamp(this.selected, 0, this.stops.length - 1);
    this.rebuildHandles();
    this.paint();
    this.hooks.onChange();
  }

  /** The gradient's own colour at a position, for a newly inserted stop. */
  private sampleAt(position: number): string {
    const sorted = [...this.stops].toSorted((a, b) => a.position - b.position);
    if (sorted.length === 0) return "#ffffff";
    if (position <= sorted[0].position) return toHex(parseHex(sorted[0].color));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (position >= a.position && position <= b.position) {
        return mixHex(
          a.color,
          b.color,
          (position - a.position) / Math.max(b.position - a.position, 1e-5),
        );
      }
    }
    return toHex(parseHex(sorted[sorted.length - 1].color));
  }
}
