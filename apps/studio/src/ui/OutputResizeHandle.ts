import {
  applyCustomExportDimension,
  CUSTOM_EXPORT_PRESET,
  MAX_OUTPUT_DIMENSION,
  MIN_OUTPUT_DIMENSION,
} from "../output/formats";
import type { ExportSize } from "../output/formats";
import { clamp } from "../util/math";

const MIN_PREVIEW_DIMENSION = 120;
type ResizeCorner = "nw" | "ne" | "sw" | "se";

interface ResizeHooks {
  onDragStart(): void;
  /** Cheap DOM-only update used while dragging. */
  onPreviewChange(): void;
  /** Expensive renderer resize, performed once when the gesture ends. */
  onCommit(refitPreview: boolean): void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startPreviewWidth: number;
  startPreviewHeight: number;
  startOutputWidth: number;
  startOutputHeight: number;
  maxPreviewWidth: number;
  maxPreviewHeight: number;
  corner: ResizeCorner;
  handle: HTMLButtonElement;
}

/**
 * Drag any corner of the export frame to resize the output.
 *
 * Ported from Wave Studio. The frame follows the pointer immediately by taking an explicit
 * inline/block size, which overrides the `aspect-ratio` rule that normally shapes it; the
 * expensive part — re-sizing the renderer's backing buffers — happens once, on release.
 *
 * The frame is centred in the stage, so a corner only travels half as far as the size changes:
 * every pointer delta is doubled and mirrored across the opposite edge.
 */
export class OutputResizeHandle {
  private drag?: DragState;

  constructor(
    private readonly stage: HTMLElement,
    private readonly frame: HTMLElement,
    private readonly handles: HTMLButtonElement[],
    private readonly outputSize: ExportSize,
    private readonly hooks: ResizeHooks,
  ) {
    for (const handle of this.handles) {
      handle.addEventListener("pointerdown", this.onPointerDown);
      handle.addEventListener("pointermove", this.onPointerMove);
      handle.addEventListener("pointerup", this.onPointerEnd);
      handle.addEventListener("pointercancel", this.onPointerEnd);
      // The backstop. Losing the capture without a pointerup — the element going away under it,
      // the browser reclaiming it — would otherwise leave the gesture open forever, and the
      // selection overlay stood down with it. `onPointerEnd` clears its own state first, so the
      // ordinary case, where this fires just after pointerup, costs nothing.
      handle.addEventListener("lostpointercapture", this.onPointerEnd);
      handle.addEventListener("keydown", this.onKeyDown);
    }
  }

  /**
   * Remove every corner-handle listener. The handle elements live in index.html and outlive this
   * instance, so on dev HMR a second set of drag handlers would otherwise stack on them.
   */
  dispose(): void {
    for (const handle of this.handles) {
      handle.removeEventListener("pointerdown", this.onPointerDown);
      handle.removeEventListener("pointermove", this.onPointerMove);
      handle.removeEventListener("pointerup", this.onPointerEnd);
      handle.removeEventListener("pointercancel", this.onPointerEnd);
      handle.removeEventListener("lostpointercapture", this.onPointerEnd);
      handle.removeEventListener("keydown", this.onKeyDown);
    }
  }

  fitPreview(): void {
    this.frame.style.removeProperty("inline-size");
    this.frame.style.removeProperty("block-size");
  }

