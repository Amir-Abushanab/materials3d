/**
 * The undo/redo cluster and its version-history popover, docked in the control panel's header.
 *
 * Docked beside the title rather than floating over the stage: the stage is the thing being
 * designed, and a control parked on top of it covers the work.
 *
 * Purely a view: it renders a {@link HistoryState} and reports intents through hooks; the timeline
 * logic lives in `History` (src/history.ts). Builds its own DOM and injects its own stylesheet, so
 * the studio's CSS doesn't have to know it exists.
 */

import type { HistoryState } from "../history";
import { escapeHtml, injectStyle } from "../util/dom";

/** Minimal per-version thumbnail source (satisfied structurally by HistoryThumbnailer). */
interface HistoryThumbSource {
  cached(id: number): string | undefined;
  request(id: number, cb: (url: string | null) => void): void;
}

export interface HistoryControlsHooks {
  onUndo(): void;
  onRedo(): void;
  onJump(id: number): void;
  /** Clear the timeline back to a single baseline; the live scene is kept. */
  onClear(): void;
  /** Optional per-version previews; when present, each row shows one. */
  thumb?: HistoryThumbSource;
}

const isMac = /Mac/i.test(navigator.userAgent);
const UNDO_TIP = isMac ? "Undo · ⌘Z" : "Undo · Ctrl+Z";
const REDO_TIP = isMac ? "Redo · ⇧⌘Z" : "Redo · Ctrl+Y";

// Inline line icons so nothing depends on an icon font or the network.
const ICON = {
  undo: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
  help: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.5"/><path d="M12 16.9h.01"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
};

