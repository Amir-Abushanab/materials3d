/**
 * Direct manipulation of shapes in the viewport: select them, drag them, turn them, resize them.
 *
 * The selection box and its handles are **DOM**, not scene geometry. An in-scene gizmo would go
 * through the same four passes as everything else (depth of field would soften it, haze would
 * fade it out at the bottom of the frame, and the saturation bloom would smear it), which is
 * exactly wrong for a control that has to stay crisp and clickable. Projecting each shape's bounds
 * to screen space and drawing an ordinary overlay keeps the UI sharp and the hit-testing simple.
 *
 * MULTI-SELECT. The selection is a list, and every gesture operates on all of it. The important
 * consequence is the PIVOT: a group rotates and scales about the selection's own centre, not about
 * each shape's, so a turned selection swings as one object rather than each piece spinning in
 * place. With a single shape selected that centre IS its origin, so all the group maths collapses
 * to exactly the previous single-shape behaviour.
 *
 * GROUPS ride on top of that: a persistent group is nothing more than a selection that reassembles
 * itself. Any pick that lands on a member expands to the whole group, so a group moves, turns and
 * scales as one object using the very same code an ad-hoc multi-selection does. Alt-click (or a
 * second double-click) DRILLS IN and selects the one shape, which is the escape hatch every app
 * with grouping needs.
 *
 * Everything here reports intent through hooks; the config edits and history commits live in
 * main.ts. The one thing it does read out of the config is group membership, through core's own
 * `expandToGroups`: what a group means for a selection has to be defined in exactly one place,
 * and the panel needs the same answer.
 */

import * as THREE from "three";
import { expandToGroups, type MaterialItem, type ItemConfig } from "@materials3d/core";
import type { MaterialRenderer } from "@materials3d/core/renderer";
import { injectStyle, shortcutBlocked } from "../util/dom";

export interface SelectionHooks {
  /** A drag or resize started, used to flush a history step before the change. */
  onEditStart(): void;
  /** Continuous during a gesture: write the live transform back into the item's config. */
  onTransform(item: MaterialItem): void;
  /** The gesture ended; commit it as one history entry with this label. */
  onEditEnd(label: string): void;
  /** Selection changed. The LAST entry is the primary one, what the panel scrolls to. */
  onSelect(items: readonly MaterialItem[]): void;
  /** Called after a successful pick, before selecting. Return true if the scene was rebuilt (a
   *  generated scene has to be baked into real shapes first), so the pick can be repeated against
   *  the new items. */
  prepareSelection(): boolean;
  /** Bind the current selection into one persistent group. */
  onGroup(items: readonly MaterialItem[]): void;
  /** Dissolve every group the selection touches. */
  onUngroup(items: readonly MaterialItem[]): void;
  /** A group's display name, for the badge. The overlay only ever sees the id. */
  groupName(id: string): string;
  /** Delete these shapes. */
  onDelete(items: readonly MaterialItem[]): void;
}

type Handle = "nw" | "ne" | "se" | "sw";

const HANDLES: Handle[] = ["nw", "ne", "se", "sw"];

/**
 * Real controls parked inside the host: today, the export frame's corner handles. Presses on
 * them are never selection gestures, and this listener runs on the CAPTURE phase, so it sees them
 * before the control does and cannot be waved off after the fact by `setInteractive`. The
 * overlay's own handles are plain divs, so they are unaffected.
 */
const CHROME = "button";

/** Is this event aimed at host chrome rather than at the scene? */
function onChrome(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CHROME) !== null;
}

/** Below this the box is a dot and the handles overlap; a shape that small isn't draggable by
 *  its box anyway, so the overlay hides rather than becoming a hazard. */
const MIN_BOX = 14;

/** A press that travels less than this is a click, not a marquee. */
const MARQUEE_SLOP = 4;

/** Radians per pixel of drag. A ~300px sweep turns a shape most of the way round, which is about
 *  the effort a deliberate reorientation should cost. */
const ROTATE_SPEED = 0.01;

/** How long the box keeps tracking after the last input while the scene is paused. Covers the
 *  camera's own easing after an orbit or a wheel step, which runs on past the event. */
const SETTLE_MS = 1500;

/** The gestures are not guessable, and a tooltip on the box is where someone will look for them
 *  the moment a drag does something they did not expect. */
const BOX_TITLE =
  "drag to move · shift-drag for depth · right-drag to rotate · shift-right-drag to roll · " +
  "corners scale · shift-click a shape to add it · ⌘G groups · alt-click drills into a group";

/** Degrees, not the radians the config stores: nobody dials an angle in radians, and the badge
 *  exists to be read mid-gesture. */
function deg(radians: number): string {
  return `${Math.round(THREE.MathUtils.radToDeg(radians))}°`;
}