  private previewBounds(): { width: number; height: number } {
    const style = getComputedStyle(this.stage);
    return {
      width:
        this.stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height:
        this.stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLButtonElement)) return;
    const corner = handle.dataset.corner;
    if (corner !== "nw" && corner !== "ne" && corner !== "sw" && corner !== "se") return;
    const rect = this.frame.getBoundingClientRect();
    const bounds = this.previewBounds();
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPreviewWidth: rect.width,
      startPreviewHeight: rect.height,
      startOutputWidth: this.outputSize.width,
      startOutputHeight: this.outputSize.height,
      maxPreviewWidth: bounds.width,
      maxPreviewHeight: bounds.height,
      corner,
      handle,
    };
    this.frame.style.inlineSize = `${rect.width}px`;
    this.frame.style.blockSize = `${rect.height}px`;
    this.frame.classList.add("is-resizing");
    this.hooks.onDragStart();
    handle.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();

    // The stage remains centred in the workspace, so each pointer delta is doubled and
    // mirrored across the opposite side. The corner signs make outward movement grow.
    const horizontalSign = drag.corner.endsWith("e") ? 1 : -1;
    const verticalSign = drag.corner.startsWith("s") ? 1 : -1;
    const widthScale =
      (drag.startPreviewWidth + (event.clientX - drag.startX) * 2 * horizontalSign) /
      drag.startPreviewWidth;
    const heightScale =
      (drag.startPreviewHeight + (event.clientY - drag.startY) * 2 * verticalSign) /
      drag.startPreviewHeight;

    let outputWidth: number;
    let outputHeight: number;
    if (this.outputSize.lockAspectRatio) {
      const requestedScale =
        Math.abs(widthScale - 1) >= Math.abs(heightScale - 1) ? widthScale : heightScale;
      const minScale = Math.max(
        Math.min(MIN_PREVIEW_DIMENSION, drag.maxPreviewWidth) / drag.startPreviewWidth,
        Math.min(MIN_PREVIEW_DIMENSION, drag.maxPreviewHeight) / drag.startPreviewHeight,
        MIN_OUTPUT_DIMENSION / drag.startOutputWidth,
        MIN_OUTPUT_DIMENSION / drag.startOutputHeight,
      );
      const maxScale = Math.min(
        drag.maxPreviewWidth / drag.startPreviewWidth,
        drag.maxPreviewHeight / drag.startPreviewHeight,
        MAX_OUTPUT_DIMENSION / drag.startOutputWidth,
        MAX_OUTPUT_DIMENSION / drag.startOutputHeight,
      );
      const scale = clamp(requestedScale, minScale, maxScale);
      outputWidth = Math.round(drag.startOutputWidth * scale);
      outputHeight = Math.round(drag.startOutputHeight * scale);
    } else {
      const previewWidth = clamp(
        drag.startPreviewWidth * widthScale,
        Math.min(MIN_PREVIEW_DIMENSION, drag.maxPreviewWidth),
        drag.maxPreviewWidth,
      );
      const previewHeight = clamp(
        drag.startPreviewHeight * heightScale,
        Math.min(MIN_PREVIEW_DIMENSION, drag.maxPreviewHeight),
        drag.maxPreviewHeight,
      );
      outputWidth = clamp(
        Math.round(drag.startOutputWidth * (previewWidth / drag.startPreviewWidth)),
        MIN_OUTPUT_DIMENSION,
        MAX_OUTPUT_DIMENSION,
      );
      outputHeight = clamp(
        Math.round(drag.startOutputHeight * (previewHeight / drag.startPreviewHeight)),
        MIN_OUTPUT_DIMENSION,
        MAX_OUTPUT_DIMENSION,
      );
      this.outputSize.aspectRatio = outputWidth / outputHeight;
    }

    this.frame.style.inlineSize = `${drag.startPreviewWidth * (outputWidth / drag.startOutputWidth)}px`;
    this.frame.style.blockSize = `${drag.startPreviewHeight * (outputHeight / drag.startOutputHeight)}px`;
    this.outputSize.preset = CUSTOM_EXPORT_PRESET;
    this.outputSize.width = outputWidth;
    this.outputSize.height = outputHeight;
    this.hooks.onPreviewChange();
  };

  private onPointerEnd = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const { handle } = this.drag;
    this.drag = undefined;
    this.frame.classList.remove("is-resizing");
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    this.hooks.onCommit(false);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLButtonElement)) return;
    const corner = handle.dataset.corner;
    if (corner !== "nw" && corner !== "ne" && corner !== "sw" && corner !== "se") return;
    const step = event.shiftKey ? 64 : 16;
    const horizontalSign = corner.endsWith("e") ? 1 : -1;
    const verticalSign = corner.startsWith("s") ? 1 : -1;
    let dimension: "width" | "height";
    let value: number;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      dimension = "width";
      value = this.outputSize.width + step * direction * horizontalSign;
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      dimension = "height";
      value = this.outputSize.height + step * direction * verticalSign;
    } else return;

    event.preventDefault();
    event.stopPropagation();
    applyCustomExportDimension(this.outputSize, dimension, value);
    this.hooks.onCommit(true);
  };
}
