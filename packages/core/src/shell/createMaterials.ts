import type { SceneConfig } from "../config/model";
import type { MaterialRenderer, MaterialRendererOptions } from "../renderer/MaterialRenderer";
import { hasWebGL, minSide, prefersReducedData, prefersReducedMotion } from "./probe";
import { ensurePositioned, setupPoster, type Poster, type PosterFit } from "./poster";

export type { PosterFit } from "./poster";

/** Why the shell showed the poster instead of live glass. */
export type FallbackReason =
  | "no-webgl"
  | "reduced-motion"
  | "save-data"
  | "small-viewport"
  | "context-lost"
  | "load-error";

/** poster → loading → running, or → fallback (permanent poster). */
export type MaterialState = "poster" | "loading" | "running" | "fallback";

/**
 * The heavy module fetched on upgrade.
 *
 * Stays typed against the WebGL engine even though there are now two, because `onReady` hands this
 * renderer to consumers: widening it to the smaller surface both engines share would be a public
 * API break for everyone, to describe a second engine that is still being built. The WebGPU
 * loader asserts itself into this shape instead, and says why — see `core-loader-webgpu`.
 */
type CoreModule = typeof import("../core-loader");

export interface MaterialOptions {
  /** Poster URL / data-URI. Defaults to adopting the container's `<img data-materials3d-poster>` (SSR). */
  poster?: string;
  /** Poster `object-fit`. Default `"fill"` — matches the canvas, so a poster captured at the
   *  container's aspect hands off with no visible jump. */
  posterFit?: PosterFit;
  /** Wait until the container nears the viewport before fetching the engine. Default true. */
  lazy?: boolean;
  /** IntersectionObserver margin for the lazy trigger. Default "200px". */
  rootMargin?: string;
  /** "auto" probes WebGL (with failIfMajorPerformanceCaveat); "force" skips the probe; "off"
   *  stays a poster. */
  webgl?: "auto" | "force" | "off";
  /** Forward prefers-reduced-motion to the renderer (freezes to a static frame). Default true. */
  respectReducedMotion?: boolean;
  /** With reduced motion: "static" upgrades to a frozen frame; "poster" stays a poster.
   *  Default "static". */
  reducedMotionBehavior?: "static" | "poster";
  /** Keep a permanent poster when the user has Save-Data on. Default true. */
  respectSaveData?: boolean;
  /**
   * Stay a poster when the container's shorter side is below this many CSS pixels. Default 0
   * (off). Worth setting for a hero: four passes at phone DPR is a real cost, and a still frame
   * of a glass composition loses far less than a still frame of, say, a video would.
   */
  minSizeForWebGL?: number;
  /** Poster→canvas crossfade duration (ms). Default 300. */
  fadeMs?: number;
  /** Start paused. */
  paused?: boolean;
  onReady?(renderer: MaterialRenderer): void;
  onFallback?(reason: FallbackReason): void;
  onStateChange?(state: MaterialState): void;
  /**
   * Which engine to fetch. Default `"webgl"`.
   *
   * `"webgpu"` fetches a SEPARATE build — three's node renderer and TSL — and is the only way to
   * reach a WebGPU backend. It is opt-in rather than automatic because the two engines are
   * different bundles that share only three's core: the default path stays at roughly 733 KB while
   * this one is nearer 1,028 KB, and a consumer who will never touch WebGPU should not pay for it.
   *
   * `"webgpu"` still runs on WebGL wherever WebGPU is unavailable — three's node renderer falls
   * back to a WebGL backend on its own — so this selects the ENGINE, not the backend. What it
   * actually buys is TSL and whatever a WebGPU backend adds where the browser has one.
   */
  renderer?: "webgl" | "webgpu";
  /** Seam for the standalone/CDN build to supply the core synchronously (three already bundled). */
  loadCore?(): Promise<CoreModule>;
}

export interface SnapshotOptions {
  /** Image MIME type. Default `"image/webp"`. */
  type?: string;
  /** Encoder quality 0–1 for lossy types. */
  quality?: number;
  /** Render a fixed animation-time for a reproducible frame (default: the live frame). Poster
   *  captures should pass `0` — the frame the scene opens on — so the file doesn't churn. */
  time?: number;
}

export interface MaterialHandle {
  readonly state: MaterialState;
  readonly renderer: MaterialRenderer | null;
  /** Capture the current live frame as an image Blob. Resolves `null` until the scene is running
   *  — wait for {@link MaterialOptions.onReady} (or the element's `materials3d-ready` event) first. */
  snapshot(options?: SnapshotOptions): Promise<Blob | null>;
  /** Merge a partial config. Staged before upgrade; applied directly after. */
  set(config: Partial<SceneConfig>): void;
  play(): void;
  pause(): void;
  /** Safe in any state (aborts a pending upgrade, disposes a live renderer, removes the poster). */
  destroy(): void;
}

/**
 * The shell implementation. `loadCore` is an explicit parameter (not read from options) so the
 * standalone/CDN build can pass a synchronous core and NOT bundle the dynamic-import path — its
 * output stays a single file. The public {@link createMaterials} supplies the dynamic-import default.
 */
