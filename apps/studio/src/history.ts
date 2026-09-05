/**
 * Undo/redo as a snapshot timeline.
 *
 * The whole document is one plain-JSON `SceneConfig`, so a committed version is just a deep clone
 * and restoring reuses main.ts's existing apply path. This class owns only the timeline, the
 * cursor, and the commit/coalescing bookkeeping; it holds no reference to the renderer or panel.
 *
 * Model: a linear list of `entries` with a `cursor` marking the current version. Editing while the
 * cursor is behind the tip truncates the forward (redo) branch. The floating history panel renders
 * `getState()` and jumps to any entry by its stable `id`.
 *
 * Coalescing is what makes it usable: dragging a slider fires hundreds of changes, and one entry
 * per frame would bury the timeline. `markDirty` debounces, and main.ts flushes on pointer-up, so
 * a gesture becomes one step.
 */

import type { SceneConfig, ShapeConfig } from "@materials3d/core";

/** One committed version in the timeline. */
interface Entry {
  id: number;
  /** History-owned clone, with any large media swapped for a reference (see MediaStore). Nothing
   *  hands this out without cloning and resolving it again. */
  config: SceneConfig;
  /** Cached fingerprint, so the no-op guard never re-serializes a stored entry. */
  fingerprint: string;
  /** Human label shown in the list ("lamp gain", "Skewer", "shuffle lamps"). */
  label: string;
  /** Which preset the picker should show when this entry is applied. */
  presetName: string;
  time: number;
}

/** What a restore hands back to main.ts. */
export interface Restored {
  config: SceneConfig;
  presetName: string;
}

/** Snapshot of the timeline for the floating UI. */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  entries: Array<{ id: number; label: string; time: number; current: boolean }>;
}

export interface HistoryDeps {
  /** Reads the live config. It is replaced on every scene swap; never capture it. */
  getLive: () => SceneConfig;
  /** The current preset name, tagged onto a manual-edit commit. */
  getPresetName: () => string;
  /** Fired whenever the timeline or cursor changes, so the UI can re-render. */
  onChange: () => void;
}

/** How long a cleared timeline can be brought back, in ms. The toast offering it lives as long. */
export const CLEAR_UNDO_MS = 4000;

/** The scene-level fields that can hold a data URI the size of a file. */
const MEDIA_KEYS = ["backgroundImageUrl", "backgroundVideoUrl"] as const;

/** Every shape in a config whose `model` can hold one: the items' and the scatter template's. */
function modelShapes(config: SceneConfig): ShapeConfig[] {
  const shapes = config.items.map((item) => item.shape);
  if (config.scatter?.shape) shapes.push(config.scatter.shape);
  return shapes;
}
/** Strings shorter than this travel inside the clone; longer ones are held once, out of line. A
 *  hosted URL is well under it and the data URI of any real image or video is megabytes over. */
const INLINE_LIMIT = 2048;
const REF_PREFIX = "m3d-media#";

/**
 * Out-of-line storage for a backdrop or a `.glb` picked from disk.
 *
 * A 20 MB video as a data URI would otherwise be deep-cloned into every entry, serialized for
 * every fingerprint and diff label, and retained eighty times over. Held once here and keyed by a
 * short reference that the entries carry instead; strings are immutable, so handing the same
 * payload back out on a restore copies nothing.
 *
 * A picked model is the same problem one level down: it hangs off a shape rather than off the
 * config, so it needs a walk where the backdrop needs a key list. Everything else about it is
 * identical, which is why it shares this store rather than getting one of its own.
 */
class MediaStore {
  private readonly payloads = new Map<string, string>();
  private readonly refs = new Map<string, string>();
  private next = 1;

  /** The short reference standing in for one payload, minting it on first sight. */
  private ref(payload: string): string {
    let ref = this.refs.get(payload);
    if (!ref) {
      ref = `${REF_PREFIX}${this.next++}`;
      this.refs.set(payload, ref);
      this.payloads.set(ref, payload);
    }
    return ref;
  }

