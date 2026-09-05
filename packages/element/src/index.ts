import { createMaterials, mergeSceneConfig } from "@materials3d/core";
import type {
  EngineFor,
  RendererKind,
  FallbackReason,
  SceneConfig,
  MaterialHandle,
  MaterialOptions,
  TiltStatus,
} from "@materials3d/core";

/** The attributes a live element answers to. The shell options are read once at mount instead. */
const LIVE_ATTRIBUTES = ["config", "src", "preset", "transparent", "paused"] as const;

// SSR-safe base: `class extends HTMLElement` evaluates HTMLElement at import time, which throws
// under Node. Fall back to a dummy base there, the element is never instantiated server-side
// (register() is guarded), so the missing DOM methods are never called.
const ElementBase: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (function Materials3DElementBase() {} as unknown as typeof HTMLElement);

/**
 * `<materials-3d>`: the framework-agnostic drop-in (Vue/Svelte/plain HTML). Light DOM, `display:block`.
 *
 * Config attributes: `config` (JSON), `src` (URL to a config JSON), `preset` (name) and
 * `transparent` (drop the backdrop; `"false"` or `"0"` keeps it), merged in that order, each one
 * level deep (see `mergeSceneConfig`), then the `config` property last. `paused` starts and stops
 * playback. These are LIVE: a change after mount is pushed to the running scene. A `src` is
 * fetched once per URL and a `preset` resolved once per name, so an update re-reads neither.
 *
 * Shell options: `poster`, `poster-fit` (`fill` | `cover` | `contain`), `lazy`, `webgl`
 * (`auto` | `force` | `off`), `min-size` (CSS px) and `renderer` (`webgl`, the default, or
 * `webgpu` for the experimental node engine, a separate bundle). Read once at mount; changing one
 * on a live element does nothing until it is re-connected (the same contract as the React
 * wrapper's mount-time props).
 *
 * Also a `config` property and a read-only `handle` getter. Emits `materials3d-ready` (detail =
 * renderer) and `materials3d-fallback` (detail = reason).
 */
export class Materials3DElement extends ElementBase {
  static get observedAttributes(): string[] {
    return [...LIVE_ATTRIBUTES];
  }

  #handle: MaterialHandle | null = null;
  #config: Partial<SceneConfig> = {};
  #debounce?: ReturnType<typeof setTimeout>;
  /**
   * Which connect the in-flight `#mount` belongs to. `#mount` awaits the config, and a
   * disconnect + reconnect during that await queues a SECOND mount, without this check both
   * would finish and the first handle would be overwritten undestroyed (a leaked renderer).
   */
  #mountId = 0;
  /** The preset the last build resolved, so an update to another attribute skips the import. */
  #preset: { name: string; make: () => Partial<SceneConfig> } | null = null;
  /** The last `src` fetched successfully; a failed fetch is not cached, so the next update retries. */
  #src: { url: string; config: Partial<SceneConfig> } | null = null;

  /** The live shell handle (null before connect / after disconnect). */
  get handle(): MaterialHandle | null {
    return this.#handle;
  }

  /**
   * Explicitly ask for the device-orientation sensor. OPTIONAL, and on iOS it opens a modal
   * permission dialog — nothing calls it for you, and a decorative scene should simply go without
   * tilt there. CALL IT FROM A USER GESTURE (iOS grants the sensor only from inside a tap handler)
   * and only once `materials3d-ready` has fired — before that there is no renderer to ask, and the
   * replayed request has left the gesture.
   */
  enableTilt(): Promise<boolean> {
    return this.#handle?.enableTilt() ?? Promise.resolve(false);
  }

  /** Where the tilt sensor stands. `"prompt"` is exactly when a tap-to-enable affordance helps. */
  tiltStatus(): TiltStatus {
    return this.#handle?.tiltStatus() ?? "prompt";
  }

  /** Take the next orientation reading as the neutral pose (the reader has changed grip). */
  recenterTilt(): void {
    this.#handle?.recenterTilt();
  }

  /** Programmatic config, merged last (over the `preset`/`src`/`config` attributes). */
  get config(): Partial<SceneConfig> {
    return this.#config;
  }
  set config(value: Partial<SceneConfig>) {
    this.#config = value ?? {};
    this.#scheduleUpdate();
  }

  connectedCallback(): void {
    if (!this.style.display) this.style.display = "block";
    void this.#mount(++this.#mountId);
  }

