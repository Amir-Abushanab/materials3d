"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { CSSProperties, ForwardedRef, ReactElement, ReactNode, Ref } from "react";
import { createDefaultConfig, createMaterials, mergeSceneConfig } from "@materials3d/core";
import type {
  FallbackReason,
  SceneConfig,
  MaterialHandle,
  MaterialOptions,
  LampConfig,
  MotionConfig,
  PosterFit,
  RendererKind,
  EngineFor,
  PostConfig,
  ScatterConfig,
} from "@materials3d/core";

/** Flat props for the settings people actually reach for; anything else goes through `config`. */
interface FlatProps {
  /** The bounded field of light behind the glass. */
  lamps?: LampConfig[];
  lampGain?: number;
  background?: string;
  /** Drop the backdrop so the scene composites over the page behind it. */
  transparentBackground?: boolean;
  clearGlass?: string;
  post?: Partial<PostConfig>;
  /** Motion for the shapes a `scatter` generates. Per-shape motion on hand-authored `items` goes
   *  through the `config` prop, a flat prop can only mean "all of them". */
  motion?: Partial<MotionConfig>;
  scatter?: Partial<ScatterConfig>;
  orbit?: boolean;
  quality?: number;
  dprMax?: number;
  paused?: boolean;
}

export interface Materials3DProps<R extends RendererKind = "webgl"> extends FlatProps {
  /** A preset: a function (tree-shakeable) or a name string (lazy-imports the presets chunk). */
  preset?: string | (() => Partial<SceneConfig>);
  /**
   * Escape hatch: a full/partial config, applied last and merged one level deep, so
   * `config={{ post: { bloom: 1 } }}` keeps the rest of the post block.
   * Precedence: default ← preset ← flat props ← config.
   */
  config?: Partial<SceneConfig>;
  poster?: string;
  /** Poster `object-fit`. Default `"fill"` (matches the canvas → seamless handoff). */
  posterFit?: PosterFit;
  lazy?: boolean;
  webgl?: "auto" | "force" | "off";
  /**
   * Which engine build to fetch. Default `"webgl"`.
   *
   * `"webgpu"` fetches a separate, larger bundle, three's node renderer and TSL, and is the only
   * way to reach a WebGPU backend. It selects the ENGINE, not the backend: it still runs on WebGL
   * where the browser has no WebGPU. See `MaterialOptions.renderer`.
   */
  renderer?: R;
  respectReducedMotion?: boolean;
  /** Stay a poster below this container size in CSS pixels. Four passes at phone DPR is real
   *  work, and a still frame of glass loses less than a still frame of most things. */
  minSizeForWebGL?: number;
  className?: string;
  style?: CSSProperties;
  /** Custom SSR poster markup, e.g. `<img data-materials3d-poster src="…" />`, the shell adopts it. */
  children?: ReactNode;
  onReady?: (renderer: EngineFor<R>) => void;
  onFallback?: (reason: FallbackReason) => void;
}

/** Resolve the base config: function preset (sync) → its config; string preset → lazy-load. */
async function resolveBase(preset: Materials3DProps["preset"]): Promise<SceneConfig> {
  if (typeof preset === "function") return { ...createDefaultConfig(), ...preset() };
  if (typeof preset === "string") {
    const { PRESETS, isPresetName } = await import("@materials3d/core/presets");
    if (isPresetName(preset)) return PRESETS[preset]();
  }
  return createDefaultConfig();
}

/** The base we can build synchronously (function preset / default); a string preset resolves later. */
function syncBase(preset: Materials3DProps["preset"]): SceneConfig {
  return typeof preset === "function"
    ? { ...createDefaultConfig(), ...preset() }
    : createDefaultConfig();
}

