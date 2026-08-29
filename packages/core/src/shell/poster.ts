// Poster management for the shell: the static image shown first (server-rendered or generated)
// that covers the container until the live scene has painted, then crossfades out.

const POSTER_ATTR = "data-materials3d-poster";

/**
 * How the poster image maps into the container box (its CSS `object-fit`).
 * `"fill"` (default) stretches it edge-to-edge exactly like the canvas — which renders at the
 * container's own aspect — so a poster captured at that aspect aligns pixel-for-pixel and the
 * handoff has no visible jump. `"cover"` crops to preserve the poster's own aspect instead.
 */
export type PosterFit = "cover" | "contain" | "fill";

export interface Poster {
  readonly el: HTMLImageElement;
  fadeOut(fadeMs: number): void;
  show(): void;
  remove(): void;
}

/** Make the container a positioning context so the absolutely-positioned poster overlays the canvas. */
export function ensurePositioned(container: HTMLElement): void {
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
}

/**
 * Create the poster image — or adopt an existing SSR `<img data-materials3d-poster>` already inside
 * the container (no hydration flash). Returns null when there is neither a `src` nor an adoptable
 * image: a poster is optional, just strongly recommended for a four-pass renderer.
 */
export function setupPoster(
  container: HTMLElement,
  src?: string,
  fit: PosterFit = "fill",
): Poster | null {
  let img = container.querySelector<HTMLImageElement>(`img[${POSTER_ATTR}]`);
  if (!img && !src) return null;
  if (!img) {
    img = document.createElement("img");
    img.setAttribute(POSTER_ATTR, "");
    img.decoding = "async";
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    container.appendChild(img);
  }
  if (src) img.src = src;
  Object.assign(img.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    objectFit: fit,
    pointerEvents: "none", // clicks/scrolls pass through to the canvas beneath
    zIndex: "1", // above the WebGL canvas (which sits at the default z-order)
    opacity: "1",
    visibility: "visible",
  });
  const el = img;
  return {
    el,
    fadeOut(fadeMs) {
      if (fadeMs <= 0) {
        el.style.opacity = "0";
        el.style.visibility = "hidden";
        return;
      }
      el.style.transition = `opacity ${fadeMs}ms ease`;
      void el.offsetWidth; // force a style flush so the transition runs from the current opacity
      el.style.opacity = "0";
      // Hide after the fade so the (transparent) poster can never intercept anything; the timer
      // is rAF-independent so it still completes in a throttled/backgrounded tab.
      setTimeout(() => {
        el.style.visibility = "hidden";
      }, fadeMs + 50);
    },
    show() {
      el.style.transition = "";
      el.style.opacity = "1";
      el.style.visibility = "visible";
    },
    remove() {
      el.remove();
    },
  };
}