  disconnectedCallback(): void {
    this.#mountId++; // invalidate a mount still awaiting its config
    clearTimeout(this.#debounce);
    this.#handle?.destroy();
    this.#handle = null;
  }

  attributeChangedCallback(name: string): void {
    if (!this.#handle) return;
    if (name === "paused") {
      if (this.#boolAttr("paused")) this.#handle.pause();
      else this.#handle.play();
    } else {
      this.#scheduleUpdate();
    }
  }

  async #mount(id: number): Promise<void> {
    const config = await this.#buildConfig();
    if (id !== this.#mountId || !this.isConnected) return; // superseded while the config resolved
    const minSize = Number(this.getAttribute("min-size"));
    const options: MaterialOptions<RendererKind> = {
      poster: this.getAttribute("poster") ?? undefined,
      posterFit: (this.getAttribute("poster-fit") as MaterialOptions["posterFit"]) ?? undefined,
      lazy: this.#boolAttr("lazy"),
      webgl: (this.getAttribute("webgl") as MaterialOptions["webgl"]) ?? undefined,
      minSizeForWebGL: Number.isFinite(minSize) && minSize > 0 ? minSize : undefined,
      paused: this.#boolAttr("paused"),
      // `renderer="webgpu"` fetches the node-renderer build. Anything else, including absent, is
      // the default WebGL engine, the option is opt-in precisely because it is a second bundle.
      renderer: this.getAttribute("renderer") === "webgpu" ? "webgpu" : undefined,
      onReady: (renderer: EngineFor<RendererKind>) =>
        this.dispatchEvent(new CustomEvent("materials3d-ready", { detail: renderer })),
      onFallback: (reason: FallbackReason) =>
        this.dispatchEvent(new CustomEvent("materials3d-fallback", { detail: reason })),
    };
    this.#handle = createMaterials<RendererKind>(this, config, options);
  }

  /** default ← preset ← src JSON ← config attribute ← config property, one level deep each. */
  async #buildConfig(): Promise<Partial<SceneConfig>> {
    let base: Partial<SceneConfig> = {};
    const presetName = this.getAttribute("preset");
    if (presetName) {
      if (this.#preset?.name !== presetName) {
        const { PRESETS, isPresetName } = await import("@materials3d/core/presets");
        const make = isPresetName(presetName)
          ? PRESETS[presetName]
          : (): Partial<SceneConfig> => ({});
        this.#preset = { name: presetName, make };
      }
      base = this.#preset.make();
    }
    const src = this.getAttribute("src");
    if (src) {
      if (this.#src?.url !== src) {
        try {
          const json: unknown = await fetch(src).then((r) => r.json());
          if (json && typeof json === "object" && !Array.isArray(json)) {
            this.#src = { url: src, config: json as Partial<SceneConfig> };
          }
        } catch {
          // ignore a failed/invalid config fetch; fall through to whatever we have
        }
      }
      // Cloned so the cache never shares an object with a config the shell may go on to hold.
      if (this.#src?.url === src) base = mergeSceneConfig(base, structuredClone(this.#src.config));
    }
    const transparent = this.#boolAttr("transparent");
    if (transparent !== undefined) base = { ...base, transparentBackground: transparent };
    return mergeSceneConfig(
      mergeSceneConfig(base, parseJson(this.getAttribute("config"))),
      this.#config,
    );
  }

  #scheduleUpdate(): void {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      void this.#update();
    }, 50);
  }

  async #update(): Promise<void> {
    const handle = this.#handle;
    if (!handle) return;
    const config = await this.#buildConfig();
    if (this.#handle !== handle) return; // destroyed or remounted while the config resolved
    handle.set(config);
  }

  /** Presence = true; `"false"`/`"0"` = false; absent = undefined (shell default). */
  #boolAttr(name: string): boolean | undefined {
    if (!this.hasAttribute(name)) return undefined;
    const value = this.getAttribute(name);
    return value !== "false" && value !== "0";
  }
}

function parseJson(json: string | null): Partial<SceneConfig> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Partial<SceneConfig>;
  } catch {
    return {};
  }
}

/** Define the element (idempotent, SSR/Node-import-safe). */
export function register(tag = "materials-3d"): void {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (!customElements.get(tag)) customElements.define(tag, Materials3DElement);
}

// Self-register on import so a bare `import "@materials3d/element"` makes <materials-3d> work. Guarded so
// importing under Node (SSR) is a no-op rather than a ReferenceError.
register();

declare global {
  interface HTMLElementTagNameMap {
    /** So `document.querySelector("materials-3d")` types as the element. */
    "materials-3d": Materials3DElement;
  }
}

export type {
  SceneConfig,
  MaterialHandle,
  FallbackReason,
  SnapshotOptions,
} from "@materials3d/core";