export function createMaterialsImpl(
  loadCore: () => Promise<CoreModule>,
  container: HTMLElement,
  config: Partial<SceneConfig>,
  options: MaterialOptions,
): MaterialHandle {
  const {
    lazy = true,
    rootMargin = "200px",
    webgl = "auto",
    respectReducedMotion = true,
    reducedMotionBehavior = "static",
    respectSaveData = true,
    minSizeForWebGL = 0,
    fadeMs = 300,
  } = options;

  let state: MaterialState = "poster";
  let renderer: MaterialRenderer | null = null;
  let staged: Partial<SceneConfig> = { ...config };
  if (options.paused !== undefined) staged.paused = options.paused;

  let aborted = false;
  let io: IntersectionObserver | null = null;
  let lostTimer: ReturnType<typeof setTimeout> | undefined;
  let lossCount = 0;

  ensurePositioned(container);
  const poster: Poster | null = setupPoster(container, options.poster, options.posterFit);

  function setState(next: MaterialState): void {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  function fallback(reason: FallbackReason): void {
    setState("fallback");
    poster?.show();
    options.onFallback?.(reason);
  }

  function onContextRestored(): void {
    clearTimeout(lostTimer); // the renderer rebuilt in time; stay live
  }

  function onContextLost(): void {
    lossCount += 1;
    clearTimeout(lostTimer);
    if (lossCount >= 2) {
      teardownRenderer();
      fallback("context-lost");
      return;
    }
    // The renderer tries to restore; if it hasn't within ~4s, give up to the poster.
    lostTimer = setTimeout(() => {
      teardownRenderer();
      fallback("context-lost");
    }, 4000);
  }

  function teardownRenderer(): void {
    if (!renderer) return;
    const canvas = renderer.canvas;
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
    renderer.dispose();
    renderer = null;
  }

  async function upgrade(): Promise<void> {
    setState("loading");
    let core: CoreModule;
    try {
      core = await loadCore();
    } catch {
      if (!aborted) fallback("load-error");
      return;
    }
    if (aborted) return;

    const full: Partial<SceneConfig> = { ...core.createDefaultConfig(), ...staged };
    const rendererOptions: MaterialRendererOptions = { respectReducedMotion };
    renderer = new core.MaterialRenderer(container, full, rendererOptions);
    const canvas = renderer.canvas;
    canvas.addEventListener("webglcontextlost", onContextLost, false);
    canvas.addEventListener("webglcontextrestored", onContextRestored, false);
    renderer.start();
    setState("running");
    options.onReady?.(renderer);

    if (poster) {
      // Crossfade only after two frames, so the scene has definitely painted first.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!aborted && renderer) poster.fadeOut(fadeMs);
        }),
      );
    }
  }

  function probeAndUpgrade(): void {
    if (aborted) return;
    if (webgl === "auto" && !hasWebGL()) {
      fallback("no-webgl");
      return;
    }
    void upgrade();
  }

  function begin(): void {
    // Permanent-poster gates, checked before any lazy wait or engine fetch.
    if (webgl === "off") return; // deliberate poster-only mode — no fallback callback
    if (respectSaveData && prefersReducedData()) return fallback("save-data");
    if (respectReducedMotion && reducedMotionBehavior === "poster" && prefersReducedMotion()) {
      return fallback("reduced-motion");
    }
    if (minSizeForWebGL > 0 && minSide(container) < minSizeForWebGL) {
      return fallback("small-viewport");
    }
    if (lazy && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io?.disconnect();
            io = null;
            probeAndUpgrade();
          }
        },
        { rootMargin },
      );
      io.observe(container);
    } else {
      probeAndUpgrade();
    }
  }

  const handle: MaterialHandle = {
    get state() {
      return state;
    },
    get renderer() {
      return renderer;
    },
    snapshot(opts = {}) {
      if (!renderer) return Promise.resolve(null);
      const { type = "image/webp", quality, time } = opts;
      return renderer.captureImage(type, quality, time);
    },
    set(next) {
      staged = { ...staged, ...next };
      if (renderer) {
        renderer.setConfig({ ...renderer.getConfig(), ...next });
        renderer.refreshPlayback(); // setConfig doesn't re-evaluate `paused` on its own
      }
    },
    play() {
      staged.paused = false;
      if (renderer) {
        renderer.getConfig().paused = false;
        renderer.refreshPlayback();
      }
    },
    pause() {
      staged.paused = true;
      if (renderer) {
        renderer.getConfig().paused = true;
        renderer.refreshPlayback();
      }
    },
    destroy() {
      aborted = true;
      io?.disconnect();
      io = null;
      clearTimeout(lostTimer);
      teardownRenderer();
      poster?.remove();
    },
  };

  begin();
  return handle;
}

/**
 * Mount a self-optimizing glass scene into a container: shows a poster immediately, then —
 * lazily, and only when the browser can actually run it — fetches the engine, builds the
 * renderer and crossfades in. Falls back to the poster on no-WebGL / save-data / reduced-motion /
 * small viewports / context loss / load errors.
 *
 * No static three import: the engine arrives via a dynamic import, so the shell stays tiny.
 */
export function createMaterials(
  container: HTMLElement,
  config: Partial<SceneConfig> = {},
  options: MaterialOptions = {},
): MaterialHandle {
  return createMaterialsImpl(
    options.loadCore ??
      // Two separate dynamic imports, not one parameterized by a variable: a bundler can only
      // code-split a literal import specifier, so folding these into `import(path)` would defeat
      // the split and pull both engines into every build.
      (options.renderer === "webgpu"
        ? () => import("../core-loader-webgpu")
        : () => import("../core-loader")),
    container,
    config,
    options,
  );
}

/** The drop-in embed contract: an alias of {@link createMaterials}. */
export const mountMaterials = createMaterials;
