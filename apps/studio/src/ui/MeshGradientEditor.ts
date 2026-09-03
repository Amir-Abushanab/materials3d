/**
 * A 2D pad for placing mesh-gradient blobs: drag a dot anywhere in the frame, recolour it, add and
 * remove them. The pad paints the actual field behind the handles, so what you drag against is
 * what the backdrop will be.
 *
 * Mutates the supplied `MeshGradientPoint[]` in place and calls
 * `onChange`. Handles are real `<button>`s so the pad is keyboard-operable (arrows nudge, shift
 * for a coarse step), which a div with pointer handlers would not be.
 */
import { renderMeshGradient } from "@materials3d/core/studio";
import { parseHex, toHex, type MeshGradientPoint } from "@materials3d/core";
import { injectStyle } from "../util/dom";
import { clamp } from "../util/math";
import { div, makeButton, makeColorInput, makeHandle, round3 } from "./gradientShared";

const STYLE_ID = "g3-mesh-editor-style";

const CSS = `
.g3-me{display:flex;flex-direction:column;gap:6px;padding:2px 8px 6px;}
.g3-me-stage{position:relative;height:112px;overflow:hidden;border-radius:5px;
  border:1px solid var(--hair);box-shadow:inset 0 0 0 1px rgb(255 255 255 / 45%);
  touch-action:none;cursor:crosshair;}
.g3-me-canvas{display:block;width:100%;height:100%;}
.g3-me-handle{position:absolute;width:17px;height:17px;padding:0;border-radius:50%;
  transform:translate(-50%,-50%);border:2px solid #fff;cursor:move;box-sizing:border-box;
  box-shadow:0 1px 4px rgb(27 26 31 / 50%);touch-action:none;}
.g3-me-handle.is-selected{width:21px;height:21px;
  box-shadow:0 0 0 3px var(--accent),0 2px 6px rgb(27 26 31 / 55%);}
.g3-me-handle:focus-visible{outline:2px solid var(--accent);outline-offset:4px;}
.g3-me-row{display:flex;align-items:center;gap:6px;}
.g3-me-row input[type=color]{width:36px;height:23px;padding:0;border-radius:4px;cursor:pointer;
  border:1px solid var(--hair);background:none;}
.g3-me-pos{min-width:66px;color:var(--ink-2);font-size:10px;text-align:center;
  font-variant-numeric:tabular-nums;}
.g3-me-row button{height:23px;padding:0 7px;font-size:11px;color:var(--ink);cursor:pointer;
  border-radius:4px;background:rgb(27 26 31 / 5%);border:1px solid var(--hair);}
.g3-me-row button:disabled{opacity:.4;cursor:default;}
.g3-me-help{color:var(--ink-3);font-size:10px;line-height:1.3;}
`;

/** Colours for newly added blobs, so a new one is visible rather than matching its neighbour. */
const ADD_COLORS = ["#f8c852", "#ea4776", "#719cdd", "#c4d368", "#b461cb", "#f59d3e"];

export interface MeshGradientEditorHooks {
  onChange: () => void;
  max: number;
}

export class MeshGradientEditor {
  private readonly root: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly colorInput: HTMLInputElement;
  private readonly posLabel: HTMLDivElement;
  private readonly addButton: HTMLButtonElement;
  private readonly removeButton: HTMLButtonElement;
  private handles: HTMLButtonElement[] = [];
  private selected = 0;
  private repaintRaf = 0;

  constructor(
    parent: HTMLElement,
    private readonly getPoints: () => MeshGradientPoint[],
    private readonly getSoftness: () => number,
    private readonly hooks: MeshGradientEditorHooks,
  ) {
    injectStyle(STYLE_ID, CSS);
    this.root = div("g3-me");
    this.stage = div("g3-me-stage");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "g3-me-canvas";
    this.stage.appendChild(this.canvas);
    this.stage.addEventListener("dblclick", (event) => {
      const at = this.pointAt(event);
      this.addPoint(at.x, at.y);
    });
    this.root.appendChild(this.stage);

    const row = div("g3-me-row");
    this.colorInput = makeColorInput("Blob colour", (value) => {
      const point = this.points[this.selected];
      if (!point) return;
      point.color = value;
      this.paint();
      this.hooks.onChange();
    });
    this.posLabel = div("g3-me-pos");
    this.addButton = makeButton("+ blob", () => this.addPoint(0.5, 0.5));
    this.removeButton = makeButton("− blob", () => this.removePoint());
    row.append(this.colorInput, this.posLabel, this.addButton, this.removeButton);
    this.root.appendChild(row);

    const help = div("g3-me-help");
    help.textContent = "Drag a blob · double-click to add · arrows nudge (shift = coarse)";
    this.root.appendChild(help);

    parent.appendChild(this.root);
    this.rebuildHandles();
    this.paint();
  }