  /**
   * A copy of `config` with any large media swapped for a reference.
   *
   * Copies only the SPINE, never a payload: the top level, and, for a shape carrying a picked
   * model, the items array and that shape. Copying a payload on the way in is the one thing this
   * class exists to avoid, and the caller's live config must come back unmodified either way.
   */
  intern(config: SceneConfig): SceneConfig {
    const out = { ...config };
    for (const key of MEDIA_KEYS) {
      const value = out[key];
      if (typeof value !== "string" || value.length < INLINE_LIMIT) continue;
      out[key] = this.ref(value);
    }
    const big = (shape: ShapeConfig): boolean =>
      typeof shape.model === "string" && shape.model.length >= INLINE_LIMIT;
    if (modelShapes(config).some(big)) {
      out.items = config.items.map((item) =>
        big(item.shape)
          ? { ...item, shape: { ...item.shape, model: this.ref(item.shape.model as string) } }
          : item,
      );
      if (config.scatter && big(config.scatter.shape)) {
        out.scatter = {
          ...config.scatter,
          shape: { ...config.scatter.shape, model: this.ref(config.scatter.shape.model as string) },
        };
      }
    }
    return out;
  }

  /** Put the payloads back, in place. */
  resolve(config: SceneConfig): SceneConfig {
    for (const key of MEDIA_KEYS) {
      const value = config[key];
      if (typeof value === "string" && value.startsWith(REF_PREFIX)) {
        config[key] = this.payloads.get(value);
      }
    }
    for (const shape of modelShapes(config)) {
      if (shape.model?.startsWith(REF_PREFIX)) shape.model = this.payloads.get(shape.model);
    }
    return config;
  }

  /** Drop every payload that no entry references any more. */
  prune(held: Iterable<SceneConfig>): void {
    const used = new Set<string>();
    for (const config of held) {
      for (const key of MEDIA_KEYS) {
        const value = config[key];
        if (value?.startsWith(REF_PREFIX)) used.add(value);
      }
      for (const shape of modelShapes(config)) {
        if (shape.model?.startsWith(REF_PREFIX)) used.add(shape.model);
      }
    }
    for (const [ref, payload] of this.payloads) {
      if (used.has(ref)) continue;
      this.payloads.delete(ref);
      this.refs.delete(payload);
    }
  }
}

function fingerprint(c: SceneConfig): string {
  return JSON.stringify(c);
}

// Friendlier names for the config keys whose camelCase reads badly in a list.
const FRIENDLY: Record<string, string> = {
  lampGain: "lamp gain",
  lampGate: "lamp gate",
  backdropLamps: "lamps on backdrop",
  clearGlass: "clear glass",
  transparentBackground: "transparency",
  dprMax: "pixel ratio",
  timeOffset: "time offset",
  plate: "backplate",
  scatter: "shapes",
  items: "shapes",
  post: "post",
  motion: "motion",
  camera: "camera",
  lamps: "lamps",
};

function humanize(key: string): string {
  return (
    FRIENDLY[key] ??
    key
      .replace(/([A-Z])/g, " $1")
      .trim()
      .toLowerCase()
  );
}

/** Best-effort label for a manual edit: name the first field that differs. */
function diffLabel(prev: SceneConfig, next: SceneConfig): string {
  for (const key of Object.keys(next) as (keyof SceneConfig)[]) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) return humanize(key);
  }
  return "edit";
}

export class History {
  private entries: Entry[] = [];
  private cursor = -1;
  private nextId = 1;
  private dirty = false;
  private timer: number | undefined;
  private readonly media = new MediaStore();
  /** The timeline captured by the last clear(), so it can be restored once via undoClear(). */
  private clearedSnapshot?: { entries: Entry[]; cursor: number };
  private clearTimer: number | undefined;

  constructor(
    private readonly deps: HistoryDeps,
    private readonly cap = 80,
    private readonly delay = 350,
  ) {}

  /** Seed (or re-seed) the timeline with a single baseline entry: startup, or a shared link. */
  reset(config: SceneConfig, presetName: string, label = presetName): void {
    this.dropClearedSnapshot();
    this.seed(config, presetName, label);
  }

  /** Wipe back to a single baseline (keeping the live scene), remembering the old timeline so
   *  undoClear() can put it back within {@link CLEAR_UNDO_MS}. Like reset(), but reversible. */
  clear(config: SceneConfig, presetName: string): void {
    this.clearedSnapshot = { entries: this.entries.slice(), cursor: this.cursor };
    window.clearTimeout(this.clearTimer);
    this.clearTimer = window.setTimeout(() => this.dropClearedSnapshot(), CLEAR_UNDO_MS);
    this.seed(config, presetName, presetName);
  }

  /** Restore the timeline captured by the most recent clear(). No-op once that offer has lapsed. */
  undoClear(): boolean {
    const snapshot = this.clearedSnapshot;
    if (!snapshot) return false;
    this.clearedSnapshot = undefined;
    window.clearTimeout(this.clearTimer);
    this.cancelTimer();
    this.dirty = false;
    this.entries = snapshot.entries.slice();
    this.cursor = snapshot.cursor;
    this.deps.onChange();
    return true;
  }

