/**
 * A 2D-canvas twin of the mesh-gradient branch in `BACKDROP_FRAG`, for authoring previews.
 *
 * ⚠ This mirrors GLSL that cannot be shared with it. The formula below, an inverse-distance blend
 * with NORMALIZED weights, `w = exp(-d²/softness²)`, must stay in step with the mesh branch of the
 * backdrop shader. A preview that disagrees with the render is worse than no preview, because it
 * quietly teaches the wrong thing about where a blob lands.
 *
 * Drawn at a deliberately small resolution: the field is smooth by construction, so a low-res image
 * scaled up by the canvas is indistinguishable from a per-pixel one and costs a fraction as much on
 * every drag.
 */
import { parseHex } from "../util/color";
import type { MeshGradientPoint } from "../config/model";

/** Pixels across the preview buffer. The height follows the target canvas's aspect. */
const FIELD_WIDTH = 72;

export function renderMeshGradient(
  canvas: HTMLCanvasElement,
  points: readonly MeshGradientPoint[],
  softness: number,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  const aspect =
    canvas.clientHeight > 0 ? canvas.clientHeight / Math.max(canvas.clientWidth, 1) : 0.5;
  const width = FIELD_WIDTH;
  const height = Math.max(1, Math.round(FIELD_WIDTH * aspect));
  canvas.width = width;
  canvas.height = height;

  const image = context.createImageData(width, height);
  const colors = points.map((point) => parseHex(point.color));
  const falloff = Math.max(softness * softness, 1e-6);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sample at pixel centres in the same 0..1 frame space the shader uses.
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (const [index, point] of points.entries()) {
        const dx = u - point.x;
        // The shader's v runs bottom-up; canvas rows run top-down.
        const dy = 1 - v - point.y;
        const weight = Math.exp(-(dx * dx + dy * dy) / falloff);
        const color = colors[index];
        r += color[0] * weight;
        g += color[1] * weight;
        b += color[2] * weight;
        total += weight;
      }
      const offset = (y * width + x) * 4;
      const scale = total > 1e-5 ? 1 / total : 0;
      image.data[offset] = Math.round(r * scale * 255);
      image.data[offset + 1] = Math.round(g * scale * 255);
      image.data[offset + 2] = Math.round(b * scale * 255);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}