function relTime(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export class HistoryControls {
  private readonly el: HTMLDivElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly bar: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly list: HTMLUListElement;
  private open = false;
  private lastState: HistoryState = { canUndo: false, canRedo: false, entries: [] };
  private tick = 0;
  private scrollRaf = 0;

  constructor(
    host: HTMLElement,
    private readonly hooks: HistoryControlsHooks,
  ) {
    HistoryControls.injectStyle();
    this.el = document.createElement("div");
    this.el.className = "g3-hist";

    // The list is a popover anchored to the cluster, so it hangs over the panel below.
    this.panel = document.createElement("div");
    this.panel.className = "g3-hist-panel";
    this.panel.hidden = true;
    const head = document.createElement("div");
    head.className = "g3-hist-head";
    const title = document.createElement("span");
    title.textContent = "History";
    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button";
    this.clearBtn.className = "g3-hist-clear";
    this.clearBtn.dataset.act = "clear";
    this.clearBtn.textContent = "Clear";
    head.append(title, this.clearBtn);
    this.list = document.createElement("ul");
    this.list.className = "g3-hist-list";
    this.panel.append(head, this.list);

    const bar = document.createElement("div");
    this.bar = bar;
    bar.className = "g3-hist-bar";
    this.undoBtn = HistoryControls.mkBtn("undo", ICON.undo, "Undo", UNDO_TIP);
    this.redoBtn = HistoryControls.mkBtn("redo", ICON.redo, "Redo", REDO_TIP);
    this.toggleBtn = HistoryControls.mkBtn(
      "toggle",
      ICON.list,
      "Version history",
      "Version history",
    );
    bar.append(this.undoBtn, this.redoBtn, this.toggleBtn);

    this.el.append(this.panel, bar);
    this.el.addEventListener("click", this.onClick);
    if (this.hooks.thumb) this.list.addEventListener("scroll", this.onScroll);
    host.appendChild(this.el);
    this.render();
  }

  /**
   * A non-action "?" in the bar whose hover reveals the viewport gestures, each with an icon.
   *
   * A real element rather than the bar's shared `data-tip` pseudo-tooltip: that one can only carry
   * text through `content: attr(...)`, and an icon per row needs actual DOM. None of the gestures
   * are guessable (right-drag to rotate least of all), and this sits with undo/redo because that
   * is the cluster you look at when you have just done something you want to take back.
   */
  addHelp(rows: Array<{ icon: string; text: string }>): void {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "g3-hist-btn is-help";
    button.dataset.act = "help";
    button.innerHTML = ICON.help;
    button.setAttribute("aria-label", "Controls");

    const panel = document.createElement("div");
    panel.className = "g3-hist-help";
    panel.setAttribute("role", "tooltip");
    panel.id = "g3-controls-help";
    panel.innerHTML = rows
      .map(
        (row) =>
          `<span class="g3-hist-help-row"><span class="g3-hist-help-ic">${row.icon}</span>${escapeHtml(row.text)}</span>`,
      )
      .join("");
    button.setAttribute("aria-describedby", panel.id);
    button.append(panel);
    this.bar.append(button);
  }

  update(state: HistoryState): void {
    this.lastState = state;
    this.render();
  }

  private onClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button || button.getAttribute("aria-disabled") === "true") return;
    const act = button.dataset.act;
    if (act === "undo") this.hooks.onUndo();
    else if (act === "redo") this.hooks.onRedo();
    else if (act === "toggle") this.setOpen(!this.open);
    else if (act === "clear") this.hooks.onClear();
    else if (button.dataset.id) this.hooks.onJump(Number(button.dataset.id));
  };

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.hidden = !open;
    this.toggleBtn.setAttribute("aria-expanded", String(open));
    this.toggleBtn.classList.toggle("is-active", open);
    if (open) this.startTicking();
    else this.stopTicking();
    this.render();
  }

  private render(): void {
    this.setDisabled(this.undoBtn, !this.lastState.canUndo);
    this.setDisabled(this.redoBtn, !this.lastState.canRedo);
    // Nothing to clear when the timeline is just its baseline entry.
    this.setDisabled(this.clearBtn, this.lastState.entries.length <= 1);
    if (!this.open) return;
    // Newest (current) at the top, oldest at the bottom.
    const rows: string[] = [];
    for (let i = this.lastState.entries.length - 1; i >= 0; i--) {
      const e = this.lastState.entries[i];
      rows.push(
        `<li><button type="button" class="g3-hist-row${e.current ? " is-current" : ""}" data-id="${e.id}"` +
          `${e.current ? ' aria-current="true"' : ""}>` +
          `<span class="g3-hist-thumb"></span>` +
          `<span class="g3-hist-label">${escapeHtml(e.label)}</span>` +
          `<span class="g3-hist-time">${relTime(e.time)}</span>` +
          `</button></li>`,
      );
    }
    this.list.innerHTML = rows.join("") || '<li class="g3-hist-empty">Edits will appear here</li>';
    this.fillThumbs();
  }

  private onScroll = (): void => {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.fillThumbs();
    });
  };

  /**
   * Fill thumbnails for rows in (or near) the visible area: cached instantly, else rendered on
   * demand. Geometry-based rather than IntersectionObserver so it works when the tab isn't focused,
   * and stays lazy: an offscreen row is never rendered until it is scrolled near.
   */
  private fillThumbs(): void {
    const thumb = this.hooks.thumb;
    if (!thumb || !this.open) return;
    const view = this.list.getBoundingClientRect();
    const margin = 80;
    for (const row of this.list.querySelectorAll<HTMLElement>(".g3-hist-row")) {
      const id = Number(row.dataset.id);
      const cached = thumb.cached(id);
      if (cached) {
        this.setThumb(row, cached);
        continue;
      }
      if (row.dataset.req === "1") continue; // already requested for this row instance
      const rect = row.getBoundingClientRect();
      if (rect.bottom < view.top - margin || rect.top > view.bottom + margin) continue;
      row.dataset.req = "1";
      thumb.request(id, (url) => {
        if (!url) return;
        const el = this.list.querySelector<HTMLElement>(`.g3-hist-row[data-id="${id}"]`);
        if (el) this.setThumb(el, url);
      });
    }
  }

  private setThumb(row: HTMLElement, url: string): void {
    const el = row.querySelector<HTMLElement>(".g3-hist-thumb");
    if (el) el.style.backgroundImage = `url('${url}')`;
  }

  /** Update just the relative-time labels, so the tick never re-renders thumbnails. */
  private refreshTimes(): void {
    if (!this.open) return;
    for (const row of this.list.querySelectorAll<HTMLElement>(".g3-hist-row")) {
      const entry = this.lastState.entries.find((x) => x.id === Number(row.dataset.id));
      const time = row.querySelector(".g3-hist-time");
      if (entry && time) time.textContent = relTime(entry.time);
    }
  }

  // aria-disabled rather than the `disabled` attribute, so the shortcut tooltip still shows on
  // hover even when the action is unavailable.
  private setDisabled(button: HTMLButtonElement, disabled: boolean): void {
    button.setAttribute("aria-disabled", String(disabled));
    button.classList.toggle("is-disabled", disabled);
  }

  private startTicking(): void {
    if (this.tick) return;
    this.tick = window.setInterval(() => this.refreshTimes(), 20000);
  }

  private stopTicking(): void {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = 0;
    }
  }

  private static mkBtn(act: string, icon: string, label: string, tip: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "g3-hist-btn";
    b.dataset.act = act;
    b.innerHTML = icon;
    b.setAttribute("aria-label", label);
    b.setAttribute("data-tip", tip);
    return b;
  }

  private static injectStyle(): void {
    injectStyle(
      "g3-hist-style",
      `
.g3-hist{position:relative;display:inline-flex;font:12px/1.3 var(--sans);}
/* A pill, so the three read as one control group rather than three loose glyphs. The border is
   heavier than the panel's usual hairline because it sits on an almost-white panel. */
.g3-hist-bar{display:inline-flex;align-items:center;gap:1px;padding:2px;border-radius:9px;
  border:1px solid rgb(27 26 31 / 18%);background:#fff;}
/* No colour transition: it buys nothing here, and a paused transition (a background tab throttles
   them) leaves the icon stuck at the state it was leaving. */
.g3-hist-btn{position:relative;width:30px;height:28px;display:inline-flex;align-items:center;
  justify-content:center;border-radius:6px;border:1px solid transparent;background:transparent;
  color:var(--ink);cursor:pointer;transition:background .12s ease;}
.g3-hist-btn:hover:not(.is-disabled){background:rgb(27 26 31 / 8%);}
.g3-hist-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
/* Unavailable, not illegible. --ink-3 was light enough that two of the three read as smudges on a
   fresh page, where undo and redo are both disabled. Availability is carried by the cursor and the
   tooltip; the glyph still has to be a glyph. */
.g3-hist-btn.is-disabled{color:var(--ink-2);cursor:default;}
.g3-hist-btn.is-active{background:color-mix(in srgb,var(--accent) 16%,transparent);
  border-color:color-mix(in srgb,var(--accent) 40%,transparent);color:var(--accent);}
/* Tooltips hang BELOW: the cluster sits at the very top of the panel, so an upward tooltip
   would be clipped by the window edge. */
.g3-hist-bar [data-tip]::after{content:attr(data-tip);position:absolute;top:calc(100% + 7px);
  left:50%;transform:translateX(-50%) translateY(-3px);padding:4px 8px;border-radius:6px;
  white-space:nowrap;background:var(--ink);color:#fff;font-size:10.5px;
  font-variant-numeric:tabular-nums;box-shadow:0 4px 14px rgb(27 26 31 / 30%);pointer-events:none;
  opacity:0;transition:opacity .12s ease,transform .12s ease;z-index:30;}
.g3-hist-bar [data-tip]:hover::after,.g3-hist-btn[data-tip]:focus-visible::after{opacity:1;
  transform:translateX(-50%) translateY(0);}
/* The controls popover. Hangs from the button's right edge because the bar sits at the top-right
   of a 320px panel; centred, it would run off the window. */
.g3-hist-help{position:absolute;top:calc(100% + 7px);right:0;z-index:30;display:flex;
  flex-direction:column;gap:5px;width:max-content;max-width:250px;padding:8px 10px;
  border-radius:8px;background:var(--ink);color:#fff;text-align:left;font-size:10.5px;
  line-height:1.35;box-shadow:0 6px 20px rgb(27 26 31 / 34%);pointer-events:none;opacity:0;
  transform:translateY(-3px);transition:opacity .12s ease,transform .12s ease;}
.g3-hist-btn.is-help:hover .g3-hist-help,
.g3-hist-btn.is-help:focus-visible .g3-hist-help{opacity:1;transform:translateY(0);}
.g3-hist-help-row{display:flex;align-items:center;gap:7px;white-space:nowrap;}
/* Fixed-width icon column so the labels line up whatever each glyph's ink width is. */
.g3-hist-help-ic{flex:0 0 16px;display:inline-flex;align-items:center;justify-content:center;
  opacity:.92;}
.g3-hist-panel{position:absolute;right:0;top:calc(100% + 9px);width:252px;
  max-height:min(52vh,380px);display:flex;flex-direction:column;border-radius:12px;overflow:hidden;
  background:rgb(255 255 255 / 94%);border:1px solid var(--hair);z-index:20;
  box-shadow:0 16px 44px -16px rgb(27 26 31 / 45%);backdrop-filter:blur(16px) saturate(1.4);
  -webkit-backdrop-filter:blur(16px) saturate(1.4);}
.g3-hist-panel[hidden]{display:none;}
.g3-hist-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:7px 8px 7px 12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  font-size:9.5px;color:var(--ink-3);border-bottom:1px solid var(--hair);flex:0 0 auto;}
.g3-hist-clear{padding:2px 8px;border:1px solid var(--hair);border-radius:6px;background:transparent;
  color:var(--ink-2);font:inherit;font-size:9px;cursor:pointer;transition:background .12s ease;}
.g3-hist-clear:hover{background:rgb(27 26 31 / 7%);color:var(--ink);}
.g3-hist-clear:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
.g3-hist-clear.is-disabled{opacity:.4;cursor:default;pointer-events:none;}
.g3-hist-list{margin:0;padding:4px;list-style:none;overflow-y:auto;flex:1 1 auto;}
.g3-hist-list::-webkit-scrollbar{width:8px;}
.g3-hist-list::-webkit-scrollbar-thumb{background:rgb(27 26 31 / 16%);border-radius:8px;}
.g3-hist-row{width:100%;display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:7px;
  border:0;background:transparent;color:var(--ink);text-align:left;cursor:pointer;font:inherit;
  transition:background .1s ease;}
.g3-hist-row:hover{background:rgb(27 26 31 / 6%);}
.g3-hist-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}
.g3-hist-thumb{flex:0 0 auto;width:46px;height:26px;border-radius:4px;box-sizing:border-box;
  background:#f4f3f2 center/cover no-repeat;border:1px solid var(--hair);}
.g3-hist-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.g3-hist-time{flex:0 0 auto;color:var(--ink-3);font-variant-numeric:tabular-nums;font-size:10.5px;}
.g3-hist-row.is-current{background:color-mix(in srgb,var(--accent) 12%,transparent);}
.g3-hist-row.is-current .g3-hist-thumb{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);}
.g3-hist-empty{padding:10px 12px;color:var(--ink-3);}
`,
    );
  }
}
