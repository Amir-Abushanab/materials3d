/**
 * Undo/redo as a snapshot timeline.
 *
 * The whole document is one plain-JSON `SceneConfig`, so a committed version is just a deep clone
 * and restoring reuses main.ts's existing apply path. This class owns only the timeline, the
 * cursor, and the commit/coalescing bookkeeping — it holds no reference to the renderer or panel.
 *
 * Model: a linear list of `entries` with a `cursor` marking the current version. Editing while the
 * cursor is behind the tip truncates the forward (redo) branch. The floating history panel renders
 * `getState()` and jumps to any entry by its stable `id`.
 *
 * Coalescing is what makes it usable: dragging a slider fires hundreds of changes, and one entry
 * per frame would bury the timeline. `markDirty` debounces, and main.ts flushes on pointer-up, so
 * a gesture becomes one step.
 */

import type { SceneConfig } from "@materials3d/core";

/** One committed version in the timeline. */
interface Entry {
  id: number;
  /** History-owned clone. Nothing hands this out without cloning again. */
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
  /** Reads the live config. It is replaced on every scene swap — never capture it. */
  getLive: () => SceneConfig;
  /** The current preset name, tagged onto a manual-edit commit. */
  getPresetName: () => string;
  /** Fired whenever the timeline or cursor changes, so the UI can re-render. */
  onChange: () => void;
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
  /** The timeline captured by the last clear(), so it can be restored once via undoClear(). */
  private clearedSnapshot?: { entries: Entry[]; cursor: number };

  constructor(
    private readonly deps: HistoryDeps,
    private readonly cap = 80,
    private readonly delay = 350,
  ) {}

  /** Seed (or re-seed) the timeline with a single baseline entry — startup, or a shared link. */
  reset(config: SceneConfig, presetName: string, label = presetName): void {
    this.cancelTimer();
    this.dirty = false;
    this.entries = [this.makeEntry(config, label, presetName)];
    this.cursor = 0;
    this.deps.onChange();
  }

  /** Wipe back to a single baseline (keeping the live scene), remembering the old timeline so
   *  undoClear() can put it back once. Like reset(), but reversible. */
  clear(config: SceneConfig, presetName: string): void {
    this.clearedSnapshot = { entries: this.entries.slice(), cursor: this.cursor };
    this.reset(config, presetName);
  }

  /** Restore the timeline captured by the most recent clear(). No-op if there is nothing to. */
  undoClear(): boolean {
    const snapshot = this.clearedSnapshot;
    if (!snapshot) return false;
    this.clearedSnapshot = undefined;
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
    const current = this.entries[this.cursor] as Entry | undefined;
    if (current && fingerprint(live) === current.fingerprint) return false;
    const finalLabel = label ?? (current ? diffLabel(current.config, live) : "edit");
    this.entries.length = this.cursor + 1; // drop the redo branch
    this.entries.push(this.makeEntry(live, finalLabel, presetName));
    this.cursor = this.entries.length - 1;
    while (this.entries.length > this.cap) {
      this.entries.shift();
      this.cursor--;
    }
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

  /** The stored config for an entry id (for rendering its thumbnail); null if unknown. */
  getConfigById(id: number): SceneConfig | null {
    return this.entries.find((e) => e.id === id)?.config ?? null;
  }

  dispose(): void {
    this.cancelTimer();
  }

  private goTo(index: number): Restored {
    this.cursor = index;
    this.dirty = false;
    this.cancelTimer();
    this.deps.onChange();
    const entry = this.entries[index];
    // A FRESH clone: the renderer normalizes and mutates whatever it is handed, so a restore must
    // never alias the entry we keep in the timeline.
    return { config: structuredClone(entry.config), presetName: entry.presetName };
  }

  private makeEntry(config: SceneConfig, label: string, presetName: string): Entry {
    const clone = structuredClone(config);
    return {
      id: this.nextId++,
      config: clone,
      fingerprint: fingerprint(clone),
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