/** Apply the flat props (and the config escape hatch) onto a full base config. */
function buildConfig(
  base: SceneConfig,
  props: Materials3DProps<RendererKind>,
): Partial<SceneConfig> {
  // A function preset may hand back the same object on every call (a module-level constant, say),
  // and the base is spread only one level deep from it, so copy before writing into any block.
  const out = structuredClone(base);
  if (props.lamps !== undefined) out.lamps = props.lamps;
  if (props.lampGain !== undefined) out.lampGain = props.lampGain;
  if (props.background !== undefined) out.background = props.background;
  if (props.transparentBackground !== undefined) {
    out.transparentBackground = props.transparentBackground;
  }
  if (props.clearGlass !== undefined) out.clearGlass = props.clearGlass;
  if (props.post !== undefined) out.post = { ...out.post, ...props.post };
  if (props.motion !== undefined) {
    const motion = props.motion;
    if (out.scatter) out.scatter.motion = { ...out.scatter.motion, ...motion };
    for (const item of out.items) item.motion = { ...item.motion, ...motion };
  }
  // A partial scatter merges onto whatever the preset authored, so `scatter={{ count: 24 }}` is
  // enough to re-scatter the reference scene.
  if (props.scatter !== undefined && out.scatter) {
    out.scatter = { ...out.scatter, ...props.scatter };
  }
  if (props.orbit !== undefined) out.orbit = props.orbit;
  if (props.quality !== undefined) out.quality = props.quality;
  if (props.dprMax !== undefined) out.dprMax = props.dprMax;
  if (props.paused !== undefined) out.paused = props.paused;
  return props.config ? mergeSceneConfig(out, props.config) : out;
}

/**
 * Function presets are keyed by identity: swapping one function for another must re-run the update
 * effect, and a single string cannot say which function it saw. An inline (per-render) function
 * gets a fresh id each render, which re-runs the effect, `setConfig`'s structural diff makes that
 * a no-op, but memoize the preset if you want the effect to skip entirely.
 */
const presetIds = new WeakMap<object, number>();
let nextPresetId = 0;
function presetKey(preset: Materials3DProps["preset"]): string | undefined {
  if (typeof preset !== "function") return preset;
  let id = presetIds.get(preset);
  if (id === undefined) presetIds.set(preset, (id = nextPresetId++));
  return `fn#${id}`;
}

/** A stable string that changes whenever the resolved config would, keys the update effect. */
function configKey(props: Materials3DProps<RendererKind>): string {
  const flat: Record<string, unknown> = {};
  const keys = [
    "lamps",
    "lampGain",
    "background",
    "transparentBackground",
    "clearGlass",
    "post",
    "motion",
    "scatter",
    "orbit",
    "quality",
    "dprMax",
    "paused",
  ] as const;
  for (const k of keys) if (props[k] !== undefined) flat[k] = props[k];
  return JSON.stringify({
    preset: presetKey(props.preset),
    flat,
    config: props.config,
  });
}

/** The state the handle reports before the shell exists: what the server-rendered div shows. */
const IDLE_STATE = "poster";