  refresh(): void {
    this.selected = clamp(this.selected, 0, Math.max(0, this.points.length - 1));
    this.rebuildHandles();
    this.paint();
  }

  dispose(): void {
    if (this.repaintRaf) cancelAnimationFrame(this.repaintRaf);
    this.root.remove();
  }

  private get points(): MeshGradientPoint[] {
    return this.getPoints();
  }

  private rebuildHandles(): void {
    for (const handle of this.handles) handle.remove();
    this.handles = this.points.map((_, index) => {
      const handle = makeHandle("g3-me-handle", `Blob ${index + 1}`, {
        onDown: () => {
          this.selected = index;
          this.paint();
        },
        onMove: (event) => {
          const at = this.pointAt(event);
          this.movePoint(index, at.x, at.y, true);
        },
        onNudge: (dx, dy, coarse) => {
          const point = this.points[index];
          if (!point) return;
          const step = coarse ? 0.1 : 0.01;
          this.selected = index;
          this.movePoint(index, point.x + dx * step, point.y + dy * step, false);
        },
        onRemove: () => {
          this.selected = index;
          this.removePoint();
        },
      });
      this.stage.appendChild(handle);
      return handle;
    });
    if (this.selected > this.points.length - 1) this.selected = this.points.length - 1;
  }

  private paint(): void {
    this.paintField();
    for (const [index, point] of this.points.entries()) {
      const handle = this.handles[index];
      if (!handle) continue;
      handle.style.left = `${point.x * 100}%`;
      // The config's y runs bottom-up (frame space); CSS top runs the other way.
      handle.style.top = `${(1 - point.y) * 100}%`;
      handle.style.background = point.color;
      handle.classList.toggle("is-selected", index === this.selected);
    }
    const selected = this.points[this.selected];
    if (selected) {
      this.colorInput.value = toHex(parseHex(selected.color));
      this.posLabel.textContent = `${selected.x.toFixed(2)}, ${selected.y.toFixed(2)}`;
    }
    this.addButton.disabled = this.points.length >= this.hooks.max;
    this.removeButton.disabled = this.points.length <= 1;
  }

  private paintField(): void {
    renderMeshGradient(this.canvas, this.points, this.getSoftness());
  }

  /** Coalesce repaints during a drag: the field costs more than moving a dot. */
  private schedulePaint(): void {
    if (this.repaintRaf) return;
    this.repaintRaf = requestAnimationFrame(() => {
      this.repaintRaf = 0;
      this.paint();
    });
  }

  private pointAt(event: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.stage.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1),
      y: clamp(1 - (event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1),
    };
  }

  /** `coalesce` defers the repaint to the next frame, for the many moves of a drag. */
  private movePoint(index: number, x: number, y: number, coalesce: boolean): void {
    const point = this.points[index];
    if (!point) return;
    point.x = round3(clamp(x, 0, 1));
    point.y = round3(clamp(y, 0, 1));
    if (coalesce) this.schedulePaint();
    else this.paint();
    this.hooks.onChange();
  }

  private addPoint(x: number, y: number): void {
    if (this.points.length >= this.hooks.max) return;
    this.points.push({
      x: round3(x),
      y: round3(y),
      color: ADD_COLORS[this.points.length % ADD_COLORS.length],
    });
    this.selected = this.points.length - 1;
    this.rebuildHandles();
    this.paint();
    this.hooks.onChange();
  }

  private removePoint(): void {
    if (this.points.length <= 1) return;
    this.points.splice(this.selected, 1);
    this.selected = clamp(this.selected, 0, this.points.length - 1);
    this.rebuildHandles();
    this.paint();
    this.hooks.onChange();
  }
}
