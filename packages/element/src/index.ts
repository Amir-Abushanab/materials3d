import { createMaterials } from "@materials3d/core";
import type {
  EngineFor,
  RendererKind,
  FallbackReason,
  SceneConfig,
  MaterialHandle,
  MaterialOptions,
} from "@materials3d/core";

const OBSERVED = [
  "config",
  "src",
  "preset",
  "poster",
  "poster-fit",
  "paused",
  "lazy",
  "webgl",
  "min-size",
  "transparent",
] as const;

// SSR-safe base: `class extends HTMLElement` evaluates HTMLElement at import time, which throws
// under Node. Fall back to a dummy base there — the element is never instantiated server-side
// (register() is guarded), so the missing DOM methods are never called.
const ElementBase: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (function Materials3DElementBase() {} as unknown as typeof HTMLElement);

/**
 * `<materials-3d>` — the framework-agnostic drop-in (Vue/Svelte/plain HTML). Light DOM, `display:block`.
 *
 * Attributes: `config` (JSON), `src` (URL to a config JSON), `preset` (name), `poster`,
 * `poster-fit` (`fill` | `cover` | `contain`), `paused`, `lazy`, `webgl`, `min-size`,
 * `transparent`. Also a `config` property and a read-only `handle` getter. Emits `materials3d-ready` (detail = renderer)
 * and `materials3d-fallback` (detail = reason).
 *
 * `poster`, `poster-fit`, `lazy`, `webgl` and `min-size` are shell OPTIONS, read once at mount —
 * changing them on a live element does nothing until it is re-connected (same contract as the
 * React wrapper's mount-time props). The config-shaped attributes and `paused` are live.
 */
export class Materials3DElement extends ElementBase {
  static get observedAttributes(): string[] {
    return [...OBSERVED];
  }

  #handle: MaterialHandle | null = null;
  #config: Partial<SceneConfig> = {};
  #debounce?: ReturnType<typeof setTimeout>;
  /**
   * Which connect the in-flight `#mount` belongs to. `#mount` awaits the config, and a
   * disconnect + reconnect during that await queues a SECOND mount — without this check both
   * would finish and the first handle would be overwritten undestroyed (a leaked renderer).
   */
  #mountId = 0;

  /** The live shell handle (null before connect / after disconnect). */
  get handle(): MaterialHandle | null {
    return this.#handle;
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
      // the default WebGL engine — the option is opt-in precisely because it is a second bundle.
      renderer: this.getAttribute("renderer") === "webgpu" ? "webgpu" : undefined,
      onReady: (renderer: EngineFor<RendererKind>) =>
        this.dispatchEvent(new CustomEvent("materials3d-ready", { detail: renderer })),
      onFallback: (reason: FallbackReason) =>
        this.dispatchEvent(new CustomEvent("materials3d-fallback", { detail: reason })),
    };
    this.#handle = createMaterials<RendererKind>(this, config, options);
  }

  /** default ← preset ← src JSON ← config attribute ← config property. */
  async #buildConfig(): Promise<Partial<SceneConfig>> {
    let base: Partial<SceneConfig> = {};
    const presetName = this.getAttribute("preset");
    if (presetName) {
      const { PRESETS } = await import("@materials3d/core/presets");
      base = PRESETS[presetName]?.() ?? {};
    }
    const src = this.getAttribute("src");
    if (src) {
      try {
        base = { ...base, ...(await fetch(src).then((r) => r.json())) };
      } catch {
        // ignore a failed/invalid config fetch — fall through to whatever we have
      }
    }
    const transparent = this.#boolAttr("transparent");
    if (transparent !== undefined) base.transparentBackground = transparent;
    return { ...base, ...parseJson(this.getAttribute("config")), ...this.#config };
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

export type {
  SceneConfig,
  MaterialHandle,
  FallbackReason,
  SnapshotOptions,
} from "@materials3d/core";