/** World units, to one decimal: the same numbers the panel's position row shows, at the precision
 *  you can actually steer to by hand. */
function unit(value: number): string {
  return value.toFixed(1);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-item state captured at the start of a gesture, so every frame works from the same origin. */
interface ItemStart {
  item: MaterialItem;
  home: THREE.Vector3;
  scale: THREE.Vector3;
}

interface DragState {
  kind: "move" | "resize" | "rotate";
  handle?: Handle;
  /** Offset from the drag-plane hit point to the pressed shape's origin, so it doesn't jump. */
  grab: { x: number; y: number; z: number };
  /** Distance from the box centre at grab time, for resize ratios. */
  startRadius: number;
  startClientY: number;
  /** Previous pointer position; rotation is incremental, so it works from the delta. */
  lastX: number;
  lastY: number;
  moved: boolean;
  /** Where every selected shape started, and the point the group turns about. */
  starts: ItemStart[];
  centre: THREE.Vector3;
}

interface MarqueeState {
  startX: number;
  startY: number;
  /** Adding to the selection rather than replacing it. */
  additive: boolean;
  /** Set once the pointer travels past the slop; before that it is still a click. */
  live: boolean;
  /** The selection to add to, captured at press. */
  base: MaterialItem[];
}

export class SelectionOverlay {
  private readonly el: HTMLDivElement;
  private readonly box: HTMLDivElement;
  private readonly handles = new Map<Handle, HTMLDivElement>();
  private readonly hint: HTMLDivElement;
  private readonly marqueeEl: HTMLDivElement;
  /** One faint outline per selected shape, so the selection's MEMBERS are visible and not just
   *  the box around them. Pooled: a marquee changes the count on every pointer move. */
  private readonly outlines: HTMLDivElement[] = [];
  private selected: MaterialItem[] = [];
  /** True when the selection was made by drilling INTO a group, so it must not re-expand. */
  private pierced = false;
  private drag?: DragState;
  private marquee?: MarqueeState;
  // Scratch, allocated once: these run on every pointer move.
  private readonly axis = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly step = new THREE.Quaternion();
  private readonly pose = new THREE.Quaternion();
  private readonly offset = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private raf = 0;
  /** While the scene is paused the box only needs to track until the camera settles after an
   *  input; past this the loop stops rather than repainting a still frame. */
  private idleUntil = 0;
  private lastBox = "";
  private disposed = false;
  /** Stood down while something else owns the stage; see `setInteractive`. */
  private inert = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly renderer: MaterialRenderer,
    private readonly hooks: SelectionHooks,
  ) {
    injectStyle("g3-sel-style", CSS);
    this.el = document.createElement("div");
    this.el.className = "g3-sel";
    this.el.hidden = true;

    this.box = document.createElement("div");
    this.box.className = "g3-sel-box";
    this.box.title = BOX_TITLE;
    for (const handle of HANDLES) {
      const el = document.createElement("div");
      el.className = `g3-sel-handle is-${handle}`;
      el.dataset.handle = handle;
      this.handles.set(handle, el);
      this.box.appendChild(el);
    }
    this.hint = document.createElement("div");
    this.hint.className = "g3-sel-hint";
    this.box.appendChild(this.hint);
    this.el.appendChild(this.box);

    this.marqueeEl = document.createElement("div");
    this.marqueeEl.className = "g3-sel-marquee";
    this.marqueeEl.hidden = true;
    host.appendChild(this.marqueeEl);
    host.appendChild(this.el);

    // Capture phase, because the renderer's own orbit handler is bound to the canvas and would
    // otherwise start an orbit under the drag.
    host.addEventListener("dblclick", this.onDoubleClick);
    host.addEventListener("pointerdown", this.onPointerDown, true);
    host.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    // The renderer's own orbit and dolly move the camera under a paused scene; these are what
    // restart the tracking loop once it has gone quiet.
    host.addEventListener("pointerdown", this.wake, true);
    host.addEventListener("pointermove", this.onHostMove, true);
    host.addEventListener("wheel", this.wake, { passive: true, capture: true });
  }

  /** The primary selection, the last one added. */
  get item(): MaterialItem | null {
    return this.selected[this.selected.length - 1] ?? null;
  }

  get items(): readonly MaterialItem[] {
    return this.selected;
  }

  /**
   * Turn every direct-manipulation gesture on or off.
   *
   * The stage is shared: dragging the export frame's corner is a gesture over the very same pixels
   * a marquee sweeps, and a second pointer on the canvas mid-resize would otherwise start one
   * underneath it. Whatever takes the stage says so here, and anything already in flight is
   * finished rather than left half-steered.
   */
  setInteractive(enabled: boolean): void {
    if (this.inert === !enabled) return;
    this.inert = !enabled;
    if (this.inert) this.endGestures();
  }

  /** Replace the selection with one shape (or clear it), pulling in its group. */
  select(item: MaterialItem | null): void {
    this.setSelection(item ? [item] : []);
  }

  /**
   * Replace the selection.
   *
   * `whole` is the group policy: by default any shape pulls its whole group in with it, which is
   * what makes a group behave as one object from every entry point: click, marquee, shift-click,
   * and the panel's "locate". Pass false to select exactly what was asked for, which is the
   * drilled-in case.
   */
  setSelection(items: readonly MaterialItem[], whole = true): void {
    // Snapshot first: `wholeGroup()` below reads the live selection, so it has to be assigned
    // before the comparison, which therefore needs the old values kept aside.
    const was = { items: this.selected, pierced: this.pierced, group: this.el.dataset.group };
    const next = whole ? this.expand(items) : [...new Set(items)];
    const pierced = !whole && next.length > 0;
    this.selected = next;
    this.pierced = pierced;
    // A real group gets its own look, so "these move together permanently" is distinguishable
    // from "I happen to have five things selected".
    const group = this.wholeGroup();
    // Note that the group is part of what makes this the "same" selection: ⌘G re-asserts the very
    // same four shapes, and the only thing that changed is that they are now a group. Comparing
    // membership alone would return early and leave the box looking ad-hoc.
    const same =
      next.length === was.items.length &&
      next.every((v, i) => was.items[i] === v) &&
      pierced === was.pierced &&
      group === was.group;
    if (same) return;
    this.el.hidden = next.length === 0;
    this.el.dataset.count = String(next.length);
    if (group) this.el.dataset.group = group;
    else delete this.el.dataset.group;
    this.hooks.onSelect(this.selected);
    if (next.length > 0) this.startTracking();
    else this.stopTracking();
    this.sync();
  }

  /** Add or remove one shape, or its whole group, leaving the rest of the selection alone. */
  toggle(item: MaterialItem): void {
    const group = this.expand([item]);
    this.setSelection(
      this.selected.includes(item)
        ? this.selected.filter((v) => !group.includes(v))
        : [...this.selected, ...group],
    );
  }

  /**
   * Expand a set of shapes to include every sibling of any group they touch.
   *
   * The membership rule itself is core's `expandToGroups`, working on the configs; this maps the
   * answer back onto the live items. Going through the config rather than reimplementing the walk
   * over `item.config.group` is deliberate: the panel asks the same question, and two copies of
   * "what counts as the same group" would eventually disagree.
   */
  private expand(items: readonly MaterialItem[]): MaterialItem[] {
    const configs = items
      .map((item) => item.config)
      .filter((config): config is ItemConfig => Boolean(config));
    // Items added imperatively (and a still-generated scene) have no config to be grouped by.
    if (configs.length === 0) return [...new Set(items)];
    const wanted = new Set(expandToGroups(this.renderer.getConfig(), configs));
    const expanded = this.renderer
      .getItems()
      .filter((item) => item.config && wanted.has(item.config));
    // Anything config-less was dropped by that filter; put it back, or a mixed selection would
    // silently shed shapes.
    const loose = items.filter((item) => !item.config);
    return loose.length > 0 ? [...new Set([...expanded, ...loose])] : expanded;
  }

  /** The group id when the selection is exactly one whole group, else undefined. */
  private wholeGroup(): string | undefined {
    if (this.pierced || this.selected.length < 2) return undefined;
    const id = this.selected[0]?.config?.group;
    if (!id || !this.selected.every((item) => item.config?.group === id)) return undefined;
    return this.expand([this.selected[0]]).length === this.selected.length ? id : undefined;
  }

  /** Re-read the selected shapes' projected bounds and reposition the overlay. */
  sync = (): void => {
    if (this.disposed || this.selected.length === 0) return;

    // The group box is the union of the members' boxes, the same rectangle you would draw round
    // them by eye.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const boxes: Box[] = [];
    for (const item of this.selected) {
      const bounds = this.renderer.projectBounds(item);
      if (!bounds) continue;
      boxes.push(bounds);
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }
    this.paintOutlines(boxes);

    const width = maxX - minX;
    const height = maxY - minY;
    if (boxes.length === 0 || width < MIN_BOX || height < MIN_BOX) {
      this.box.style.visibility = "hidden";
      return;
    }
    this.box.style.visibility = "visible";
    // This runs every frame while selected, so nothing is written unless it moved: a style write
    // is a style invalidation even when the value is the same.
    const key = `${minX},${minY},${width},${height}`;
    if (key !== this.lastBox) {
      this.lastBox = key;
      this.box.style.transform = `translate(${minX}px, ${minY}px)`;
      this.box.style.width = `${width}px`;
      this.box.style.height = `${height}px`;
    }
    const badge = this.badge();
    if (this.hint.textContent !== badge) this.hint.textContent = badge;
  };

  dispose(): void {
    // A gesture in flight is finished, not abandoned: the engine switch rebuilds this overlay,
    // and a drag left half-way would leave a shape displaced with no history entry naming it.
    this.endGestures();
    this.disposed = true;
    this.stopTracking();
    this.host.removeEventListener("dblclick", this.onDoubleClick);
    this.host.removeEventListener("pointerdown", this.onPointerDown, true);
    this.host.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    this.host.removeEventListener("pointerdown", this.wake, true);
    this.host.removeEventListener("pointermove", this.onHostMove, true);
    this.host.removeEventListener("wheel", this.wake, true);
    this.marqueeEl.remove();
    this.el.remove();
  }

  /** Mid-gesture the badge reports the value being steered; otherwise it names the selection. */
  private badge(): string {
    const primary = this.item;
    if (!primary) return "";
    switch (this.drag?.kind) {
      case "rotate": {
        const r = primary.homeRotation;
        return `↻ ${deg(r.x)} · ${deg(r.y)} · ${deg(r.z)}`;
      }
      case "move": {
        const p = primary.home;
        return `✥ ${unit(p.x)} · ${unit(p.y)} · ${unit(p.z)}`;
      }
      case "resize":
        return `⤢ ${primary.mesh.scale.x.toFixed(2)}×`;
      default:
        break;
    }
    const group = this.wholeGroup();
    if (group) return `⧉ ${this.hooks.groupName(group)} · ${this.selected.length}`;
    if (this.selected.length > 1) return `${this.selected.length} shapes`;
    const scale = primary.mesh.scale.x;
    const inside = this.pierced && primary.config?.group;
    return (
      `${primary.config?.name ?? primary.config?.shape.kind ?? "shape"}` +
      (Math.abs(scale - 1) > 0.005 ? ` · ${scale.toFixed(2)}×` : "") +
      // Say which group you are inside, or a drilled-in shape looks like an ungrouped one and the
      // next click "mysteriously" grabs four more shapes.
      (inside ? ` · in ${this.hooks.groupName(inside)}` : "")
    );
  }

  /** Draw one faint outline per member. Only meaningful with more than one selected. */
  private paintOutlines(boxes: Box[]): void {
    const wanted = boxes.length > 1 ? boxes.length : 0;
    while (this.outlines.length < wanted) {
      const el = document.createElement("div");
      el.className = "g3-sel-outline";
      this.el.appendChild(el);
      this.outlines.push(el);
    }
    for (const [index, el] of this.outlines.entries()) {
      const bounds = boxes[index];
      if (index >= wanted || !bounds) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      const transform = `translate(${bounds.x}px, ${bounds.y}px)`;
      if (el.style.transform !== transform) el.style.transform = transform;
      const width = `${bounds.width}px`;
      if (el.style.width !== width) el.style.width = width;
      const height = `${bounds.height}px`;
      if (el.style.height !== height) el.style.height = height;
    }
  }

  // The scene animates and the camera orbits, so a selected shape moves under the box every
  // frame. A private rAF loop keeps them together without coupling to the render loop, which is
  // itself stopped whenever the scene is paused or offscreen. Paused, with no gesture in flight
  // and no input for a while, nothing under the box can move, so the loop stops too.
  private startTracking(): void {
    this.idleUntil = performance.now() + SETTLE_MS;
    if (this.raf) return;
    const tick = (): void => {
      if (this.disposed || this.selected.length === 0) {
        this.raf = 0;
        return;
      }
      this.sync();
      const still =
        this.renderer.getConfig().paused &&
        !this.drag &&
        !this.marquee &&
        performance.now() > this.idleUntil;
      this.raf = still ? 0 : requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Any input that can move the camera restarts tracking, or extends it. */
  private wake = (): void => {
    if (this.selected.length > 0) this.startTracking();
  };

  private onHostMove = (event: PointerEvent): void => {
    if (event.buttons !== 0) this.wake();
  };

  private stopTracking(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Pick a shape, baking the scene first if it is still generated. */
  private pickAt(clientX: number, clientY: number): MaterialItem | null {
    let hit = this.renderer.pick(clientX, clientY);
    // Only prepare when something was actually hit: baking a scene because someone clicked the
    // backdrop would be a surprising edit.
    if (hit) {
      const index = this.renderer.getItems().indexOf(hit);
      if (this.hooks.prepareSelection()) {
        // Baking rebuilds every item, so the object just hit no longer exists. Re-pick, and fall
        // back to the same index if that misses: baking preserves order and count, so it is the
        // same shape.
        hit = this.renderer.pick(clientX, clientY) ?? this.renderer.getItems()[index] ?? null;
      }
    }
    return hit;
  }

  private onDoubleClick = (event: MouseEvent): void => {
    if (this.inert || onChrome(event.target)) return;
    // Double-click still means "just this one". Building a selection is a modifier-click or a
    // marquee; this is the gesture that throws the rest away.
    const hit = this.pickAt(event.clientX, event.clientY);
    // A SECOND double-click, on a shape whose group is already selected, drills in to that one
    // shape, the way every app with grouping lets you reach a member without ungrouping. Only
    // from the group's own selection, so a stray double-click never silently escapes the group.
    if (hit && !this.pierced && hit.config?.group && this.selected.includes(hit)) {
      this.setSelection([hit], false);
      return;
    }
    this.select(hit);
  };

  private onContextMenu = (event: MouseEvent): void => {
    // Right-drag rotates a selection and orbits the camera, so the menu would fire on the end of
    // almost every one.
    event.preventDefault();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    // The shared guard: not in a text field or a dropdown, not behind the code dialog, and not
    // on key repeat. ⌘G is the browser's find-again and Backspace is its Back, and a panel input
    // has the focus for most of the time anyone spends in the studio.
    if (this.inert || shortcutBlocked(event)) return;
    if (event.key === "Escape") {
      if (this.selected.length === 0) return;
      event.preventDefault();
      this.setSelection([]);
      return;
    }
    const group = event.key.toLowerCase() === "g" && (event.metaKey || event.ctrlKey);
    // Delete and Backspace both, because which one is "the" delete key depends on the keyboard,
    // and ⌘⌫ falls out of this for nothing, for the Finder habit.
    const remove = event.key === "Delete" || event.key === "Backspace";
    if (!group && !remove) return;
    // Host chrome counts as a field too: arrow-nudging the export frame's corner is not a moment
    // to delete shapes.
    if (onChrome(event.target)) return;
    if (this.selected.length === 0) return;
    event.preventDefault();
    if (remove) this.hooks.onDelete(this.selected);
    else if (event.shiftKey) this.hooks.onUngroup(this.selected);
    else this.hooks.onGroup(this.selected);
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (this.inert || onChrome(event.target)) return;
    if (event.button !== 0 && event.button !== 2) return;
    const handle = (event.target as HTMLElement).dataset?.handle as Handle | undefined;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;

    // Alt-click reaches THROUGH a group to the one shape under the pointer, without dissolving
    // anything. The direct route to a member; double-clicking twice is the discoverable one.
    if (event.altKey && handle === undefined && event.button === 0) {
      const hit = this.pickAt(event.clientX, event.clientY);
      if (hit) {
        event.preventDefault();
        event.stopPropagation();
        this.setSelection([hit], false);
        return;
      }
    }

    // Modifier + click on a shape edits the selection instead of starting a gesture: the way to
    // build one precisely when a marquee would catch the wrong neighbours.
    if (additive && handle === undefined && event.button === 0) {
      const hit = this.pickAt(event.clientX, event.clientY);
      if (hit) {
        event.preventDefault();
        event.stopPropagation();
        this.toggle(hit);
        return;
      }
    }

    const over = handle !== undefined || this.hitsSelection(event.clientX, event.clientY);
    if (!over) {
      // Empty space. Left starts a marquee; right falls through so the renderer can orbit.
      if (event.button === 0) this.startMarquee(event, additive);
      return;
    }

    // The press is ours: stop it reaching the canvas, or the camera orbits under the drag.
    event.preventDefault();
    event.stopPropagation();
    this.startDrag(event, handle);
  };

  /**
   * Finish whatever gesture is in flight, as if the pointer had been released. Used when the
   * overlay is stood down mid-gesture: abandoning outright would leave a half-dragged shape
   * displaced with no history entry naming the move.
   */
  private endGestures(): void {
    if (this.drag) this.onPointerUp();
    if (this.marquee) {
      // Counted as travelled, so a cut-short marquee does not read as a click on empty space and
      // clear a selection the user never pressed on.
      this.marquee.live = true;
      this.onMarqueeUp();
    }
  }

  /** Is this point over one of the selected shapes? */
  private hitsSelection(clientX: number, clientY: number): boolean {
    if (this.selected.length === 0) return false;
    const hit = this.renderer.pick(clientX, clientY);
    return hit !== null && this.selected.includes(hit);
  }

  // ------------------------------------------------------------- gestures ---

  private startDrag(event: PointerEvent, handle?: Handle): void {
    const primary = this.item;
    if (!primary) return;

    // `home`, the authored pose, not `mesh.position`, which a running motion has already
    // displaced. Measuring the grab against the animated pose is what makes a drag on a moving
    // shape fight the animation and drift.
    const origin = primary.home;
    const hit = this.renderer.pointOnDragPlane(event.clientX, event.clientY, origin);
    const centre = this.boxCentre();

    const starts: ItemStart[] = this.selected.map((item) => ({
      item,
      home: item.home.clone(),
      scale: item.mesh.scale.clone(),
    }));
    // The pivot is the mean of the members' origins, the 3D counterpart of the box you can see.
    // With one shape selected this IS its origin, so every formula below reduces to the
    // single-shape case exactly.
    const pivot = new THREE.Vector3();
    for (const start of starts) pivot.add(start.home);
    pivot.divideScalar(Math.max(1, starts.length));

    this.drag = {
      kind: event.button === 2 ? "rotate" : handle ? "resize" : "move",
      handle,
      grab: hit
        ? { x: origin.x - hit.x, y: origin.y - hit.y, z: origin.z - hit.z }
        : { x: 0, y: 0, z: 0 },
      startRadius: Math.max(8, Math.hypot(event.clientX - centre.x, event.clientY - centre.y)),
      startClientY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      starts,
      centre: pivot,
    };
    this.el.classList.add("is-dragging");
    this.el.dataset.gesture = this.drag.kind;
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    this.sync();
  }

  /** The group box's centre, in client coordinates. */
  private boxCentre(): { x: number; y: number } {
    const rect = this.box.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || this.selected.length === 0) return;
    if (!drag.moved) {
      drag.moved = true;
      this.hooks.onEditStart();
    }

    if (drag.kind === "rotate") this.rotate(drag, event);
    else if (drag.kind === "resize") this.resize(drag, event);
    else this.move(drag, event);

    for (const start of drag.starts) this.hooks.onTransform(start.item);
    this.sync();
  };

  private move(drag: DragState, event: PointerEvent): void {
    const primary = this.item;
    if (!primary) return;

    if (event.shiftKey) {
      // Shift moves along the view axis: the FULL view direction, not just its world-Z part,
      // or the gesture dies once the camera is orbited off-axis. Screen-plane dragging can't
      // reach depth at all, and depth is what puts one rod behind another.
      const direction = this.renderer.viewDirection();
      const depth = ((event.clientY - drag.startClientY) / 100) * 6;
      this.delta.copy(direction).multiplyScalar(depth);
    } else {
      const hit = this.renderer.pointOnDragPlane(event.clientX, event.clientY, primary.home);
      if (!hit) return;
      const primaryStart = drag.starts.find((s) => s.item === primary);
      if (!primaryStart) return;
      // ONE shared delta, measured from the shape actually under the pointer and applied to all,
      // so the selection keeps its internal arrangement instead of collapsing together.
      this.delta.set(
        hit.x + drag.grab.x - primaryStart.home.x,
        hit.y + drag.grab.y - primaryStart.home.y,
        hit.z + drag.grab.z - primaryStart.home.z,
      );
    }

    for (const start of drag.starts) {
      start.item.home.copy(start.home).add(this.delta);
      // Mirror to the mesh for immediate feedback. A motion overwrites only the components it
      // drives (drift owns Y, skewer owns one rotation axis) on the next frame, so the gesture
      // and the animation compose instead of fighting.
      start.item.mesh.position.copy(start.item.home);
    }
  }

  private resize(drag: DragState, event: PointerEvent): void {
    const centre = this.boxCentre();
    const radius = Math.hypot(event.clientX - centre.x, event.clientY - centre.y);
    // Uniform, and about the selection's centre: a glass shape's optical path is tied to its
    // proportions, so squashing one axis would change how it absorbs light, not just its size.
    const factor = Math.max(0.05, radius / drag.startRadius);
    for (const start of drag.starts) {
      start.item.mesh.scale.copy(start.scale).multiplyScalar(factor);
      // Positions scale about the pivot too, or a group would grow through itself instead of
      // spreading apart.
      this.offset.copy(start.home).sub(drag.centre).multiplyScalar(factor);
      start.item.home.copy(drag.centre).add(this.offset);
      start.item.mesh.position.copy(start.item.home);
    }
  }

  /**
   * Turn the selection by a pointer delta, about the CAMERA's axes rather than the world's.
   *
   * Dragging right should tip the shape the way it looks like it should tip, whatever angle the
   * camera has been orbited to; rotating about world X/Y instead would send it turning in a
   * direction the pointer never moved once the view is off-axis. Horizontal turns about the
   * camera's up, vertical about its right, and shift rolls about the view axis, which is the third
   * degree of freedom a two-axis drag cannot otherwise reach.
   *
   * Every member takes the SAME quaternion and, crucially, has its POSITION swung about the
   * selection's centre by it too. Turning each shape in place would leave the group facing new
   * directions while occupying the same footprint, which reads as a glitch rather than as one
   * object turning.
   */
  private rotate(drag: DragState, event: PointerEvent): void {
    const dx = (event.clientX - drag.lastX) * ROTATE_SPEED;
    const dy = (event.clientY - drag.lastY) * ROTATE_SPEED;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    const camera = this.renderer.camera;

    // Build this move's incremental turn once, then apply it to every member.
    if (event.shiftKey) {
      this.renderer.viewDirection(this.axis);
      this.step.setFromAxisAngle(this.axis, -dx);
    } else {
      this.axis.setFromMatrixColumn(camera.matrixWorld, 1).normalize(); // camera up
      this.step.setFromAxisAngle(this.axis, dx);
      this.axis.setFromMatrixColumn(camera.matrixWorld, 0).normalize(); // camera right
      this.step.premultiply(this.turn.setFromAxisAngle(this.axis, dy));
    }

    const many = drag.starts.length > 1;
    for (const start of drag.starts) {
      // Turn the AUTHORED orientation. Composing onto the mesh instead would fold whatever angle a
      // spinning motion happens to be at into the shape's resting pose, so it would creep every
      // time you nudged it.
      this.pose.setFromEuler(start.item.homeRotation);
      this.pose.premultiply(this.step);
      start.item.homeRotation.setFromQuaternion(this.pose);
      start.item.mesh.rotation.copy(start.item.homeRotation);
      if (!many) continue;
      this.offset.copy(start.item.home).sub(drag.centre).applyQuaternion(this.step);
      start.item.home.copy(drag.centre).add(this.offset);
      start.item.mesh.position.copy(start.item.home);
    }
  }

  private onPointerUp = (): void => {
    const drag = this.drag;
    this.drag = undefined; // cleared first: sync() below reads it to choose what the badge shows
    this.el.classList.remove("is-dragging");
    delete this.el.dataset.gesture;
    // Explicitly, not via the rAF tick: that stops whenever the tab is hidden, and the badge would
    // otherwise sit on the angle readout after the gesture ended.
    this.sync();
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    if (!drag?.moved) return;
    const noun = drag.starts.length > 1 ? `${drag.starts.length} shapes` : "shape";
    this.hooks.onEditEnd(
      drag.kind === "resize"
        ? `resize ${noun}`
        : drag.kind === "rotate"
          ? `rotate ${noun}`
          : `move ${noun}`,
    );
  };

  // -------------------------------------------------------------- marquee ---

  private startMarquee(event: PointerEvent, additive: boolean): void {
    // Deliberately NOT preventDefault'd yet: a press that never travels is a click, and the
    // camera's orbit handler should still get it. The marquee only takes over once the pointer
    // has actually moved.
    this.marquee = {
      startX: event.clientX,
      startY: event.clientY,
      additive,
      live: false,
      base: [...this.selected],
    };
    window.addEventListener("pointermove", this.onMarqueeMove);
    window.addEventListener("pointerup", this.onMarqueeUp);
    window.addEventListener("pointercancel", this.onMarqueeUp);
  }

  private onMarqueeMove = (event: PointerEvent): void => {
    const marquee = this.marquee;
    if (!marquee) return;
    const dx = event.clientX - marquee.startX;
    const dy = event.clientY - marquee.startY;
    if (!marquee.live && Math.hypot(dx, dy) < MARQUEE_SLOP) return;
    marquee.live = true;

    const rect = this.host.getBoundingClientRect();
    const x = Math.min(marquee.startX, event.clientX) - rect.left;
    const y = Math.min(marquee.startY, event.clientY) - rect.top;
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    this.marqueeEl.hidden = false;
    this.marqueeEl.style.transform = `translate(${x}px, ${y}px)`;
    this.marqueeEl.style.width = `${width}px`;
    this.marqueeEl.style.height = `${height}px`;

    // Live preview, like every other marquee: you see what you are about to get. Rebuilt from the
    // captured base each move so shrinking the band releases what it no longer covers.
    const caught = this.itemsIn(x, y, width, height);
    this.setSelection(marquee.additive ? [...marquee.base, ...caught] : caught);
  };

  private onMarqueeUp = (): void => {
    const marquee = this.marquee;
    this.marquee = undefined;
    this.marqueeEl.hidden = true;
    window.removeEventListener("pointermove", this.onMarqueeMove);
    window.removeEventListener("pointerup", this.onMarqueeUp);
    window.removeEventListener("pointercancel", this.onMarqueeUp);
    // A press that never travelled is a click on empty space: clear, the way every canvas does.
    if (marquee && !marquee.live && !marquee.additive) this.setSelection([]);
  };

  /** Shapes whose projected box intersects this rectangle, in host coordinates. */
  private itemsIn(x: number, y: number, width: number, height: number): MaterialItem[] {
    // Bake first: a marquee over a generated scene has nothing selectable to return, and the whole
    // gesture would silently do nothing.
    this.hooks.prepareSelection();
    const out: MaterialItem[] = [];
    for (const item of this.renderer.getItems()) {
      const bounds = this.renderer.projectBounds(item);
      if (!bounds) continue;
      // Intersects, not contains: catching only fully-enclosed shapes makes a marquee feel broken
      // the moment one end of a tall rod sits outside the sweep.
      const overlaps =
        bounds.x < x + width &&
        bounds.x + bounds.width > x &&
        bounds.y < y + height &&
        bounds.y + bounds.height > y;
      if (overlaps) out.push(item);
    }
    return out;
  }
}

const CSS = `
/* The layer itself never takes pointer events: only the box and its handles do, so a click in
   empty space still reaches the canvas. */
.g3-sel{position:absolute;inset:0;pointer-events:none;z-index:5;}
.g3-sel[hidden]{display:none;}
.g3-sel-box{position:absolute;top:0;left:0;box-sizing:border-box;pointer-events:auto;cursor:move;
  border:1px solid var(--accent);border-radius:3px;
  background:color-mix(in srgb,var(--accent) 7%,transparent);
  box-shadow:0 0 0 1px rgb(255 255 255 / 55%);}
.g3-sel.is-dragging .g3-sel-box{background:color-mix(in srgb,var(--accent) 12%,transparent);}
/* A PERSISTENT group, as opposed to an ad-hoc multi-selection: doubled edge, so "these stay
   together" is visibly different from "I have five things selected right now". */
.g3-sel[data-group] .g3-sel-box{outline:1px solid color-mix(in srgb,var(--accent) 45%,transparent);
  outline-offset:3px;}
/* Members of a multi-selection, so the group box is not the only thing saying what is in it. */
.g3-sel-outline{position:absolute;top:0;left:0;box-sizing:border-box;pointer-events:none;
  border:1px dashed color-mix(in srgb,var(--accent) 55%,transparent);border-radius:2px;}
.g3-sel-outline[hidden]{display:none;}
/* Any live gesture gets the accent ring, so "I am steering this" reads the same whichever one it
   is; only rotation dashes its edge, because a box being dragged and a box being turned otherwise
   look identical mid-gesture. */
.g3-sel[data-gesture] .g3-sel-box{
  box-shadow:0 0 0 1px rgb(255 255 255 / 55%),0 0 0 7px color-mix(in srgb,var(--accent) 16%,transparent);}
.g3-sel[data-gesture] .g3-sel-hint{font-variant-numeric:tabular-nums;}
.g3-sel[data-gesture="rotate"] .g3-sel-box{border-style:dashed;cursor:grabbing;
  background:color-mix(in srgb,var(--accent) 9%,transparent);}
/* The handles are inert during a move or a turn; dimming them says so. */
.g3-sel[data-gesture="rotate"] .g3-sel-handle,
.g3-sel[data-gesture="move"] .g3-sel-handle{opacity:.25;}
.g3-sel-handle{position:absolute;width:10px;height:10px;box-sizing:border-box;border-radius:2px;
  border:1px solid var(--accent);background:#fff;pointer-events:auto;
  box-shadow:0 1px 3px rgb(27 26 31 / 30%);}
.g3-sel-handle.is-nw{top:-5px;left:-5px;cursor:nwse-resize;}
.g3-sel-handle.is-ne{top:-5px;right:-5px;cursor:nesw-resize;}
.g3-sel-handle.is-se{bottom:-5px;right:-5px;cursor:nwse-resize;}
.g3-sel-handle.is-sw{bottom:-5px;left:-5px;cursor:nesw-resize;}
.g3-sel-hint{position:absolute;bottom:calc(100% + 6px);left:0;padding:2px 6px;border-radius:5px;
  background:var(--accent);color:#fff;white-space:nowrap;pointer-events:none;
  font-family:var(--mono);font-size:9.5px;letter-spacing:.04em;}
/* The rubber band. Inert: it is drawn, never pointed at. */
.g3-sel-marquee{position:absolute;top:0;left:0;box-sizing:border-box;pointer-events:none;z-index:5;
  border:1px solid var(--accent);border-radius:2px;
  background:color-mix(in srgb,var(--accent) 10%,transparent);}
.g3-sel-marquee[hidden]{display:none;}
`;