function Materials3DInner(
  props: Materials3DProps<RendererKind>,
  ref: ForwardedRef<MaterialHandle<RendererKind>>,
): ReactElement {
  const { className, style, children } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MaterialHandle<RendererKind> | null>(null);
  // Keep the latest callbacks in a ref so they never force a remount.
  const cbRef = useRef<Pick<Materials3DProps<RendererKind>, "onReady" | "onFallback">>({});
  cbRef.current.onReady = props.onReady;
  cbRef.current.onFallback = props.onFallback;

  // Serialising is not free (lamps, items, post), so it runs only when a flat prop changed.
  const key = useMemo(
    () => configKey(props),
    [
      props.preset,
      props.lamps,
      props.lampGain,
      props.background,
      props.transparentBackground,
      props.clearGlass,
      props.post,
      props.motion,
      props.scatter,
      props.orbit,
      props.quality,
      props.dprMax,
      props.paused,
      props.config,
    ],
  );
  // The key the live handle was last given, so the update effect can tell a real change from its
  // own first run (and from StrictMode's replay), both of which the mount effect already covered.
  const appliedKeyRef = useRef<string | null>(null);

  // A stable object that delegates to whichever handle is live, so a ref taken before the shell
  // mounted, or across a StrictMode remount, keeps working.
  useImperativeHandle(
    ref,
    () => ({
      get state() {
        return handleRef.current?.state ?? IDLE_STATE;
      },
      get renderer() {
        return handleRef.current?.renderer ?? null;
      },
      snapshot: (opts) => handleRef.current?.snapshot(opts) ?? Promise.resolve(null),
      set: (config) => handleRef.current?.set(config),
      play: () => handleRef.current?.play(),
      pause: () => handleRef.current?.pause(),
      destroy: () => handleRef.current?.destroy(),
    }),
    [],
  );

  // Mount once. StrictMode double-mount is safe: destroy() aborts a pending upgrade, and the
  // pre-upgrade create/destroy is DOM-only (poster + IntersectionObserver).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const options: MaterialOptions<RendererKind> = {
      poster: props.poster,
      posterFit: props.posterFit,
      lazy: props.lazy,
      webgl: props.webgl,
      renderer: props.renderer,
      respectReducedMotion: props.respectReducedMotion,
      minSizeForWebGL: props.minSizeForWebGL,
      onReady: (r) => cbRef.current.onReady?.(r),
      onFallback: (reason) => cbRef.current.onFallback?.(reason),
    };
    const handle = createMaterials<RendererKind>(
      container,
      buildConfig(syncBase(props.preset), props),
      options,
    );
    handleRef.current = handle;
    appliedKeyRef.current = key;
    // A string preset resolves asynchronously; stage the real config once it loads. This is the
    // one set a mount makes: the update effect below sees the key it already applied and skips.
    if (typeof props.preset === "string") {
      void resolveBase(props.preset).then((base) => {
        if (!cancelled && handleRef.current === handle) handle.set(buildConfig(base, props));
      });
    }
    return () => {
      cancelled = true;
      handle.destroy();
      handleRef.current = null;
      appliedKeyRef.current = null;
    };
    // Mount-time only (options are captured once; config changes flow through the effect below).
  }, []);

  // Push config changes (flat props / config / preset) to the live handle.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle || appliedKeyRef.current === key) return;
    appliedKeyRef.current = key;
    const apply = (base: SceneConfig): void => {
      if (handleRef.current === handle) handle.set(buildConfig(base, props));
    };
    if (typeof props.preset === "string") void resolveBase(props.preset).then(apply);
    else apply(syncBase(props.preset));
    // Re-runs only when the serialized config (`key`) changes; `props` is read fresh inside.
  }, [key]);

  return (
    <div ref={containerRef} className={className} style={style}>
      {children}
    </div>
  );
}

const Materials3DWithRef = forwardRef(Materials3DInner);
Materials3DWithRef.displayName = "Materials3D";

/**
 * A drop-in, self-optimizing refractive-glass scene. Renders a `<div>` (SSR-safe; pass an
 * `<img data-materials3d-poster>` child for a server-rendered poster) and, on the client, mounts the
 * shell: poster-first, lazy, WebGL/reduced-motion/save-data aware, with the engine code-split out.
 *
 * A `ref` receives the {@link MaterialHandle} (`state`, `renderer`, `snapshot()`, `set()`,
 * `play()`, `pause()`), on React 18 and 19 alike. `forwardRef` keeps the generic engine parameter
 * only through this cast, which is why the component is declared this way.
 */
export const Materials3D = Materials3DWithRef as unknown as <R extends RendererKind = "webgl">(
  props: Materials3DProps<R> & { ref?: Ref<MaterialHandle<R>> },
) => ReactElement;

export default Materials3D;
export type {
  SceneConfig,
  MaterialHandle,
  FallbackReason,
  SnapshotOptions,
} from "@materials3d/core";
