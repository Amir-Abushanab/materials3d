"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { createDefaultConfig, createMaterials } from "@materials3d/core";
import type {
  FallbackReason,
  SceneConfig,
  MaterialHandle,
  MaterialOptions,
  MaterialRenderer,
  LampConfig,
  MotionConfig,
  PosterFit,
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
   *  through the `config` prop — a flat prop can only mean "all of them". */
  motion?: Partial<MotionConfig>;
  scatter?: Partial<ScatterConfig>;
  orbit?: boolean;
  quality?: number;
  dprMax?: number;
  paused?: boolean;
}

export interface Materials3DProps extends FlatProps {
  /** A preset: a function (tree-shakeable) or a name string (lazy-imports the presets chunk). */
  preset?: string | (() => Partial<SceneConfig>);
  /** Escape hatch: a full/partial config, applied last.
   *  Precedence: default ← preset ← flat props ← config. */
  config?: Partial<SceneConfig>;
  poster?: string;
  /** Poster `object-fit`. Default `"fill"` (matches the canvas → seamless handoff). */
  posterFit?: PosterFit;
  lazy?: boolean;
  webgl?: "auto" | "force" | "off";
  respectReducedMotion?: boolean;
  /** Stay a poster below this container size in CSS pixels. Four passes at phone DPR is real
   *  work, and a still frame of glass loses less than a still frame of most things. */
  minSizeForWebGL?: number;
  className?: string;
  style?: CSSProperties;
  /** Custom SSR poster markup, e.g. `<img data-materials3d-poster src="…" />` — the shell adopts it. */
  children?: ReactNode;
  onReady?: (renderer: MaterialRenderer) => void;
  onFallback?: (reason: FallbackReason) => void;
}

/** Resolve the base config: function preset (sync) → its config; string preset → lazy-load. */
async function resolveBase(preset: Materials3DProps["preset"]): Promise<SceneConfig> {
  if (typeof preset === "function") return { ...createDefaultConfig(), ...preset() };
  if (typeof preset === "string") {
    const { PRESETS } = await import("@materials3d/core/presets");
    const make = PRESETS[preset];
    if (make) return make();
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
function buildConfig(base: SceneConfig, props: Materials3DProps): Partial<SceneConfig> {
  if (props.lamps !== undefined) base.lamps = props.lamps;
  if (props.lampGain !== undefined) base.lampGain = props.lampGain;
  if (props.background !== undefined) base.background = props.background;
  if (props.transparentBackground !== undefined) {
    base.transparentBackground = props.transparentBackground;
  }
  if (props.clearGlass !== undefined) base.clearGlass = props.clearGlass;
  if (props.post !== undefined) base.post = { ...base.post, ...props.post };
  if (props.motion !== undefined) {
    const motion = props.motion;
    if (base.scatter) base.scatter.motion = { ...base.scatter.motion, ...motion };
    for (const item of base.items) item.motion = { ...item.motion, ...motion };
  }
  // A partial scatter merges onto whatever the preset authored, so `scatter={{ count: 24 }}` is
  // enough to re-scatter the reference scene.
  if (props.scatter !== undefined && base.scatter) {
    base.scatter = { ...base.scatter, ...props.scatter };
  }
  if (props.orbit !== undefined) base.orbit = props.orbit;
  if (props.quality !== undefined) base.quality = props.quality;
  if (props.dprMax !== undefined) base.dprMax = props.dprMax;
  if (props.paused !== undefined) base.paused = props.paused;
  return { ...base, ...props.config };
}

/**
 * Function presets are keyed by identity: swapping one function for another must re-run the update
 * effect, and a single string cannot say which function it saw. An inline (per-render) function
 * gets a fresh id each render, which re-runs the effect — `setConfig`'s structural diff makes that
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

/** A stable string that changes whenever the resolved config would — keys the update effect. */
function configKey(props: Materials3DProps): string {
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

/**
 * A drop-in, self-optimizing refractive-glass scene. Renders a `<div>` (SSR-safe; pass an
 * `<img data-materials3d-poster>` child for a server-rendered poster) and, on the client, mounts the
 * shell — poster-first, lazy, WebGL/reduced-motion/save-data aware, with the engine code-split out.
 */
export function Materials3D(props: Materials3DProps): ReactElement {
  const { className, style, children } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MaterialHandle | null>(null);
  // Keep the latest callbacks in a ref so they never force a remount.
  const cbRef = useRef<Pick<Materials3DProps, "onReady" | "onFallback">>({});
  cbRef.current.onReady = props.onReady;
  cbRef.current.onFallback = props.onFallback;

  // Mount once. StrictMode double-mount is safe: destroy() aborts a pending upgrade, and the
  // pre-upgrade create/destroy is DOM-only (poster + IntersectionObserver).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const options: MaterialOptions = {
      poster: props.poster,
      posterFit: props.posterFit,
      lazy: props.lazy,
      webgl: props.webgl,
      respectReducedMotion: props.respectReducedMotion,
      minSizeForWebGL: props.minSizeForWebGL,
      onReady: (r) => cbRef.current.onReady?.(r),
      onFallback: (reason) => cbRef.current.onFallback?.(reason),
    };
    const handle = createMaterials(container, buildConfig(syncBase(props.preset), props), options);
    handleRef.current = handle;
    // A string preset resolves asynchronously; stage the real config once it loads.
    if (typeof props.preset === "string") {
      void resolveBase(props.preset).then((base) => {
        if (!cancelled && handleRef.current === handle) handle.set(buildConfig(base, props));
      });
    }
    return () => {
      cancelled = true;
      handle.destroy();
      handleRef.current = null;
    };
    // Mount-time only (options are captured once; config changes flow through the effect below).
  }, []);

  // Push config changes (flat props / config / preset) to the live handle.
  const key = configKey(props);
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
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

export default Materials3D;
export type {
  SceneConfig,
  MaterialHandle,
  MaterialRenderer,
  FallbackReason,
  SnapshotOptions,
} from "@materials3d/core";
