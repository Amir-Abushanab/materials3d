/**
 * Thumbnail generation for the preset picker and the version history.
 *
 * Both use the same trick: ONE hidden, low-resolution MaterialRenderer that renders a config to a
 * still frame. Four passes per frame is expensive enough that spinning up a renderer per thumbnail
 * would be felt, and a shared one keeps a long history cheap.
 *
 * Preset thumbs are generated once, after first paint, one per idle callback, so the first
 * interactions are never queued behind eight full-pipeline renders. History thumbs are rendered
 * on demand, only when a row scrolls into view, because a timeline can be eighty entries long and
 * most are never looked at.
 */

import { MaterialRenderer } from "@materials3d/core/renderer";
import { createThumbHost, prepThumbConfig, renderThumbFrame } from "@materials3d/core/studio";
import type { SceneConfig } from "@materials3d/core";

// About twice the CSS size of the largest card (~118 px wide in the picker, 46 in a history row),
// so a retina screen is not upscaling, and no larger: startup renders one of these per preset.
const PRESET_W = 256;
const PRESET_H = 144;
const HISTORY_W = 160;
const HISTORY_H = 90;

const presetCache = new Map<string, string>();
let presetsStarted = false;

/** Run `task` when the browser is idle; Safari has no requestIdleCallback, so wait a frame there. */
function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => task(), { timeout: 1000 });
  } else {
    setTimeout(task, 16);
  }
}

/** The rendered thumbnail for a preset, or undefined until generation reaches it. */
export function getPresetThumb(name: string): string | undefined {
  return presetCache.get(name);
}

/**
 * Render a thumbnail for every preset, one per idle callback, calling `onReady` as each lands so
 * the picker fills in card by card behind its placeholders. Safe to call repeatedly.
 */
export function generatePresetThumbs(
  presets: Record<string, () => SceneConfig>,
  onReady: () => void,
): void {
  if (presetsStarted) return;
  presetsStarted = true;

  const queue = Object.entries(presets);
  let host: HTMLDivElement | null = null;
  let renderer: MaterialRenderer | null = null;
  const finish = (): void => {
    renderer?.dispose();
    host?.remove();
  };
  // Async since `renderThumbFrame` became so: a preset naming a `.glb` has to have it before its
  // thumbnail is worth taking. The queue is still driven one entry per idle callback, so the wait
  // costs the page nothing it was not already spending.
  const step = async (): Promise<void> => {
    const next = queue.shift();
    if (!next) {
      finish();
      return;
    }
    const [name, make] = next;
    try {
      const config = make();
      prepThumbConfig(config);
      host ??= createThumbHost(PRESET_W, PRESET_H);
      // Reduced motion must not freeze the offscreen renderer at a blank first frame.
      if (!renderer) renderer = new MaterialRenderer(host, config, { respectReducedMotion: false });
      else renderer.setConfig(config);
      const canvas = await renderThumbFrame(renderer, host);
      if (canvas) presetCache.set(name, canvas.toDataURL("image/webp", 0.9));
      onReady();
    } catch (error) {
      // A renderer that failed once will fail the rest the same way; the placeholders stay.
      console.warn(`Preset thumbnail for "${name}" failed:`, error);
      finish();
      return;
    }
    whenIdle(() => void step());
  };
  whenIdle(() => void step());
}

/** Lazy, queued thumbnails for history rows, keyed by entry id. */
export class HistoryThumbnailer {
  private readonly cache = new Map<number, string>();
  private readonly waiters = new Map<number, Array<(url: string | null) => void>>();
  private readonly queue: number[] = [];
  private running = false;
  private host?: HTMLDivElement;
  private renderer?: MaterialRenderer;

  /** `getConfig` must hand back a config this class may mutate: setConfig normalizes in place. */
  constructor(private readonly getConfig: (id: number) => SceneConfig | null) {}

  /** A synchronous cache hit, if this one is already rendered. */
  cached(id: number): string | undefined {
    return this.cache.get(id);
  }

  /** Get (or render) the thumbnail for an entry; `cb` fires with the data URL, or null on failure. */
  request(id: number, cb: (url: string | null) => void): void {
    const hit = this.cache.get(id);
    if (hit !== undefined) {
      cb(hit);
      return;
    }
    const waiting = this.waiters.get(id);
    if (waiting) {
      waiting.push(cb); // a render is already queued for this id
      return;
    }
    this.waiters.set(id, [cb]);
    this.queue.push(id);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift();
        if (id === undefined) break;
        let url: string | null = null;
        try {
          url = await this.renderOne(id);
        } catch (error) {
          console.warn("History thumbnail render failed:", error);
        }
        if (url) {
          this.cache.set(id, url);
          // The timeline caps at ~80 entries, but ids from truncated redo branches linger here;
          // evict the oldest past a generous ceiling so memory stays bounded.
          if (this.cache.size > 240) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
        }
        const callbacks = this.waiters.get(id) ?? [];
        this.waiters.delete(id);
        for (const cb of callbacks) cb(url);
        await new Promise((resolve) => setTimeout(resolve, 0)); // yield between renders
      }
    } finally {
      this.running = false;
    }
  }

  private async renderOne(id: number): Promise<string | null> {
    const config = this.getConfig(id);
    if (!config) return null;
    prepThumbConfig(config);
    if (!this.host) this.host = createThumbHost(HISTORY_W, HISTORY_H);
    if (!this.renderer) {
      this.renderer = new MaterialRenderer(this.host, config, { respectReducedMotion: false });
    } else {
      this.renderer.setConfig(config);
    }
    const out = await renderThumbFrame(this.renderer, this.host);
    return out ? out.toDataURL("image/webp", 0.8) : null;
  }
}
