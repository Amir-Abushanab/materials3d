/**
 * Offscreen thumbnail rendering: turn a config into a still frame using one hidden, reused
 * MaterialRenderer. Used by the studio's preset picker and its version history.
 *
 * Lives in core rather than the studio because it needs the renderer, and because anything else
 * showing a gallery of scenes wants exactly this.
 */

import type { SceneConfig } from "../config/model";
import type { MaterialRenderer } from "../renderer/MaterialRenderer";

/** A hidden host div that is still in layout (so clientWidth/Height are real) but off-screen. */
export function createThumbHost(width: number, height: number): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;opacity:0;pointer-events:none;`;
  document.body.appendChild(host);
  return host;
}

/**
 * Mutate `cfg` for a thumbnail still.
 *
 * Opaque, because a transparent scene thumbnails as a shape floating on nothing and every preset
 * would look alike. Static and pinned to `timeOffset`, so the same preset always produces the same
 * image. `dprMax: 1` because the host is already sized in the exact pixels we want.
 *
 * `quality` is deliberately NOT lowered. It scales the render targets *below* the canvas, so the
 * scene would be drawn smaller and upscaled, on a thumbnail that is then displayed on a HiDPI
 * screen, that is a second softening on top of the first, and the result reads as blurry rather
 * than small. Ask for the pixels you intend to show.
 */
export function prepThumbConfig(cfg: SceneConfig): void {
  cfg.paused = true;
  cfg.transparentBackground = false;
  cfg.orbit = false;
  cfg.dprMax = 1;
  cfg.quality = 1;
}

/**
 * Render the current config to a fresh 2D canvas (null if the WebGL canvas is missing).
 *
 * Exactly one render. The constructor or the caller's `setConfig` has already sized the targets to
 * the host and the config's `quality`, and a shader that needs recompiling is compiled inside the
 * render that first uses it, so a second pass adds nothing. `seek()` rather than `renderOnce()`
 * because it positions the camera and applies the motion pose first; a bare render would use
 * whatever pose the previous thumbnail left.
 */
export function renderThumbFrame(
  renderer: MaterialRenderer,
  host: HTMLElement,
): HTMLCanvasElement | null {
  renderer.seek(renderer.getConfig().timeOffset);
  const gl = host.querySelector("canvas");
  if (!gl) return null;
  // Copy to a 2D canvas before encoding, a reliable read of the WebGL drawing buffer.
  const out = document.createElement("canvas");
  out.width = gl.width;
  out.height = gl.height;
  out.getContext("2d")?.drawImage(gl, 0, 0);
  return out;
}