  /** Note that the live config changed; schedules a debounced commit. */
  markDirty(): void {
    this.dirty = true;
    this.cancelTimer();
    this.timer = window.setTimeout(() => this.flush(), this.delay);
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /** Commit any pending edit now (a no-op if nothing is dirty, or nothing actually changed). */
  flush(): void {
    this.cancelTimer();
    if (this.dirty) this.commit(this.deps.getLive(), this.deps.getPresetName());
  }

  /**
   * Record `live` as a new committed version. Returns false if it equals the current entry.
   * Truncates any redo branch first. `label` is derived from a diff when omitted (the manual-edit
   * path); discrete actions pass their own.
   */
  commit(live: SceneConfig, presetName: string, label?: string): boolean {
    this.cancelTimer();
    this.dirty = false;
    // Interned first, so the fingerprint and the diff never serialize a media payload.
    const interned = this.media.intern(live);
    const print = fingerprint(interned);
    const current = this.entries[this.cursor] as Entry | undefined;
    if (current && print === current.fingerprint) return false;
    const finalLabel = label ?? (current ? diffLabel(current.config, interned) : "edit");
    this.entries.length = this.cursor + 1; // drop the redo branch
    this.entries.push(this.makeEntry(interned, print, finalLabel, presetName));
    this.cursor = this.entries.length - 1;
    let evicted = false;
    while (this.entries.length > this.cap) {
      this.entries.shift();
      this.cursor--;
      evicted = true;
    }
    if (evicted) this.media.prune(this.heldConfigs());
    this.deps.onChange();
    return true;
  }

  undo(): Restored | null {
    return this.cursor <= 0 ? null : this.goTo(this.cursor - 1);
  }

  redo(): Restored | null {
    return this.cursor >= this.entries.length - 1 ? null : this.goTo(this.cursor + 1);
  }

  /** Jump to an entry by its stable id; safely no-ops if that id was truncated away. */
  jumpToId(id: number): Restored | null {
    const index = this.entries.findIndex((e) => e.id === id);
    return index < 0 || index === this.cursor ? null : this.goTo(index);
  }

  getState(): HistoryState {
    return {
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.entries.length - 1,
      entries: this.entries.map((e, i) => ({
        id: e.id,
        label: e.label,
        time: e.time,
        current: i === this.cursor,
      })),
    };
  }

  /** A fresh, resolved clone of an entry's config (for rendering its thumbnail), safe to mutate;
   *  null if the id is unknown. */
  getConfigById(id: number): SceneConfig | null {
    const entry = this.entries.find((e) => e.id === id);
    return entry ? this.media.resolve(structuredClone(entry.config)) : null;
  }

  private seed(config: SceneConfig, presetName: string, label: string): void {
    this.cancelTimer();
    this.dirty = false;
    const interned = this.media.intern(config);
    this.entries = [this.makeEntry(interned, fingerprint(interned), label, presetName)];
    this.cursor = 0;
    this.media.prune(this.heldConfigs());
    this.deps.onChange();
  }

  private dropClearedSnapshot(): void {
    window.clearTimeout(this.clearTimer);
    if (!this.clearedSnapshot) return;
    this.clearedSnapshot = undefined;
    this.media.prune(this.heldConfigs());
  }

  /** Every config still holding a media reference: the timeline plus a pending clear snapshot. */
  private *heldConfigs(): Iterable<SceneConfig> {
    for (const entry of this.entries) yield entry.config;
    for (const entry of this.clearedSnapshot?.entries ?? []) yield entry.config;
  }

  private goTo(index: number): Restored {
    this.cursor = index;
    this.dirty = false;
    this.cancelTimer();
    this.deps.onChange();
    const entry = this.entries[index];
    // A FRESH clone: the renderer normalizes and mutates whatever it is handed, so a restore must
    // never alias the entry we keep in the timeline.
    return {
      config: this.media.resolve(structuredClone(entry.config)),
      presetName: entry.presetName,
    };
  }

  /** `interned` is a shallow copy already free of media payloads; the deep clone here is what
   *  isolates the entry from the live config. */
  private makeEntry(
    interned: SceneConfig,
    print: string,
    label: string,
    presetName: string,
  ): Entry {
    return {
      id: this.nextId++,
      config: structuredClone(interned),
      fingerprint: print,
      label,
      presetName,
      time: Date.now(),
    };
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
