// Capability probes for the shell. Kept dependency-free (no three) so they can run before the
// heavy renderer chunk is fetched, the shell decides poster-vs-upgrade from these.

/**
 * Renderer strings that mean "this is the CPU pretending to be a GPU". Matched case-insensitively
 * against UNMASKED_RENDERER_WEBGL.
 *
 * Deliberately a list of known software rasterizers rather than a cleverer heuristic: the cost of a
 * false positive is showing a poster to somebody with a perfectly good GPU, which is invisible to
 * them and impossible to report, so the rule has to be "recognize software" and never "fail to
 * recognize hardware".
 */
const SOFTWARE_RENDERERS = [
  "swiftshader", // Chrome's fallback rasterizer
  "llvmpipe", // Mesa
  "softpipe", // Mesa
  "software rasterizer",
  "microsoft basic render", // the Windows adapter with no driver
  "mesa offscreen",
  "apple software renderer",
];

/**
 * Whether the live renderer is a software rasterizer.
 *
 * `failIfMajorPerformanceCaveat` is SUPPOSED to cover this and does not: Chrome hands back a
 * SwiftShader context regardless on many builds. Four passes per frame then costs seconds of
 * blocked main thread rather than the slideshow the old comment here promised, and the element is
 * already carrying the better answer in its poster.
 *
 * Unknown means HARDWARE. WEBGL_debug_renderer_info is absent under some privacy settings, and
 * reading "cannot tell" as "software" would quietly downgrade those users; they would see a poster
 * forever and never know why.
 */
export function isSoftwareRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (!info) return false; // cannot tell → assume hardware
    const name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "").toLowerCase();
    if (!name) return false;
    return SOFTWARE_RENDERERS.some((s) => name.includes(s));
  } catch {
    return false;
  }
}

/**
 * Synchronously test whether the browser can give us a usable WebGL context, and whether that
 * context is worth upgrading to. Releases the throwaway context immediately via WEBGL_lose_context
 * so probing doesn't consume one of the browser's ~16 live contexts.
 *
 * Returns WHY, not just yes/no, so the shell can tell a consumer "there is no WebGL here" apart
 * from "there is, but it is the CPU" — those want different answers from a page.
 */
export function probeWebGL(): "ok" | "none" | "software" {
  if (typeof document === "undefined") return "none";
  try {
    const canvas = document.createElement("canvas");
    const attrs: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
    const gl =
      canvas.getContext("webgl2", attrs) ??
      (canvas.getContext("webgl", attrs) as WebGLRenderingContext | null);
    if (!gl) return "none";
    const software = isSoftwareRenderer(gl);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return software ? "software" : "ok";
  } catch {
    return "none";
  }
}

/** Is there a usable context at all, software or not. */
export function hasWebGL(): boolean {
  return probeWebGL() !== "none";
}

/** True when the OS/browser is set to reduce motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** True when the user has asked for reduced data usage (Save-Data / Data Saver). */
export function prefersReducedData(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return conn?.saveData === true;
}

/** The container's shorter side in CSS pixels, the input to the small-viewport poster gate. */
export function minSide(container: HTMLElement): number {
  return Math.min(container.clientWidth || 0, container.clientHeight || 0);
}
