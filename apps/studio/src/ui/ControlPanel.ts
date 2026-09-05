/**
 * The Tweakpane panel.
 *
 * One config object is the single source of truth: these bindings mutate **the renderer's own
 * config** in place and then report how expensive the change was. `structural` means geometry has
 * to be rebuilt (item count, shape kinds, quality, which also recompiles the post shader's tap
 * count); anything else is a uniform push, cheap enough to run on every slider frame.
 *
 * Every section opens expanded: there are only ten, and a collapsed panel hides the one knob that
 * turns out to matter for whatever you are fixing.
 */

import { Pane } from "tweakpane";
import type { RendererKind } from "@materials3d/core";
import { applySearch, clearSearch } from "./controlSearch";
import type { FolderApi } from "@tweakpane/core";
import { flashButtonError, flashButtonSuccess } from "./buttonFeedback";
import { GradientEditor } from "./GradientEditor";
import { MeshGradientEditor } from "./MeshGradientEditor";
import {
  applyLampPalette,
  createCut,
  createItem,
  createLamp,
  CUT_KINDS,
  groupLabel,
  LAMP_PALETTE_NAMES,
  createMaterial,
  isTransmissive,
  MATERIAL_KINDS,
  MATERIAL_PRESETS,
  METAL_F0,
  METAL_F82,
  MAX_CUTS,
  MAX_LAMPS,
  MAX_MESH_POINTS,
  MAX_STOPS,
  MOTION_KINDS,
  DEFAULT_OUTLINE,
  SHAPE_KINDS,
  defaultSides,
  type SceneConfig,
  type GroupConfig,
  type ItemConfig,
  type ItemInteractionBinding,
  type ItemInteractionTarget,
  type LampConfig,
  type LampInteractionBinding,
  type LampInteractionTarget,
  type MaterialConfig,
  type MotionConfig,
  type ScatterConfig,
  type ShapeConfig,
  type ShapeKind,
  type SceneInteractionBinding,
  type SceneInteractionTarget,
} from "@materials3d/core";
import {
  applyCustomExportDimension,
  applyExportPreset,
  aspectRatioLabel,
  canExportImageFormat,
  canRecordFormat,
  canRecordWebpAnimation,
  isFrameWalked,
  MAX_GIF_EDGE,
  captureExportAspectRatio,
  CUSTOM_EXPORT_PRESET,
  EXPORT_PRESETS,
  exportGpuWarning,
  gifEffectiveFps,
  IMAGE_FORMATS,
  MAX_OUTPUT_DIMENSION,
  MIN_OUTPUT_DIMENSION,
  type ExportSize,
  type ImageFormat,
  type RecordFormat,
} from "../output/formats";
import { PRESETS } from "@materials3d/core/presets";
import { applyIcons } from "./icons";
import { applyControlHints, hideControlHint } from "./controlHints";
import { PresetPicker } from "./PresetPicker";
import { presetLabel } from "../presetLabels";

type ChangeHandler = (structural: boolean) => void;

/** Studio-only view state. Deliberately NOT part of SceneConfig: a guide that ended up in the
 *  config would serialize into share links and exports, where it means nothing. */
export interface ViewState {
  /**
   * Show the export frame at one export pixel per CSS pixel, letting the stage scroll, instead of
   * scaling it to fit. The frame is otherwise always fitted, so the export dimensions change its
   * SHAPE but never its on-screen size, which is right for composing and useless for judging how
   * large anything actually is.
   */
  actualSize: boolean;
  grid: boolean;
  gridDivisions: number;
  gridCentre: boolean;
  /** Angle of the tilt guide, in degrees. 0 hides it. */
  gridTilt: number;
}

export interface PanelState {
  /**
   * Which engine to render with. NOT part of the scene: a config describes a picture, and which
   * renderer draws it is a property of this session, so it neither serializes nor exports.
   */
  renderer: RendererKind;
  imageFormat: ImageFormat;
  imageQuality: number;
  videoFormat: RecordFormat;
  recordSeconds: number;
  /** Frames per second for the frame-walked animated WebP. Ignored by the MediaRecorder formats,
   *  which run at whatever the scene sustains. */
  recordFps: number;
  recording: boolean;
  /** 0–1 while an animated WebP is being walked; the button shows it instead of a spinner. */
  recordProgress: number;
}

export interface PanelHooks {
  onChange: ChangeHandler;
  onExportImage(): void;
  onToggleRecord(): void;
  onExportEmbed(): void;
  onExportCode(): void;
  onEditConfig(): void;
  onSaveConfig(): void | Promise<void>;
  onLoadConfig(): void;
  onShare(): boolean | Promise<boolean>;
  /** Switch engines in place, keeping the scene. Async: the second engine is fetched on demand. */
  onRendererChange(kind: RendererKind): void | Promise<void>;
  /** Bundle the embed + wallpaper-app manifests into one .zip. */
  onExportWallpaper(): void | Promise<void>;
  /** Select this shape in the viewport, so the panel row and the scene agree on which one it is. */
  onLocateItem(index: number): void;
  /**
   * A generated shape was opened for editing: bake the scatter into real items, then reveal this
   * one. Generated shapes have nowhere to store an edit until that happens.
   */
  onBakeForEdit(index: number): void;
  /** A shape or a group was renamed; record it, since the name lives in the config. */
  onRenamed(label: string): void;
  /** Bind the viewport selection into one group. */
  onGroup(): void;
  /** Dissolve a group by id, or the groups the viewport selection touches when given nothing. */
  onUngroup(id?: string): void;
  /** Select a whole group in the viewport. */
  onLocateGroup(id: string): void;
  /** Delete these shapes. One route for every remove button, so they all clear the viewport
   *  selection, prune emptied groups and land on the timeline the same way. */
  onRemoveShapes(configs: ItemConfig[]): void;
  /** The configs of the shapes currently selected in the viewport, for a bulk edit. */
  selectedConfigs(): ItemConfig[];
  /** Open a prefilled GitHub PR adding this scene to the community gallery. */
  onPublish(): void;
  onShuffle(): void;
  /** Re-roll the whole scene, not just the lamps. */
  onRandomizeAll(): void;
  onReset(): void;
  onResetCamera(): void;
  /** Show the transparency checkerboard behind the preview when the backdrop is off. */
  onTransparencyChange(transparent: boolean): void;
  onSelectPreset(name: string): void;
  /** A shape was added or removed; rebuild geometry and record it. */
  onShapesChanged(label: string): void;
  /** The alignment grid changed; redraw the overlay. */
  onViewChanged(): void;
  /** The export size changed; refit the preview frame to the new aspect. */
  onOutputSizeChange(): void;
  /** Open a file picker for a backdrop image or video. */
  onPickBackgroundMedia(kind: "image" | "video"): void;
  /** Open a file picker for a `.svg` and write its outline into this shape. */
  onPickOutline(shape: ShapeConfig): void;
  /** Open a file picker for a `.glb` and point this shape at it. */
  onPickModel(shape: ShapeConfig): void;
  /** Scroll-preview scrub: fix the scroll signal at 0..1. The studio page never actually
   *  scrolls, so this is how a scroll reaction is authored to an exact position. */
  onScrollPreview(value: number): void;
  /** Open (toggle) the scroll-test overlay: a scrollable surface over the scene for testing
   *  `scroll` / `scrollVelocity` reactions by actually scrolling (companion to the slider). */
  onOpenScrollTest(): void;
}

/** What the model field shows for a file picked off disk, whose data URI is megabytes of base64
 *  and would freeze the pane in a text input. Never written back to the shape. */
const PICKED_MODEL = "(file, not a link)";

// ---- Interaction authoring ----

/** Binding-source options for the studio dropdowns (custom:* is a developer API, not authorable). */
const IX_SOURCE_OPTIONS: Record<string, string> = {
  Off: "off",
  Scroll: "scroll",
  Hover: "hover",
  "Pointer X": "pointerX",
  "Pointer Y": "pointerY",
  "Pointer speed": "pointerSpeed",
  Press: "press",
  "Scroll velocity": "scrollVelocity",
  Appear: "appear",
};
/** Item-scope sources: shapes additionally get `hoverSelf`: the cursor over THIS shape (the
 *  renderer raycasts), where plain Hover is presence over the whole scene. */
const IX_SOURCE_OPTIONS_ITEM: Record<string, string> = {
  Off: "off",
  Scroll: "scroll",
  Hover: "hover",
  "Hover · this shape": "hoverSelf",
  "Pointer X": "pointerX",
  "Pointer Y": "pointerY",
  "Pointer speed": "pointerSpeed",
  Press: "press",
  "Press · this shape": "pressSelf",
  "Scroll velocity": "scrollVelocity",
  Appear: "appear",
};
/** Per-shape binding targets. */
const IX_ITEM_TARGETS: Record<string, ItemInteractionTarget> = {
  Density: "density",
  IOR: "ior",
  Dispersion: "dispersion",
  Lens: "lens",
  Rim: "rim",
  Specular: "specular",
  Saturation: "saturation",
  "Hue shift": "hueShift",
  Emission: "emission",
  Ripple: "ripple",
  Iridescence: "iridescence",
  "Film (nm)": "filmNm",
  "Position X": "positionX",
  "Position Y": "positionY",
};
/** Per-lamp binding targets; pointerX→X + pointerY→Y is "the lamp follows the cursor". */
const IX_LAMP_TARGETS: Record<string, LampInteractionTarget> = {
  X: "x",
  Y: "y",
  Radius: "radius",
  Intensity: "intensity",
};
/** Scene-level binding targets (shared post / camera / time / lamp field). */
const IX_SCENE_TARGETS: Record<string, SceneInteractionTarget> = {
  "Time offset": "timeOffset",
  "Camera zoom": "cameraZoom",
  "Lamp gain": "lampGain",
  Aperture: "aperture",
  Bloom: "bloom",
  Haze: "haze",
  Vignette: "vignette",
  Grain: "grain",
  Caustics: "caustics",
};

/** Default "to (at full)" per binding target: the value the param reaches at full input. A
 *  blanket 1 is invisible for narrow-range params (dispersion tops out at 0.15), so each target
 *  seeds a clearly-visible swing scaled to its own slider range. Used for a fresh slot and
 *  re-seeded when you switch the target. Anything unlisted falls back to 1. */
const IX_TARGET_DEFAULT_TO: Record<string, number> = {
  // Shape targets (see RANGES for the sliders these swing over).
  density: 7, // 0..12
  ior: 1.9, // 1.01..2.5
  dispersion: 0.1, // 0..0.15
  lens: 0.18, // 0..0.3
  rim: 1, // 0..1
  specular: 2.2, // 0..3
  saturation: 1.7, // 0..2
  hueShift: 0.4, // -1..1 turns, far enough round the wheel to be unmistakable
  emission: 0.6, // 0..1
  ripple: 1, // 0..1
  iridescence: 1, // 0..1
  filmNm: 900, // 100..1200, sweeps the colour bands
  positionX: 4,
  positionY: 3,
  // Lamp targets (plate space).
  x: 0.9,
  y: 0.9,
  radius: 0.35, // 0.01..0.6
  intensity: 2, // 0..3
  // Scene targets.
  timeOffset: 20, // scrub the animation
  cameraZoom: 1.6, // dolly multiplier over the authored distance
  lampGain: 3, // 0..5
  aperture: 24, // 0..40
  bloom: 0.12, // 0..0.4
  haze: 0.4, // 0..1
  vignette: 0.5, // 0..1
  grain: 0.05, // 0..0.08
  caustics: 0.8, // 0..2
};
const defaultToFor = (target: string): number => IX_TARGET_DEFAULT_TO[target] ?? 1;

/** A type alias rather than an interface: Tweakpane's `BindingParams` wants an implicit index
 *  signature, which only an object type alias gets. */
type SliderRange = { min: number; max: number; step: number };

/**
 * Slider range per parameter, keyed by the name the config and the binding targets share.
 *
 * One table, because the same knob is offered in up to three places: a material row, a reaction's
 * "to (at full)" slider, and (for lamps and the post stack) the section's own row. Declared once
 * they cannot drift apart, and a parameter added here is a real slider everywhere rather than an
 * unclamped number field in one of them, which is how `bend` and `magnify` shipped.
 */
const RANGES: Record<string, SliderRange> = {
  // Material.
  path: { min: 0.02, max: 4, step: 0.01 },
  density: { min: 0, max: 12, step: 0.05 },
  ior: { min: 1.01, max: 2.5, step: 0.01 },
  dispersion: { min: 0, max: 0.15, step: 0.001 },
  lens: { min: 0, max: 0.3, step: 0.001 },
  bend: { min: 0, max: 1, step: 0.01 },
  magnify: { min: 0, max: 1, step: 0.01 },
  rim: { min: 0, max: 1, step: 0.01 },
  specular: { min: 0, max: 3, step: 0.01 },
  saturation: { min: 0, max: 2, step: 0.01 },
  hueShift: { min: -1, max: 1, step: 0.01 },
  emission: { min: 0, max: 1, step: 0.01 },
  roughness: { min: 0, max: 1, step: 0.01 },
  sparkle: { min: 0, max: 1, step: 0.01 },
  sparkleScale: { min: 2, max: 120, step: 1 },
  ripple: { min: 0, max: 1, step: 0.01 },
  rippleScale: { min: 0.1, max: 8, step: 0.05 },
  flow: { min: 0, max: 4, step: 0.01 },
  iridescence: { min: 0, max: 1, step: 0.01 },
  filmNm: { min: 100, max: 1200, step: 5 },
  // A shape's position, as a reaction target.
  positionX: { min: -10, max: 10, step: 0.05 },
  positionY: { min: -7, max: 7, step: 0.05 },
  // Lamps, in plate space.
  x: { min: -0.5, max: 1.5, step: 0.005 },
  y: { min: -0.5, max: 1.5, step: 0.005 },
  radius: { min: 0.01, max: 0.6, step: 0.002 },
  intensity: { min: 0, max: 3, step: 0.01 },
  // Scene: the Post, Lamps and Camera rows, and the reactions that drive them.
  timeOffset: { min: 0, max: 60, step: 0.1 },
  cameraZoom: { min: 0.4, max: 3, step: 0.01 },
  lampGain: { min: 0, max: 5, step: 0.01 },
  aperture: { min: 0, max: 40, step: 0.5 },
  bloom: { min: 0, max: 0.4, step: 0.005 },
  haze: { min: 0, max: 1, step: 0.01 },
  vignette: { min: 0, max: 1, step: 0.01 },
  grain: { min: 0, max: 0.08, step: 0.001 },
  caustics: { min: 0, max: 2, step: 0.01 },
};
const rangeFor = (key: string): SliderRange => RANGES[key] ?? { min: 0, max: 1, step: 0.01 };

/** Panel-local model for one binding slot. */
interface UiSlot {
  source: string; // "off" | InteractionSource
  target: string; // an item / lamp / scene target name
  fromBase: boolean;
  from: number;
  to: number;
  smoothing: number;
}
interface SerializedBinding {
  source: string;
  target: string;
  from?: number;
  to: number;
  smoothing?: number;
}
/** Build a slot's UI model from a loaded binding (or a blank slot with `defaultTarget`). */
function uiSlotFrom(b: SerializedBinding | undefined, defaultTarget: string): UiSlot {
  const target = b?.target ?? defaultTarget;
  return {
    source: b ? b.source : "off",
    target,
    fromBase: !b || b.from === undefined,
    from: b?.from ?? 0,
    to: b?.to ?? defaultToFor(target),
    smoothing: b?.smoothing ?? 0.25,
  };
}
/** Compact UI slots to serialized bindings (drop "off"; omit default from/smoothing), keeping any
 *  preserved (custom:*) bindings the studio can't author. */
function compactSlots(slots: UiSlot[]): SerializedBinding[] {
  const out: SerializedBinding[] = [];
  for (const s of slots) {
    if (s.source === "off") continue;
    const b: SerializedBinding = { source: s.source, target: s.target, to: s.to };
    if (!s.fromBase) b.from = s.from;
    if (s.smoothing !== 0.25) b.smoothing = s.smoothing;
    out.push(b);
  }
  return out;
}

/** Radians-per-shape ⇄ turns-across-the-row. A row of `count` shapes stepping `stagger` radians
 *  apart covers `stagger × count` radians in total; one turn is 2π of that. */
function staggerToTurns(stagger: number, count: number): number {
  return count > 0 ? (stagger * count) / (Math.PI * 2) : 0;
}

function turnsToStagger(turns: number, count: number): number {
  return count > 0 ? (turns * Math.PI * 2) / count : 0;
}

/**
 * Which knobs each material kind actually uses.
 *
 * The config is a flat superset rather than a union, so switching kinds never destroys settings,
 * but that only works if the panel hides what the shader is ignoring. A `density` slider on a
 * ceramic does nothing, and a control that does nothing is worse than no control.
 */
const TRANSMISSIVE_KEYS = [
  "density",
  "ior",
  "dispersion",
  "lens",
  "bend",
  "magnify",
  "rim",
  "specular",
  "saturation",
  "hueShift",
  "emission",
] as const;

const OPAQUE_KEYS = ["roughness", "rim", "specular", "saturation", "emission"] as const;

/**
 * Fill in every material field the panel binds, in place.
 *
 * An item's `material` is a SPARSE override set by design: presets carry only what differs from
 * the defaults, and the renderer resolves the rest at use time. Tweakpane cannot bind `undefined`,
 * so the panel has to make it concrete first. Derived from `createMaterial()` rather than written
 * out by hand, because a hand-maintained copy silently falls behind every field added to the
 * model, which is exactly what happened when the material kinds landed.
 *
 * `path` is deliberately left out: it is shape-derived, and the panel only offers it when a shape
 * has actually overridden it.
 */
export function backfillMaterial(material: Partial<MaterialConfig>): Partial<MaterialConfig> {
  const { path: _path, ...base } = createMaterial();
  return Object.assign(material, { ...base, ...material });
}

/** Which named metal an albedo corresponds to, or "custom" for a hand-picked colour. */
function matchMetal(albedo: string | undefined): string {
  const hex = (albedo ?? "").toLowerCase();
  for (const [name, value] of Object.entries(METAL_F0)) {
    if (value.toLowerCase() === hex) return name;
  }
  return "custom";
}

/** Tweakpane's own marker for an open folder. */
const EXPANDED = "tp-fldv-expanded";

/** The shapes whose `sides` field means something: the ones built as extruded polygons. */
const faceted = (k: ShapeKind) => k === "prism" || k === "hex";

export class ControlPanel {
  private pane: Pane;
  private config: SceneConfig;
  /** Which preset the scene came from. Studio state, not something the scene itself records. */
  private presetName = "skewer";
  private presets?: PresetPicker;
  private gradientEditor?: GradientEditor;
  private meshEditor?: MeshGradientEditor;
  private recordButton?: { title: string; element: HTMLElement };
  private sizeNote?: HTMLElement;
  private sizeWarn?: HTMLElement;
  /** Formats this browser cannot encode, named rather than silently dropped. */
  private readonly unsupported: string[] = [];
  /** Item index → its folder element, so a viewport selection can reveal the matching config. */
  private readonly itemFolders = new Map<number, HTMLElement>();
  /** Which shape the viewport has selected, so its folder opens and highlights. */
  private selectedItem: number | null = null;
  /** True while focusItem programmatically expands folders. revealFolder clicks the real fold
   *  toggles, so without this a viewport selection would fire the expand-to-locate handlers and
   *  a group ancestor's fold would steal the selection it is echoing. */
  private foldSync = false;
  /** How many shapes the viewport has selected. Drives whether the bulk editor targets the
   *  selection or the whole scene; see {@link addAllShapes}. */
  private selectionCount = 0;
  /** Staged motion + material for the bulk editor. Survives pane rebuilds; see {@link addAllShapes}. */
  private bulkDraft?: { motion: MotionConfig; material: Partial<MaterialConfig> };
  /** The bulk editor's title and apply buttons, so a growing marquee can relabel them in place. */
  private bulkTitle?: HTMLElement;
  private bulkApply: HTMLElement[] = [];
  /** True while `pane.refresh()` is writing values back into the inputs. Tweakpane emits `change`
   *  for those writes too, and without this the width/height handlers treat a preset's own
   *  dimensions as a manual edit and immediately flip the dropdown back to "Custom". */
  private syncing = false;

  constructor(
    private readonly host: HTMLElement,
    config: SceneConfig,
    presetName: string,
    readonly state: PanelState,
    readonly view: ViewState,
    readonly size: ExportSize,
    private readonly hooks: PanelHooks,
  ) {
    this.config = config;
    this.presetName = presetName;
    this.pane = this.build();
  }

  /** Point the panel at a different config object (preset switch, import, share link). */
  setConfig(config: SceneConfig, presetName: string): void {
    this.config = config;
    this.presetName = presetName;
    this.bulkDraft = undefined; // staged values describe shapes that no longer exist
    this.rebuild();
  }

  /**
   * Tell the panel how many shapes the viewport has selected.
   *
   * Only rebuilds when crossing the boundary between "a selection to target" and "no selection",
   * since that is the only thing that changes what the bulk editor says and does. Rebuilding on
   * every marquee tick would make dragging a rubber band rebuild the pane dozens of times.
   */
  setSelectionCount(count: number): void {
    const had = this.selectionCount > 1;
    this.selectionCount = count;
    if (had !== count > 1) {
      this.rebuild();
      return;
    }
    // The count still has to reach the labels, or a marquee that grows from 2 to 7 leaves the
    // header and the apply buttons reading "2" while the gesture selects seven.
    this.paintBulkLabels();
  }

  /** Re-label the bulk editor for the current selection size, without rebuilding the pane. */
  private paintBulkLabels(): void {
    if (this.selectionCount <= 1) return;
    if (this.bulkTitle) this.bulkTitle.textContent = `Selection · ${this.selectionCount}`;
    for (const el of this.bulkApply) {
      el.textContent = `↻ apply to ${this.selectionCount} selected`;
    }
    // Writing textContent threw away the icon span along with the old label, leaving the bare
    // glyph the icon was there to replace.
    applyIcons(this.host);
  }

  /**
   * Reveal a shape's config: expand its folder, scroll it into view and flash it.
   *
   * Called when a shape is selected in the viewport. `null` clears the highlight.
   */
  focusItem(index: number | null): void {
    this.selectedItem = index;
    // No rebuild: every shape has a folder now, so selecting one only has to reveal it. This used
    // to rebuild the whole pane past the cap, which also threw away any folder already opened.

    for (const folder of this.itemFolders.values()) folder.classList.remove("is-focused");
    if (index === null) return;
    const folder = this.itemFolders.get(index);
    if (!folder) return;
    this.withFoldSync(() => this.revealFolder(folder));
    folder.classList.add("is-focused");
    folder.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /**
   * Run `fn` with the fold handlers told that the expansion is the panel's own, not a person's.
   *
   * focusItem, a search and restoreView all click real fold toggles, and a folder opening for one
   * of those reasons must not read as "locate this shape" and move the viewport selection: a
   * rebuild re-opening a group's folder would otherwise steal the selection it was echoing.
   */
  private withFoldSync(fn: () => void): void {
    const was = this.foldSync;
    this.foldSync = true;
    try {
      fn();
    } finally {
      this.foldSync = was;
    }
  }

  /**
   * Expand a folder and every folder it sits inside.
   *
   * Ancestors matter now that grouped shapes are nested: a member's own toggle does nothing while
   * its group is collapsed, so revealing has to work from the outside in.
   */
  private revealFolder(element: HTMLElement): void {
    const chain: HTMLElement[] = [];
    for (
      let node: HTMLElement | null = element;
      node;
      node = node.parentElement?.closest<HTMLElement>(".tp-fldv") ?? null
    ) {
      chain.push(node);
    }
    for (const folder of chain.toReversed()) {
      // Tweakpane exposes expansion through its API object, but the title button is the same
      // toggle and is what a person would click; clicking it is simpler than threading the API
      // through. The expanded CLASS rather than the container's height: reading a height forces
      // layout after every click, and a search reveals dozens of folders at once.
      if (!folder.classList.contains(EXPANDED)) {
        folder.querySelector<HTMLElement>(":scope > .tp-fldv_b")?.click();
      }
    }
  }

  /**
   * Filter the panel to what `query` matches. The matching itself lives in `controlSearch`, which
   * is testable on its own; what stays here is the Tweakpane part: opening the folders a match
   * was found in, and putting the panel back the way it was when the search is cleared.
   */
  private applySearch(query: string): void {
    if (!query.trim()) {
      clearSearch(this.host);
      // Restore what was open BEFORE the search, so searching is something you can back out of
      // rather than something that quietly rearranges the panel.
      if (this.viewBeforeSearch) {
        this.restoreView(this.viewBeforeSearch);
        this.viewBeforeSearch = undefined;
      }
      return;
    }
    this.viewBeforeSearch ??= this.captureView();
    // Outside in: a member's own toggle does nothing while its group is collapsed.
    const matches = applySearch(this.host, query);
    this.withFoldSync(() => {
      for (const folder of matches) this.revealFolder(folder);
    });
  }

  /** Re-apply the active filter: the panel's DOM is replaced wholesale on a rebuild. */
  private reapplySearch(): void {
    if (this.searchQuery) this.applySearch(this.searchQuery);
  }

  /** Wire an external search input to this panel. */
  bindSearch(input: HTMLInputElement): void {
    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      this.applySearch(this.searchQuery);
    });
    // Escape clears, as it does in every other search field on the platform.
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !input.value) return;
      input.value = "";
      this.searchQuery = "";
      this.applySearch("");
    });
  }

  /** Re-read the preset thumbnail cache once background generation has filled it. */
  refreshPresetThumbs(): void {
    this.presets?.refreshThumbs();
  }

  /** Redraw the inputs after the config was mutated from outside (a gesture, the dev bridge). */
  refresh(): void {
    this.syncInputs();
  }

  private searchQuery = "";
  /** What was open before a search started, so clearing it puts the panel back. */
  private viewBeforeSearch?: ReturnType<ControlPanel["captureView"]>;

  private rebuild(): void {
    hideControlHint();
    this.flushTyping();
    const view = this.captureView();
    this.itemFolders.clear();
    this.pane.dispose();
    this.pane = this.build();
    this.restoreView(view);
    this.reapplySearch();
  }

  /**
   * Which folders are open, and where the pane is scrolled to.
   *
   * A rebuild throws the whole pane away and builds a fresh one, so without this every structural
   * edit (changing a material kind is the common one, since the kind decides which rows exist)
   * snaps you back to the top with every folder at its default. The knob you were turning ends up
   * somewhere off screen.
   *
   * Both sets are recorded, not just the open one: a folder that defaults to expanded but which
   * you collapsed has to stay collapsed, and a folder that did not exist before keeps whatever
   * default the rebuild gave it.
   */
  private captureView(): { open: Set<string>; closed: Set<string>; scroll: number } {
    const open = new Set<string>();
    const closed = new Set<string>();
    for (const el of this.host.querySelectorAll<HTMLElement>(".tp-fldv")) {
      (el.classList.contains(EXPANDED) ? open : closed).add(ControlPanel.folderKey(el));
    }
    return { open, closed, scroll: this.host.scrollTop };
  }

  private restoreView(view: { open: Set<string>; closed: Set<string>; scroll: number }): void {
    // Tweakpane animates a fold, and a dozen folders easing open would leave the scroll position
    // chasing a moving target. Suppressed for the duration, so the restored pane simply *is* the
    // shape it was.
    this.host.classList.add("is-restoring");
    // Reads first (the keys walk titles, the state is a class), then the clicks, so the writes
    // never interleave with a layout read.
    const toggles: HTMLElement[] = [];
    for (const el of this.host.querySelectorAll<HTMLElement>(".tp-fldv")) {
      const key = ControlPanel.folderKey(el);
      const isOpen = el.classList.contains(EXPANDED);
      const wanted = view.open.has(key) ? true : view.closed.has(key) ? false : isOpen;
      // Click the title rather than set `expanded` on the API: the element is what we have here,
      // and a click is also what makes a lazily-built shape folder fill itself in.
      if (wanted !== isOpen) {
        const toggle = el.querySelector<HTMLElement>(":scope > .tp-fldv_b");
        if (toggle) toggles.push(toggle);
      }
    }
    this.withFoldSync(() => {
      for (const toggle of toggles) toggle.click();
    });
    this.host.scrollTop = view.scroll;
    void this.host.offsetHeight; // commit the un-animated heights before transitions come back
    this.host.classList.remove("is-restoring");
  }

  /**
   * A folder's identity across rebuilds: its title path from the root.
   *
   * Titles rather than positions, because a rebuild is usually adding or removing rows and every
   * index below the change would shift. The live count is stripped ("Shapes · 16", "Left rods · 5")
   * so a count that moved does not read as a different folder.
   */
  private static folderKey(el: HTMLElement): string {
    const parts: string[] = [];
    for (
      let node: HTMLElement | null = el;
      node;
      node = node.parentElement?.closest<HTMLElement>(".tp-fldv") ?? null
    ) {
      // The nearest `.tp-fldv_t` descendant is this folder's own title; nested ones come later in
      // document order.
      const title = node.querySelector(".tp-fldv_t")?.textContent ?? "";
      parts.push(title.split("\u00b7")[0].trim());
    }
    return parts.toReversed().join("/");
  }

  // --------------------------------------------------------------- building --

  private build(): Pane {
    const pane = new Pane({ container: this.host });
    // One handler for every binding that only moves uniforms; structural bindings opt in below.
    // Guarded like every other handler: `pane.refresh()` emits a change for each binding whose
    // value moved, and a gesture refreshing the pane ten times a second must not push uniforms
    // and mark history once per binding on every one of them.
    pane.on("change", () => {
      if (!this.syncing) this.hooks.onChange(false);
    });

    // Output, Performance and Actions come first: they are what you reach for repeatedly while
    // working, and they are the same in every scene. The scene-authoring folders follow in the
    // order the frame is built up: light, backplate, camera, post, then the shapes and how they move.
    this.addOutput(pane);
    this.addPerformance(pane);
    this.addView(pane);
    this.addActions(pane);
    this.addScene(pane);
    this.addLamps(pane);
    this.addBackplate(pane);
    this.addCamera(pane);
    this.addPost(pane);
    this.addBeam(pane);
    this.addInteraction(pane);
    this.addShapes(pane);

    applyIcons(this.host);
    // After applyIcons: hints read labels back out of the DOM, and the icon pass must already
    // have swapped leading emoji for SVGs (which contribute no text) by then.
    applyControlHints(this.host);
    return pane;
  }

  /**
   * Re-derive `sides` when a shape's KIND changes, because the field means two different things.
   *
   * On `prism` it counts faces and 3 is the point; on `sphere` it counts radial segments and 3 is
   * a triangular bipyramid. Switching a prism to a sphere therefore renders a triangle, which
   * reads as a broken mesh rather than as a stale number.
   *
   * It fires only when the change CROSSES the faceted/round boundary, which is why the previous
   * kind is tracked. Retargeting on every kind change instead would need a threshold to guess
   * whether a number was a face count, and any threshold throws away a deliberate low-poly choice:
   * an eight-segment sphere should survive a trip through `rod` and back.
   */
  private retargetsSides<T extends { on: (event: "change", cb: () => void) => unknown }>(
    binding: T,
    shape: ShapeConfig,
  ): T {
    let previous = shape.kind;
    binding.on("change", () => {
      if (this.syncing || shape.kind === previous) return;
      const crossed = faceted(shape.kind) !== faceted(previous);
      previous = shape.kind;
      if (!crossed) return;
      shape.sides = defaultSides(shape.kind);
      this.syncInputs();
    });
    return binding;
  }

  /**
   * Rebuild the panel when a kind change crosses into or out of `path`.
   *
   * `outline` is the one shape field that exists on a single kind, because it is the one that
   * cannot be a number: every other control here is meaningful enough on every kind to just show
   * it and let the builder ignore it, but a `d` string on a rod is noise. That makes the CONTROL
   * SET depend on the kind, which a renderer rebuild alone does not notice: the scene would
   * repaint as a star while the panel still offered no way to change it.
   *
   * Seeding the outline on the way in is the same move {@link retargetsSides} makes for `sides`:
   * a field the new kind reads has to hold something before the panel binds to it.
   */
  private retargetsOutline<T extends { on: (event: "change", cb: () => void) => unknown }>(
    binding: T,
    shape: ShapeConfig,
  ): T {
    let wasPath = shape.kind === "path";
    let wasModel = shape.kind === "model";
    binding.on("change", () => {
      if (this.syncing) return;
      const isPath = shape.kind === "path";
      const isModel = shape.kind === "model";
      if (isPath === wasPath && isModel === wasModel) return;
      wasPath = isPath;
      wasModel = isModel;
      if (isPath) shape.outline ??= DEFAULT_OUTLINE;
      // Nothing is seeded for `model`. There is no default `.glb` to fall back on the way there is
      // a DEFAULT_OUTLINE, and the placeholder sphere the renderer draws is the honest version of
      // the same idea: it holds the shape's place until a file is picked.
      this.rebuild();
    });
    return binding;
  }

  /**
   * The outline field, on the one kind that reads it. See {@link retargetsOutline}.
   *
   * Seeded before binding rather than assumed present: Tweakpane picks its widget from the VALUE
   * and throws on `undefined`, and `outline` is absent on every kind but `path`. The guard sits on
   * the binding's own line because the bindings audit reads these call sites out of the source and
   * skips the ones an inline `if` shows to be conditional; this is the same
   * conditionally-shown optional as `material.path` and `material.tint`.
   */
  private addOutline(f: FolderApi, shape: ShapeConfig): void {
    if (shape.kind === "path") {
      shape.outline ??= DEFAULT_OUTLINE;
      const label = { label: "outline (svg d)" };
      if (shape.outline) this.typedStructural(f.addBinding(shape, "outline", label));
    }
    // The BUTTON is on every kind and the field only on `path`, which is not an inconsistency.
    // Picking a file says what the shape is meant to BE, so it should not require finding the kind
    // dropdown and switching to `path` first; it does that for you. A `d` field on a rod, by
    // contrast, is dead weight in the panel and in every export.
    f.addButton({ title: "⬈ Shape from SVG…" }).on("click", () => this.hooks.onPickOutline(shape));
    this.addModel(f, shape);
  }

  /**
   * The `.glb` field and its picker, the second escape hatch. See {@link addOutline}, which this
   * mirrors down to the button being on every kind and the field on one.
   *
   * The field is editable rather than read-only even though a picked file lands here as a data
   * URI thousands of characters long, and that is the point of showing it: it is where a hosted
   * URL is typed. A scene that names `/hero.glb` travels in a share link and exports as code
   * someone can ship; one carrying a picked file does not, and the difference should be visible
   * rather than something you discover when the link comes back too long.
   *
   * Truncated in the panel through a proxy object, because Tweakpane binds to the value it is
   * given and a megabyte of base64 in a text input freezes the pane on every keystroke.
   */
  private addModel(f: FolderApi, shape: ShapeConfig): void {
    if (shape.kind === "model") {
      const picked = shape.model?.startsWith("data:") ?? false;
      const modelField = { model: picked ? PICKED_MODEL : (shape.model ?? "") };
      const label = { label: "model (.glb url)" };
      this.typedStructural(f.addBinding(modelField, "model", label)).on("change", () => {
        if (this.syncing) return;
        // A picked file stays picked until something is typed over it: the stand-in text is not a
        // URL, and writing it back would break the shape the moment the field is focused.
        if (modelField.model === PICKED_MODEL) return;
        shape.model = modelField.model || undefined;
      });
    }
    f.addButton({ title: "⬈ Shape from GLB…" }).on("click", () => this.hooks.onPickModel(shape));
  }

  /** Mark a binding as needing a geometry rebuild. */
  private structural<T extends { on: (event: "change", cb: () => void) => unknown }>(
    binding: T,
  ): T {
    binding.on("change", () => {
      if (!this.syncing) this.hooks.onChange(true);
    });
    return binding;
  }

  /** Pending {@link typedStructural} timer, so a disposed panel cannot fire one. */
  private typingTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * A structural binding whose changes are coalesced while the user is still typing.
   *
   * A structural change rebuilds every shape's geometry, and for a text field that fires once per
   * KEYSTROKE. Most fields here are sliders and steppers where that is exactly right: the scene
   * tracking a drag is the point. Path outlines are the exception: they are typed or pasted, and
   * re-extruding a few thousand contour points per character is tens of milliseconds of jank each
   * time, for frames nobody looks at because the `d` is half-written.
   *
   * The delay is short enough to read as instant on a paste (one change event, one rebuild) and
   * long enough to swallow a burst of typing. History is untouched by this: `onChange` still marks
   * the edit dirty, just once at the end of the burst rather than once per character.
   */
  private typedStructural<T extends { on: (event: "change", cb: () => void) => unknown }>(
    binding: T,
    delay = 200,
  ): T {
    binding.on("change", () => {
      if (this.syncing) return;
      clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => {
        this.typingTimer = undefined;
        this.hooks.onChange(true);
      }, delay);
    });
    return binding;
  }

  /** Land a pending typed edit NOW. Called before the panel goes away, so the last keystrokes of
   *  an outline are not lost to a rebuild or a dispose that beat the timer. */
  private flushTyping(): void {
    if (this.typingTimer === undefined) return;
    clearTimeout(this.typingTimer);
    this.typingTimer = undefined;
    this.hooks.onChange(true);
  }

  private addScene(pane: Pane): void {
    const f = pane.addFolder({ title: "Scene", expanded: true });
    f.addBinding(this.config, "background", { label: "backdrop" });
    f.addBinding(this.config, "mirrorH", { label: "mirror ↔" });
    f.addBinding(this.config, "mirrorV", { label: "mirror ↕" });

    // What the backdrop is painted with. Structural: the shader branches on it, and the image
    // modes need media loaded, so these go through onChange with a rebuild rather than a refresh.
    const structural = (): void => this.hooks.onChange(true);
    f.addBinding(this.config, "backgroundMode", {
      label: "backdrop mode",
      options: { "solid colour": "color", gradient: "gradient", "image / video": "image" },
    })
      // The mode decides which sub-folder exists below, so the PANEL has to be rebuilt too:
      // a renderer rebuild alone repaints the scene and leaves the controls showing the old mode's
      // knobs.
      .on("change", () => {
        if (this.syncing) return;
        this.rebuild();
        structural();
      });

    f.addBinding(this.config, "transparentBackground", { label: "transparent" }).on(
      "change",
      () => {
        this.hooks.onTransparencyChange(this.config.transparentBackground);
        this.renderSizeNote(); // the JPEG-flattens-alpha warning depends on this
      },
    );
    // Over transparency this is what clear glass reads as, so it is the colour to match to
    // whatever surface the hero sits on.
    f.addBinding(this.config, "clearGlass", { label: "clear glass" });
    f.addBinding(this.config, "orbit");
    f.addBinding(this.config, "paused");
    // A clip only loops if it is recorded at exactly this length, so setting one also sets the
    // record duration to match; the two being out of step is the whole failure mode.
    f.addBinding(this.config, "loopSeconds", {
      label: "loop (s)",
      min: 0,
      max: 30,
      step: 0.5,
    }).on("change", () => {
      if (this.config.loopSeconds > 0) {
        this.state.recordSeconds = this.config.loopSeconds;
        this.syncInputs();
        this.renderSizeNote();
      }
    });
    f.addBinding(this.config, "introRamp", { label: "ease in on load" });

    // Only the folder the mode actually uses. The config keeps every field either way, so
    // switching back and forth never loses a palette or a pan offset, but a gradient angle is
    // meaningless while the backdrop is a flat colour, so it isn't shown.
    if (this.config.backgroundMode === "gradient") this.addGradientControls(f);
    if (this.config.backgroundMode === "image") this.addMediaControls(f, structural);
  }

  private addGradientControls(f: FolderApi): void {
    const grad = f.addFolder({ title: "Gradient", expanded: true });
    grad
      .addBinding(this.config, "backgroundGradientType", {
        label: "type",
        options: { linear: "linear", radial: "radial", conic: "conic", mesh: "mesh" },
      })
      // Mesh has blobs where the others have stops, so the row list changes with the type.
      .on("change", () => {
        if (this.syncing) return;
        this.rebuild();
        this.hooks.onChange(true);
      });
    const type = this.config.backgroundGradientType;
    // Radial rings outward from the centre and mesh has no single direction, so neither has an
    // angle to set.
    if (type === "linear" || type === "conic") {
      grad.addBinding(this.config, "backgroundGradientAngle", {
        label: "angle",
        min: 0,
        max: Math.PI * 2,
        step: 0.01,
      });
    }
    if (type === "mesh") {
      // The pad paints the real field, so softness has to repaint it; otherwise the preview and
      // the backdrop disagree, which is the one thing the preview exists not to do.
      grad
        .addBinding(this.config, "backgroundMeshSoftness", {
          label: "blob softness",
          min: 0.05,
          max: 2,
          step: 0.01,
        })
        .on("change", () => this.meshEditor?.refresh());
    }
    this.addPaletteControls(grad);
  }

  private addMediaControls(f: FolderApi, structural: () => void): void {
    const media = f.addFolder({ title: "Image / video", expanded: true });
    media.addBinding(this.config, "backgroundImageFit", {
      label: "fit",
      options: { cover: "cover", contain: "contain", stretch: "stretch" },
    });
    media.addBinding(this.config, "backgroundImageZoom", {
      label: "zoom",
      min: 0.1,
      max: 4,
      step: 0.01,
    });
    media.addBinding(this.config.backgroundImagePosition, "x", {
      label: "pan x",
      min: -1,
      max: 2,
      step: 0.01,
    });
    media.addBinding(this.config.backgroundImagePosition, "y", {
      label: "pan y",
      min: -1,
      max: 2,
      step: 0.01,
    });
    media
      .addButton({ title: "🖼 Choose image…" })
      .on("click", () => this.hooks.onPickBackgroundMedia("image"));
    media
      .addButton({ title: "🎞 Choose video…" })
      .on("click", () => this.hooks.onPickBackgroundMedia("video"));
    media.addButton({ title: "✕ Clear media" }).on("click", () => {
      this.config.backgroundImageUrl = undefined;
      this.config.backgroundVideoUrl = undefined;
      structural();
    });
  }

  private addLamps(pane: Pane): void {
    const f = pane.addFolder({ title: `Lamps · ${this.config.lamps.length}`, expanded: true });
    f.addBinding(this.config, "lampGain", { label: "gain", ...RANGES.lampGain });
    // The gate is what makes clear glass clear: without it every lamp's Gaussian tail reaches
    // everywhere and nothing reads as transparent.
    f.addBinding(this.config.lampGate, "lo", { label: "gate lo", min: 0, max: 1, step: 0.005 });
    f.addBinding(this.config.lampGate, "hi", { label: "gate hi", min: 0, max: 1, step: 0.005 });
    f.addBinding(this.config, "backdropLamps", {
      label: "on backdrop",
      min: 0,
      max: 0.4,
      step: 0.005,
    });

    for (const [index, lamp] of this.config.lamps.entries()) {
      // Only the first opens: ten expanded lamp folders is a wall of sliders, and the sections
      // being expanded is what matters, not every leaf.
      const item = f.addFolder({ title: `lamp ${index + 1}`, expanded: index === 0 });
      item.addBinding(lamp, "color");
      item.addBinding(lamp, "x", RANGES.x);
      item.addBinding(lamp, "y", RANGES.y);
      item.addBinding(lamp, "r", { label: "radius", ...RANGES.radius });
      item.addBinding(lamp, "intensity", RANGES.intensity);
      this.addLampInteraction(item, lamp);
      item.addButton({ title: "✕ remove" }).on("click", () => {
        this.config.lamps.splice(index, 1);
        this.rebuild();
        this.hooks.onChange(false);
      });
    }

    f.addButton({
      title: "＋ add lamp",
      // The uniform array is fixed-size; adding past it would silently do nothing.
      disabled: this.config.lamps.length >= MAX_LAMPS,
    }).on("click", () => {
      this.config.lamps.push(createLamp(Math.random(), 0.2 + Math.random() * 0.3));
      this.rebuild();
      this.hooks.onChange(false);
    });
    // Recolours the field without touching a single position: the arrangement is the composition,
    // the palette is only its colour.
    const palette = { name: "reference" };
    f.addBinding(palette, "name", {
      label: "palette",
      options: Object.fromEntries(LAMP_PALETTE_NAMES.map((n) => [n, n])),
    }).on("change", () => {
      applyLampPalette(this.config.lamps, palette.name);
      this.hooks.onChange(false);
      this.refresh();
    });
    f.addButton({ title: "🎲 shuffle lamps" }).on("click", () => this.hooks.onShuffle());
    f.addButton({ title: "🎲 randomize scene" }).on("click", () => this.hooks.onRandomizeAll());
  }

  private addBackplate(pane: Pane): void {
    const f = pane.addFolder({ title: "Backplate", expanded: true });
    // The single knob that decides whether the result looks like one gradient behind everything
    // or like coloured plastic.
    f.addBinding(this.config.plate, "z", { label: "distance", min: -20, max: -0.5, step: 0.1 });
    f.addBinding(this.config.plate.scale, "x", { label: "scale x", min: 2, max: 80, step: 0.5 });
    f.addBinding(this.config.plate.scale, "y", { label: "scale y", min: 2, max: 80, step: 0.5 });
    f.addBinding(this.config.plate.offset, "x", { label: "offset x", min: -1, max: 2, step: 0.01 });
    f.addBinding(this.config.plate.offset, "y", { label: "offset y", min: -1, max: 2, step: 0.01 });
  }

  private addCamera(pane: Pane): void {
    const f = pane.addFolder({ title: "Camera", expanded: true });
    // Long lens or the roll reads as tumbling instead of foreshortening.
    f.addBinding(this.config.camera, "fov", { min: 4, max: 60, step: 0.5 });
    // Only bites off 16:9; at the authored aspect every fit frames identically.
    f.addBinding(this.config.camera, "fit", {
      label: "aspect fit",
      options: {
        "cover · crop to fill": "cover",
        "contain · keep it all": "contain",
        "match width": "width",
        "match height": "height",
      },
    });
    f.addBinding(this.config.camera, "minVisibleWidth", {
      label: "min width kept",
      min: 0,
      max: 1,
      step: 0.05,
    });
    f.addBinding(this.config.camera, "distance", { min: 5, max: 120, step: 0.5 });
    f.addBinding(this.config.camera, "height", { min: -20, max: 20, step: 0.1 });
    // Tilting the camera body: the whole composition turns in frame. Pair it with the tilt guide
    // under Guides to line the shot up against it.
    f.addBinding(this.config.camera, "roll", { label: "tilt °", min: -45, max: 45, step: 0.5 });
    f.addBinding(this.config.camera.lookAt, "y", {
      label: "look at y",
      min: -20,
      max: 20,
      step: 0.1,
    });
    f.addButton({ title: "⟲ reset camera" }).on("click", () => this.hooks.onResetCamera());
  }

  /**
   * The stop / blob editors, mounted into the Gradient folder.
   *
   * These replaced a column of plain Tweakpane rows. The rows worked, but a gradient is a spatial
   * thing: the SPACING between stops is as much of the design as their colours, and no pair of
   * number fields shows you that. Both widgets mutate the config arrays in place, so nothing else
   * in the panel has to know they exist.
   */
  private addPaletteControls(folder: FolderApi): void {
    const host =
      (folder.element.querySelector(".tp-fldv_c") as HTMLElement | null) ?? folder.element;
    const change = (): void => this.hooks.onChange(false);

    if (this.config.backgroundGradientType === "mesh") {
      this.meshEditor?.dispose();
      this.meshEditor = new MeshGradientEditor(
        host,
        () => this.config.backgroundMeshPoints,
        () => this.config.backgroundMeshSoftness,
        { onChange: change, max: MAX_MESH_POINTS },
      );
      return;
    }

    this.gradientEditor?.dispose();
    this.gradientEditor = new GradientEditor(host, () => this.config.backgroundPalette, {
      onChange: change,
      max: MAX_STOPS,
    });
  }

  private addPost(pane: Pane): void {
    const f = pane.addFolder({ title: "Post", expanded: true });
    f.addBinding(this.config.post, "focus", { min: 1, max: 95, step: 0.1 });
    f.addBinding(this.config.post, "range", { min: 0.2, max: 40, step: 0.1 });
    f.addBinding(this.config.post, "aperture", RANGES.aperture);
    f.addBinding(this.config.post, "bloom", RANGES.bloom);
    f.addBinding(this.config.post, "bloomRadius", {
      label: "bloom radius",
      min: 0,
      max: 40,
      step: 0.5,
    });
    f.addBinding(this.config.post, "bloomThreshold", {
      label: "bloom threshold",
      min: 0,
      max: 1,
      step: 0.01,
    });
    f.addBinding(this.config.post, "caustics", RANGES.caustics);
    f.addBinding(this.config.post, "haze", RANGES.haze);
    f.addBinding(this.config.post, "hazeTop", { label: "haze top", min: -0.2, max: 1, step: 0.01 });
    f.addBinding(this.config.post, "hazeColor", { label: "haze colour" });
    f.addBinding(this.config.post, "vignette", RANGES.vignette);
    f.addBinding(this.config.post, "grain", RANGES.grain);

    // Light shafts and stylisation are a second pass that only runs when one of them is on, so
    // they are folded away by default; the scene costs nothing extra until you open this.
    const shafts = f.addFolder({ title: "Light shafts", expanded: true });
    shafts.addBinding(this.config.post, "innerLight", {
      label: "strength",
      min: 0,
      max: 2,
      step: 0.01,
    });
    shafts.addBinding(this.config.post, "innerLightDensity", {
      label: "length",
      min: 0,
      max: 2,
      step: 0.01,
    });
    shafts.addBinding(this.config.post, "innerLightDecay", {
      label: "decay",
      min: 0.5,
      max: 1,
      step: 0.005,
    });
    shafts.addBinding(this.config.post, "innerLightX", {
      label: "source x",
      min: -0.5,
      max: 1.5,
      step: 0.01,
    });
    shafts.addBinding(this.config.post, "innerLightY", {
      label: "source y",
      min: -0.5,
      max: 1.5,
      step: 0.01,
    });

    const style = f.addFolder({ title: "Stylise", expanded: true });
    style.addBinding(this.config.post, "dither", { label: "dither", min: 0, max: 1, step: 0.01 });
    style.addBinding(this.config.post, "ditherScale", {
      label: "dither px",
      min: 1,
      max: 12,
      step: 0.5,
    });
    style.addBinding(this.config.post, "ditherSteps", {
      label: "dither levels",
      min: 1,
      max: 16,
      step: 1,
    });
    style.addBinding(this.config.post, "halftone", {
      label: "halftone",
      min: 0,
      max: 1,
      step: 0.01,
    });
    style.addBinding(this.config.post, "halftoneCell", {
      label: "dot size",
      min: 2,
      max: 24,
      step: 0.5,
    });
    style.addBinding(this.config.post, "halftoneAngle", {
      label: "screen angle",
      min: 0,
      max: 1.571,
      step: 0.01,
    });
    style.addBinding(this.config.post, "halftoneCmyk", {
      label: "cmyk process",
      min: 0,
      max: 1,
      step: 0.01,
    });
    style.addBinding(this.config.post, "halftoneCmykCell", {
      label: "cmyk dot size",
      min: 2,
      max: 24,
      step: 0.5,
    });
    style.addBinding(this.config.post, "paperTexture", {
      label: "paper",
      min: 0,
      max: 1,
      step: 0.01,
    });
    style.addBinding(this.config.post, "paperTextureScale", {
      label: "paper scale",
      min: 0.5,
      max: 8,
      step: 0.1,
    });
  }

  /**
   * The traced beam.
   *
   * Absent from this panel for a long time, which made the one thing in the language that is
   * SOLVED rather than shaded the one thing you could not touch without hand-editing JSON. Aiming
   * a beam is a search (the route through a chain of solids survives only a few degrees, and past
   * that the light misses and the effect collapses), and a search wants a slider and a live frame,
   * not a rebuild per guess.
   *
   * Nothing here is structural. `refresh()` calls `applyBeam`, which re-traces whenever its key
   * changes, so a drag re-solves the ray on the next frame without rebuilding any geometry.
   */
  private addBeam(pane: Pane): void {
    const beam = this.config.beam;
    if (!beam) return;
    const f = pane.addFolder({ title: "Beam", expanded: false });

    // --- aim: the handles you actually search with ---
    // `entryAngle` and `entrySweep` are optional and `normalizeBeam` keeps them absent rather than
    // seeding them, because an angle of 0 is a real bearing that must not be confused with not
    // having asked for one. Guarded on the binding's own line, for the bindings audit.
    const angleOpts = { label: "entry angle", min: 0, max: 360, step: 0.5 };
    const sweepOpts = { label: "entry sweep", min: 0, max: 180, step: 1 };
    if (beam.entryAngle !== undefined) f.addBinding(beam, "entryAngle", angleOpts);
    if (beam.entrySweep !== undefined) f.addBinding(beam, "entrySweep", sweepOpts);
    f.addBinding(beam, "incidence", { min: -89, max: 89, step: 0.5 });
    f.addBinding(beam, "entry", { min: 0, max: 1, step: 0.001 });
    // Only meaningful when no `entryAngle` is set: on a round cross-section a face index picks
    // one of ninety-six facets and slides within it, which is a handle with nothing to drive.
    f.addBinding(beam, "face", { min: 0, max: 15, step: 1 });

    // --- the solid it refracts through, when no item is named ---
    const shape = f.addFolder({ title: "Cross-section", expanded: false });
    shape.addBinding(beam, "radius", { min: 0.02, max: 8, step: 0.005 });
    shape.addBinding(beam, "sides", { min: 3, max: 128, step: 1 });
    shape.addBinding(beam, "rotation", { min: -Math.PI, max: Math.PI, step: 0.001 });
    shape.addBinding(beam, "z", { min: -8, max: 8, step: 0.01 });

    // --- optics ---
    const optics = f.addFolder({ title: "Optics", expanded: true });
    // The Cauchy base: the index at INFINITE wavelength, not at 550nm. Across the visible band
    // the real index sits well above this, which is why 1.2 is a normal-looking number here.
    optics.addBinding(beam, "ior", { min: 1.001, max: 2.5, step: 0.001 });
    optics.addBinding(beam, "dispersion", { min: 0, max: 0.4, step: 0.001 });
    optics.addBinding(beam, "width", { min: 0.001, max: 0.4, step: 0.001 });
    optics.addBinding(beam, "distance", { min: 0.5, max: 30, step: 0.1 });

    // --- how bright, and how smooth ---
    const look = f.addFolder({ title: "Look", expanded: true });
    look.addBinding(beam, "exposure", { min: 0, max: 400, step: 1 });
    look.addBinding(beam, "intensity", { min: 0, max: 4, step: 0.01 });
    look.addBinding(beam, "edgeFalloff", { label: "edge falloff", min: 1, max: 64, step: 0.5 });
    look.addBinding(beam, "falloffRate", { label: "falloff rate", min: 0, max: 12, step: 0.05 });
    look.addBinding(beam, "falloffPower", { label: "falloff power", min: 0, max: 12, step: 0.05 });
    look.addBinding(beam, "revealSeconds", { label: "reveal s", min: 0, max: 12, step: 0.1 });
    // Wavelength vertices and width slices: the smoothness of the sheet, and its cost. Structural
    // in spirit (they resize the geometry), but `applyBeam` rebuilds it from its key either way.
    look.addBinding(beam, "samples", { min: 8, max: 256, step: 1 });
    look.addBinding(beam, "slices", { min: 1, max: 64, step: 1 });

    const caustic = f.addFolder({ title: "Caustic", expanded: false });
    caustic.addBinding(beam, "causticStrength", { label: "strength", min: 0, max: 6, step: 0.01 });
    caustic.addBinding(beam, "causticCoverage", { label: "coverage", min: 0, max: 1, step: 0.01 });
    caustic.addBinding(beam, "causticRateScale", { label: "rate", min: 0, max: 2, step: 0.01 });
    caustic.addBinding(beam, "causticPowerScale", { label: "power", min: 0, max: 2, step: 0.01 });
    caustic.addBinding(beam, "causticFarBrightness", {
      label: "far bright",
      min: 0,
      max: 1,
      step: 0.005,
    });
    caustic.addBinding(beam, "causticFarDesaturation", {
      label: "far desat",
      min: 0,
      max: 1,
      step: 0.005,
    });
    caustic.addBinding(beam, "causticNormalInfluence", {
      label: "normal infl",
      min: 0,
      max: 2,
      step: 0.01,
    });
    caustic.addBinding(beam, "causticNormalElevation", {
      label: "normal elev",
      min: 0,
      max: 90,
      step: 0.5,
    });
  }

  /**
   * Scene-level interaction: the shared inputs (touch opt-in, a scroll-preview scrub, since the
   * studio page never really scrolls) plus reactions that drive shared scene params. Per-shape
   * reactions live in each shape's own Interaction folder, per-lamp ones in each lamp's.
   */
  private addInteraction(pane: Pane): void {
    const f = pane.addFolder({ title: "Interaction", expanded: false });
    const it = this.config.interaction;
    const uiInputs = { touch: it?.touch ?? false, scrollPreview: 0 };
    // `enabled` is a developer API (the layer's master switch, not authorable here); like
    // custom:* bindings below, carry an explicit value through every rebuild rather than drop it.
    const enabled = it?.enabled;
    const loaded = it?.bindings ?? [];
    const preserved = loaded.filter((b) => b.source.startsWith("custom:"));
    const slots: UiSlot[] = loaded
      .filter((b) => !b.source.startsWith("custom:"))
      .map((b) => uiSlotFrom(b, "timeOffset"));

    const sync = (): void => {
      const bindings = compactSlots(slots).concat(preserved) as SceneInteractionBinding[];
      if (bindings.length || uiInputs.touch || enabled !== undefined) {
        const next: NonNullable<SceneConfig["interaction"]> = {};
        if (enabled !== undefined) next.enabled = enabled;
        if (uiInputs.touch) next.touch = true;
        if (bindings.length) next.bindings = bindings;
        this.config.interaction = next;
      } else {
        delete this.config.interaction;
      }
      this.hooks.onChange(false);
    };

    f.addBinding(uiInputs, "touch", { label: "follow touch" }).on("change", sync);
    // Scroll preview: the studio page never scrolls, so one slider fakes the scroll position
    // (0 = at rest, 1 = scrolled past) to author + test any `scroll` / `scrollVelocity` reaction.
    // On a real page these read the actual container scroll; this is studio-only and NEVER
    // touches config.
    const previewF = f.addFolder({ title: "Scroll preview", expanded: true });
    previewF
      .addBinding(uiInputs, "scrollPreview", {
        label: "scroll (drag to test)",
        min: 0,
        max: 1,
        step: 0.01,
      })
      .on("change", () => this.hooks.onScrollPreview(uiInputs.scrollPreview));
    // …or scroll for real: a scrollable test surface over the scene (drives the same scroll
    // input, and, unlike the slider, produces real scroll velocity). The panel stays usable.
    previewF.addButton({ title: "🖱 Scroll to test…" }).on("click", () => {
      this.hooks.onOpenScrollTest();
    });
    this.hooks.onScrollPreview(uiInputs.scrollPreview); // apply the rest state on (re)build
    this.renderBindingSlots(
      f.addFolder({ title: "Scene reactions", expanded: true }),
      slots,
      IX_SCENE_TARGETS,
      "timeOffset",
      sync,
    );
  }

  /**
   * Render a reaction list into a folder: any number of slots (each removable) plus an "Add
   * reaction" button, calling `onChange` on any edit. The everyday knobs (input → parameter → to)
   * sit up top; `from` / smoothing hide in a collapsed "fine-tune". Reads as: "as <input> goes
   * 0→1, drive <parameter> to <to>." Add/remove re-renders THIS folder in place (no panel
   * rebuild), so the live `slots` array, and any half-configured slot, survives.
   */
  private renderBindingSlots(
    folder: FolderApi,
    slots: UiSlot[],
    targets: Record<string, string>,
    defaultTarget: string,
    onChange: () => void,
    sources: Record<string, string> = IX_SOURCE_OPTIONS,
  ): void {
    const render = (): void => {
      // Clear the folder (dispose removes each blade from it, so keep taking the first until
      // empty; iterating a live children list while disposing would skip elements).
      while (folder.children.length > 0) folder.children[0].dispose();
      slots.forEach((slot, i) => {
        // Expand only the last (newest) reaction so a long list stays scannable.
        const bf = folder.addFolder({
          title: `Reaction ${i + 1}`,
          expanded: i === slots.length - 1,
        });
        bf.addBinding(slot, "source", { label: "input", options: sources }).on("change", onChange);
        bf.addBinding(slot, "target", { label: "parameter", options: targets }).on("change", () => {
          // Re-seed "to (at full)" so the new parameter actually moves (a blanket 1 is invisible
          // for narrow-range params like dispersion), and clamp `from` into the new range. The
          // to/from sliders carry per-target ranges, so the rows rebuild (deferred: a binding
          // can't dispose the pane its own change handler is running inside).
          slot.to = defaultToFor(slot.target);
          const range = rangeFor(slot.target);
          slot.from = Math.min(Math.max(slot.from, range.min), range.max);
          onChange();
          setTimeout(render, 0);
        });
        bf.addBinding(slot, "to", { label: "to (at full)", ...rangeFor(slot.target) }).on(
          "change",
          onChange,
        );
        const tune = bf.addFolder({ title: "fine-tune", expanded: false });
        tune.addBinding(slot, "fromBase", { label: "start at rest value" }).on("change", onChange);
        tune
          .addBinding(slot, "from", { label: "start value", ...rangeFor(slot.target) })
          .on("change", onChange);
        tune.addBinding(slot, "smoothing", { min: 0, max: 1, step: 0.01 }).on("change", onChange);
        bf.addButton({ title: "✕ Remove reaction" }).on("click", () => {
          slots.splice(i, 1);
          onChange();
          render();
        });
      });
      folder.addButton({ title: "＋ Add reaction" }).on("click", () => {
        // Seed a working reaction (hover is demonstrable without the scroll preview) so it
        // persists and reacts immediately; retarget/retrigger from there. Shapes seed the
        // per-shape hover: reacting to your cursor over THAT shape is the expected default.
        const slot = uiSlotFrom(undefined, defaultTarget);
        slot.source = Object.values(sources).includes("hoverSelf") ? "hoverSelf" : "hover";
        slots.push(slot);
        onChange();
        render();
      });
    };
    render();
  }

  /** One lamp's reaction list, bound to `lamp.bindings` (pointerX→X, pointerY→Y = follows the
   *  cursor). */
  private addLampInteraction(f: FolderApi, lamp: LampConfig): void {
    const loaded = lamp.bindings ?? [];
    const preserved = loaded.filter((b) => b.source.startsWith("custom:"));
    const slots: UiSlot[] = loaded
      .filter((b) => !b.source.startsWith("custom:"))
      .map((b) => uiSlotFrom(b, "x"));
    const sync = (): void => {
      const bindings = compactSlots(slots).concat(preserved) as LampInteractionBinding[];
      if (bindings.length) lamp.bindings = bindings;
      else delete lamp.bindings;
      this.hooks.onChange(false);
    };
    this.renderBindingSlots(
      f.addFolder({ title: "Reactions", expanded: loaded.length > 0 }),
      slots,
      IX_LAMP_TARGETS,
      "x",
      sync,
    );
  }

  /** The scatter's shared reaction list, bound to `scatter.interaction.bindings`: every
   *  generated shape gets its own copy, so `hoverSelf` means "the rod under the cursor".
   *  Structural: the copies are stamped on at expansion, so an edit has to regenerate. */
  private addScatterInteraction(f: FolderApi, scatter: ScatterConfig): void {
    const loaded = scatter.interaction?.bindings ?? [];
    const preserved = loaded.filter((b) => b.source.startsWith("custom:"));
    const slots: UiSlot[] = loaded
      .filter((b) => !b.source.startsWith("custom:"))
      .map((b) => uiSlotFrom(b, "emission"));
    const sync = (): void => {
      const bindings = compactSlots(slots).concat(preserved) as ItemInteractionBinding[];
      if (bindings.length) scatter.interaction = { bindings };
      else delete scatter.interaction;
      this.hooks.onChange(true);
    };
    this.renderBindingSlots(
      f.addFolder({ title: "Reactions", expanded: loaded.length > 0 }),
      slots,
      IX_ITEM_TARGETS,
      "emission",
      sync,
      IX_SOURCE_OPTIONS_ITEM,
    );
  }

  /** One shape's reaction list, bound to `item.interaction.bindings`. */
  private addItemInteraction(f: FolderApi, item: ItemConfig): void {
    const loaded = item.interaction?.bindings ?? [];
    const preserved = loaded.filter((b) => b.source.startsWith("custom:"));
    const slots: UiSlot[] = loaded
      .filter((b) => !b.source.startsWith("custom:"))
      .map((b) => uiSlotFrom(b, "emission"));
    const sync = (): void => {
      const bindings = compactSlots(slots).concat(preserved) as ItemInteractionBinding[];
      if (bindings.length) item.interaction = { bindings };
      else delete item.interaction;
      this.hooks.onChange(false);
    };
    this.renderBindingSlots(f, slots, IX_ITEM_TARGETS, "emission", sync, IX_SOURCE_OPTIONS_ITEM);
  }

  /** The shape list: the scatter's generator controls, or every hand-authored shape by group. */
  private addShapes(pane: Pane): void {
    const scatter = this.config.scatter;
    if (scatter) this.addScatterShapes(pane, scatter);
    else this.addAuthoredShapes(pane);
  }

  /** A generated scene: the scatter template, plus a header per generated shape that bakes. */
  private addScatterShapes(pane: Pane, scatter: ScatterConfig): void {
    {
      // The title stays static: showing a live count would mean disposing and rebuilding the
      // pane from inside its own change event, and the count slider is right there anyway.
      const f = pane.addFolder({ title: "Shapes", expanded: true });
      const countBinding = this.structural(
        f.addBinding(scatter, "count", { min: 0, max: 60, step: 1 }),
      );
      this.structural(f.addBinding(scatter, "seed", { min: 0, max: 9999, step: 1 }));
      this.structural(
        this.retargetsOutline(
          this.retargetsSides(
            f.addBinding(scatter.shape, "kind", {
              options: Object.fromEntries(SHAPE_KINDS.map((k) => [k, k])),
            }),
            scatter.shape,
          ),
          scatter.shape,
        ),
      );
      this.addOutline(f, scatter.shape);
      this.structural(
        f.addBinding(scatter.shape, "r", { label: "radius", min: 0.05, max: 6, step: 0.01 }),
      );
      this.structural(
        f.addBinding(scatter.shape, "len", { label: "length", min: 0.1, max: 30, step: 0.1 }),
      );
      this.structural(f.addBinding(scatter.shape, "sides", { min: 3, max: 128, step: 1 }));
      this.structural(
        f.addBinding(scatter, "spanX", { label: "span", min: 1, max: 60, step: 0.1 }),
      );
      this.structural(
        f.addBinding(scatter.position, "y", { label: "base y", min: -20, max: 20, step: 0.1 }),
      );
      this.structural(
        f.addBinding(scatter, "spread", { label: "depth", min: 0, max: 20, step: 0.1 }),
      );
      this.structural(
        f.addBinding(scatter, "lengthVariance", { label: "len vary", min: 0, max: 1, step: 0.01 }),
      );
      this.structural(
        f.addBinding(scatter, "radiusVariance", { label: "rad vary", min: 0, max: 2, step: 0.01 }),
      );
      this.structural(
        f.addBinding(scatter, "phaseJitter", {
          label: "phase jitter",
          min: 0,
          max: 3.2,
          step: 0.01,
        }),
      );
      // Stagger is radians per shape in the config, but nobody thinks in radians-per-shape; they
      // think "the row covers one full turn". Expose it as TURNS ACROSS THE ROW, so the value that
      // matters is simply 1: below it the phases cluster and the trough of the wave sits still,
      // above it the row wraps past itself. That also retires a "2π ÷ count" button that was doing
      // this arithmetic for you from the middle of a run of sliders.
      const turns = { spread: staggerToTurns(scatter.stagger, scatter.count) };
      const pushTurns = (): void => {
        scatter.stagger = turnsToStagger(turns.spread, scatter.count);
      };
      countBinding.on("change", () => {
        // Keep the spread meaning what it says when the count changes: re-derive the per-shape
        // step rather than leaving the row over- or under-covered.
        pushTurns();
        this.syncInputs();
      });
      this.structural(
        f.addBinding(turns, "spread", { label: "phase spread", min: 0, max: 2, step: 0.01 }),
      ).on("change", pushTurns);
      // Wrapped in the same "All shapes" header the hand-authored path uses: on a generated scene
      // these ARE the scene-wide controls, and labelling them identically means the section is
      // there however the scene was made rather than appearing only once you bake.
      const all = f.addFolder({ title: "All shapes", expanded: true });
      this.addMotion(all.addFolder({ title: "Motion", expanded: true }), scatter.motion, false);
      this.addMaterial(all.addFolder({ title: "Material", expanded: true }), scatter.material);
      this.addScatterInteraction(all, scatter);
      // Present here too: adding a shape to a generated scene is how you start hand-authoring it,
      // and the bake that requires is handled by onShapesChanged.
      this.addShapeButton(f);

      // The generated shapes, listed so any one of them can be found and edited. They are NOT
      // stored in the config (the scatter derives them on every rebuild), so opening one bakes
      // the arrangement into real items first. Without that, an edit to one shape would be
      // silently discarded the next time the scatter regenerated.
      //
      // Only the header is built here (no bindings): the fold handler hands off to the bake, which
      // replaces this whole pane with the hand-authored layout and reopens the same shape.
      for (let index = 0; index < scatter.count; index++) {
        const folder = f.addFolder({
          title: `${scatter.shape.kind} ${index + 1}`,
          expanded: false,
        });
        folder.on("fold", (event) => {
          if (event.expanded) this.hooks.onBakeForEdit(index);
        });
      }
    }
  }

  /** A hand-authored scene: the bulk editor, then every shape's folder, grouped as the scene is. */
  private addAuthoredShapes(pane: Pane): void {
    const count = this.config.items.length;
    const f = pane.addFolder({ title: `Shapes · ${count}`, expanded: true });

    // The bulk editor sits ABOVE the per-shape list and stays open, so the common case, "make
    // them all do this", doesn't require opening a shape to find the apply button hidden inside
    // it. It edits a draft rather than shape 1 directly: binding it to a real shape would mean
    // every nudge silently edited that one shape until you pressed apply.
    if (count > 1 || this.selectionCount > 1) this.addAllShapes(f);

    // Grouped shapes are listed INSIDE their group's folder, so the panel's structure is the
    // scene's structure. A group's folder is created where its FIRST member falls, which keeps the
    // list in scene order rather than herding every group to the top.
    const groupFolders = new Map<string, FolderApi>();
    const folderFor = (item: ItemConfig): FolderApi => {
      const group = item.group
        ? this.config.groups.find((candidate) => candidate.id === item.group)
        : undefined;
      if (!group) return f;
      let folder = groupFolders.get(group.id);
      if (!folder) {
        folder = this.addGroupFolder(f, group);
        groupFolders.set(group.id, folder);
      }
      return folder;
    };

    // EVERY shape gets a folder, however many there are, but its contents are built the first
    // time it opens, not up front. That is what makes "all of them, collapsed" affordable: a
    // populated folder is ~30 control rows whether or not it is expanded, and the pane rebuilds on
    // every structural change, so eagerly building sixty of them put a visible hitch on routine
    // edits. A header alone is cheap, so the list stays complete and selectable.
    for (const [index, item] of this.config.items.entries()) {
      const fallback = `${item.shape.kind} ${index + 1}`;
      const folder = folderFor(item).addFolder({
        title: item.name ?? fallback,
        expanded: index === this.selectedItem,
      });
      this.itemFolders.set(index, folder.element);

      let built = false;
      const build = (): void => {
        if (built) return;
        built = true;
        // Identity first: a name row rather than a double-click on the header. The header is the
        // fold toggle, so renaming there fought the open/close on every attempt, and nothing about
        // a folder title suggests it is editable.
        //
        // Bound through a proxy because `name` is optional and Tweakpane cannot bind `undefined`;
        // clearing the field puts it back to undefined so the shape falls back to "rod 3" rather
        // than carrying an empty string.
        const label = { name: item.name ?? "" };
        folder
          .addBinding(label, "name", { label: "name", placeholder: fallback })
          .on("change", () => {
            const next = label.name.trim();
            item.name = next || undefined;
            folder.title = item.name ?? fallback;
            this.hooks.onRenamed("rename shape");
          });
        folder.addButton({ title: "◎ locate in scene" }).on("click", () => {
          this.hooks.onLocateItem(index);
        });
        this.addItem(folder, item);
        folder.addButton({ title: "✕ remove shape" }).on("click", () => {
          this.hooks.onRemoveShapes([item]);
        });
        // These rows did not exist when the pane was built, so they missed the icon and hint
        // passes; both are idempotent over the rows that did.
        applyIcons(this.host);
        applyControlHints(this.host);
      };

      if (folder.expanded) build();
      folder.on("fold", (event) => {
        if (!event.expanded) return;
        build();
        // Opening a shape's config locates it in the scene, exactly like its locate button,
        // and the selection echoes back through focusItem to highlight this folder.
        if (!this.foldSync) this.hooks.onLocateItem(index);
      });
    }
    this.addShapeButton(f);
  }

  /**
   * A group's own folder: what it is called, how to find it, and how to take it apart.
   *
   * Its members' folders are appended to it by the caller as the shape list is walked, so the
   * group reads as a container rather than as a header with a list somewhere below it.
   */
  private addGroupFolder(parent: FolderApi, group: GroupConfig): FolderApi {
    const members = this.config.items.filter((item) => item.group === group.id).length;
    const fallback = groupLabel(this.config, group);
    // No glyph in the title: `applyIcons` gives a group folder its stroke icon by class.
    const folder = parent.addFolder({ title: `${fallback} · ${members}`, expanded: true });
    folder.element.classList.add("g3-group");

    // Same proxy-object trick as a shape's name: `name` is optional, and Tweakpane cannot bind
    // `undefined`. Clearing the field restores the positional fallback rather than leaving an
    // empty title.
    const label = { name: group.name ?? "" };
    folder.addBinding(label, "name", { label: "name", placeholder: fallback }).on("change", () => {
      const next = label.name.trim();
      group.name = next || undefined;
      folder.title = `${groupLabel(this.config, group)} · ${members}`;
      applyIcons(this.host); // Tweakpane rewrites the title element, taking the icon with it
      this.hooks.onRenamed("rename group");
    });
    folder.addButton({ title: "◎ locate in scene" }).on("click", () => {
      this.hooks.onLocateGroup(group.id);
    });
    // Expanding the group's config selects its members in the scene, like the button above.
    folder.on("fold", (event) => {
      if (event.expanded && !this.foldSync) this.hooks.onLocateGroup(group.id);
    });
    folder.addButton({ title: "⤫ ungroup" }).on("click", () => {
      this.hooks.onUngroup(group.id);
    });
    // Deletes the SHAPES, not just the grouping: "ungroup" directly above is the one that keeps
    // them, and having both side by side is what makes the difference legible.
    folder.addButton({ title: `✕ remove group (${members} shapes)` }).on("click", () => {
      this.hooks.onRemoveShapes(this.config.items.filter((item) => item.group === group.id));
    });
    return folder;
  }

  /**
   * Run an action and report on its own button: ✓ on success, ✕ on failure.
   *
   * A hook that resolves `false` counts as a failure: the clipboard write is the case that
   * matters, since it can be refused without throwing.
   */
  private async flashAction(
    element: HTMLElement,
    okLabel: string,
    run: () => unknown,
  ): Promise<void> {
    try {
      const result = await run();
      if (result === false) flashButtonError(element, "Failed");
      else flashButtonSuccess(element, okLabel);
    } catch (error) {
      flashButtonError(element, "Failed");
      throw error; // still surface it to the global handler
    }
  }

  /**
   * Motion + material for many shapes at once, seeded from the first one.
   *
   * TARGETS THE SELECTION when the viewport has more than one shape selected, and the whole scene
   * otherwise, same widget, same code, and the button says which. That is the whole reason
   * multi-select was worth having in the panel: "change these five" is the common request, and
   * before this the only bulk edit available was "change everything".
   */
  private addAllShapes(parent: FolderApi): void {
    const toSelection = this.selectionCount > 1;
    // The draft LIVES ON THE PANEL, not in this call. Changing the material kind rebuilds the pane
    // (the kind decides which rows exist), and a draft rebuilt with it would silently reset to the
    // first shape's values, so staging "metal" and then pressing apply wrote glass. Seeded once,
    // and only from scratch when the scene itself is replaced.
    this.bulkDraft ??= {
      motion: { ...this.config.items[0].motion },
      material: backfillMaterial({ ...this.config.items[0].material }),
    };
    const draft = this.bulkDraft;
    const title = toSelection ? `Selection · ${this.selectionCount}` : "All shapes";
    const verb = toSelection
      ? `↻ apply to ${this.selectionCount} selected`
      : "↻ apply to all shapes";
    const f = parent.addFolder({ title, expanded: true });
    this.bulkTitle = f.element.querySelector<HTMLElement>(".tp-fldv_t") ?? undefined;
    this.bulkApply = [];

    // Group / ungroup sit at the top of the SELECTION editor, because that is where you already
    // are once you have picked the shapes; ⌘G is the fast path, and this is the discoverable one.
    if (toSelection) {
      f.addButton({ title: "⛓ group selection  (⌘G)" }).on("click", () => this.hooks.onGroup());
      const grouped = this.hooks.selectedConfigs().some((item) => item.group);
      const ungroup = f.addButton({ title: "⤫ ungroup  (⌘⇧G)" });
      // Shown but inert when nothing here is grouped: hiding it would make the row above jump
      // between two and one button as the selection changes.
      ungroup.disabled = !grouped;
      ungroup.on("click", () => this.hooks.onUngroup());
      f.addButton({ title: `✕ remove ${this.selectionCount} selected` }).on("click", () => {
        this.hooks.onRemoveShapes(this.targets());
      });
    }

    const motion = f.addFolder({ title: "Motion", expanded: true });
    this.addMotion(motion, draft.motion, false);
    const motionApply = motion.addButton({ title: verb });
    this.trackBulkApply(motionApply.element);
    motionApply.on("click", () => {
      // No scatter template to mirror into: a scatter scene never reaches this editor (addShapes
      // returns early and binds the template directly).
      for (const item of this.targets()) item.motion = { ...draft.motion };
      this.hooks.onChange(false);
      this.rebuild();
    });

    const material = f.addFolder({ title: "Material", expanded: false });
    this.addMaterial(material, draft.material);
    const materialApply = material.addButton({ title: verb });
    this.trackBulkApply(materialApply.element);
    materialApply.on("click", () => {
      // Spread per item: one shared object here would be the very bug that made editing one
      // shape's material edit all of them.
      for (const item of this.targets()) item.material = { ...draft.material };
      this.hooks.onChange(true);
      this.rebuild();
    });
  }

  /** Remember an apply button's label element so a growing selection can relabel it. */
  private trackBulkApply(element: HTMLElement): void {
    const label = element.querySelector<HTMLElement>(".tp-btnv_t");
    if (label) this.bulkApply.push(label);
  }

  /** The shapes a bulk edit applies to: the viewport selection, or the whole scene. */
  private targets(): ItemConfig[] {
    if (this.selectionCount <= 1) return this.config.items;
    const selected = this.hooks.selectedConfigs();
    return selected.length > 0 ? selected : this.config.items;
  }

  /**
   * "Add shape" clones the last one.
   *
   * Adding a shape almost always means "another one of those", so inheriting its shape, material
   * and motion is the useful default and starting from a bare rod is the special case. It lands
   * beside its source rather than inside it, and comes up selected so its config is already open.
   */
  private addShapeButton(f: FolderApi): void {
    f.addButton({ title: "＋ add shape" }).on("click", () => {
      const items = this.config.items;
      items.push(createItem(undefined, items[items.length - 1]));
      this.selectedItem = items.length - 1;
      this.rebuild();
      this.hooks.onShapesChanged("add shape");
    });
  }

  private addItem(f: FolderApi, item: ItemConfig): void {
    this.structural(
      this.retargetsOutline(
        this.retargetsSides(
          f.addBinding(item.shape, "kind", {
            options: Object.fromEntries(SHAPE_KINDS.map((k) => [k, k])),
          }),
          item.shape,
        ),
        item.shape,
      ),
    );
    this.addOutline(f, item.shape);
    this.structural(
      f.addBinding(item.shape, "r", { label: "radius", min: 0.02, max: 8, step: 0.01 }),
    );
    this.structural(f.addBinding(item.shape, "thickness", { min: 0.02, max: 8, step: 0.01 }));
    this.structural(
      f.addBinding(item.shape, "len", { label: "length", min: 0.05, max: 30, step: 0.05 }),
    );
    // Meaningful on the extrusions (`slab`, `arrow`) only, but so is `length` on half the kinds;
    // the panel has always shown one editable object and let the kind decide what it reads.
    this.structural(f.addBinding(item.shape, "depth", { min: 0.02, max: 8, step: 0.01 }));
    // Faces on a prism, radial segments on everything else; see `defaultSides`. It was missing
    // here, which made the carry-over below impossible to undo by hand.
    this.structural(f.addBinding(item.shape, "sides", { min: 3, max: 128, step: 1 }));
    this.addCuts(
      f.addFolder({ title: "Cuts", expanded: (item.shape.cuts?.length ?? 0) > 0 }),
      item,
    );
    f.addBinding(item, "position");
    f.addBinding(item, "rotation");
    // Phase sits with the shape, not its motion: it is where this shape is in the cycle, which
    // is what staggers a row into a travelling wave.
    f.addBinding(item, "phase", { min: 0, max: 6.283, step: 0.001 });
    this.addMotion(f.addFolder({ title: "Motion", expanded: true }), item.motion, true);
    this.addMaterial(f.addFolder({ title: "Material", expanded: true }), item.material);
    this.addItemInteraction(
      f.addFolder({
        title: "Interaction",
        expanded: (item.interaction?.bindings?.length ?? 0) > 0,
      }),
      item,
    );
  }

  /**
   * Carve-outs for one shape.
   *
   * Laid out like the lamp list, for the same reason: a handful of small posed objects, each of
   * which needs to be findable, editable and removable on its own. `cuts` is absent rather than
   * empty on a solid shape, so adding the first one has to materialize the array, and removing
   * the last one has to take it away again, or every scene this studio ever exports grows a
   * `"cuts": []` on every shape.
   */
  private addCuts(f: FolderApi, item: ItemConfig): void {
    const cuts = item.shape.cuts ?? [];
    for (const [index, cut] of cuts.entries()) {
      const c = f.addFolder({ title: `cut ${index + 1} · ${cut.kind}`, expanded: index === 0 });
      this.structural(
        c.addBinding(cut, "kind", { options: Object.fromEntries(CUT_KINDS.map((k) => [k, k])) }),
      );
      this.structural(c.addBinding(cut, "x", { min: -8, max: 8, step: 0.01 }));
      this.structural(c.addBinding(cut, "y", { min: -8, max: 8, step: 0.01 }));
      this.structural(c.addBinding(cut, "w", { label: "width", min: 0.02, max: 12, step: 0.01 }));
      this.structural(c.addBinding(cut, "h", { label: "height", min: 0.02, max: 12, step: 0.01 }));
      // A rect's corner radius is what turns it into a slot; a circle derives both from `w`, so
      // showing either control there would be a slider that silently does nothing.
      if (cut.kind === "rect") {
        this.structural(c.addBinding(cut, "r", { label: "corner", min: 0, max: 6, step: 0.01 }));
      }
      this.structural(c.addBinding(cut, "rotation", { min: -Math.PI, max: Math.PI, step: 0.01 }));
      c.addButton({ title: "✕ remove cut" }).on("click", () => {
        cuts.splice(index, 1);
        if (cuts.length === 0) delete item.shape.cuts;
        this.rebuild();
        this.hooks.onChange(true);
      });
    }
    f.addButton({ title: "＋ add cut", disabled: cuts.length >= MAX_CUTS }).on("click", () => {
      item.shape.cuts = [...cuts, createCut()];
      this.rebuild();
      this.hooks.onChange(true);
    });
  }

  /**
   * Motion controls for one shape (or the scatter template that stamps them out).
   *
   * `applyToAll` is offered because per-shape motion makes uniformity the thing you have to ask
   * for, which is the right way round for a composition, but tedious if you genuinely want every
   * shape doing the same, so one button does it.
   */
  private addMotion(f: FolderApi, motion: MotionConfig, applyToAll: boolean): void {
    f.addBinding(motion, "kind", {
      options: Object.fromEntries(MOTION_KINDS.map((k) => [k, k])),
    });
    f.addBinding(motion, "axis", { options: { x: "x", y: "y", z: "z" } });
    f.addBinding(motion, "rate", { min: -2, max: 2, step: 0.01 });
    f.addBinding(motion, "amount", { min: 0, max: 2, step: 0.01 });
    if (!applyToAll) return;
    f.addButton({ title: "↻ apply to all shapes" }).on("click", () => {
      for (const item of this.config.items) item.motion = { ...motion };
      if (this.config.scatter) this.config.scatter.motion = { ...motion };
      this.hooks.onChange(false);
      this.rebuild();
    });
  }

  /**
   * Material bindings over a Partial: Tweakpane needs a real property to bind to, so anything the
   * config leaves unset is materialized first. `path` is deliberately only shown when the config
   * already carries one: it is half the optical path, which is derived correctly from the shape
   * unless you override it, and a slider invites overriding it wrongly.
   */
  private addMaterial(f: FolderApi, material: Partial<MaterialConfig>): void {
    backfillMaterial(material);
    const kind = material.kind ?? "glass";
    // Structural AND a panel rebuild: the kind decides which rows exist below it.
    f.addBinding(material, "kind", {
      label: "material",
      options: Object.fromEntries(MATERIAL_KINDS.map((k) => [k, k])),
    }).on("change", () => {
      if (this.syncing) return;
      // Give the new kind its characteristic surface. Only the fields that belong to the surface
      // are touched, so the transmissive optics survive a round trip through an opaque kind.
      Object.assign(material, MATERIAL_PRESETS[material.kind ?? "glass"]);
      this.rebuild();
      this.hooks.onChange(true);
    });

    if (isTransmissive(kind)) {
      for (const key of TRANSMISSIVE_KEYS) {
        const label = key === "hueShift" ? { label: "hue shift" } : {};
        f.addBinding(material, key, { ...label, ...rangeFor(key) });
      }
      if (material.path !== undefined) f.addBinding(material, "path", RANGES.path);
      if (typeof material.tint === "string" && material.tint) f.addBinding(material, "tint");
      if (kind === "frosted") {
        f.addBinding(material, "roughness", RANGES.roughness);
      }
      if (kind === "glitter") {
        f.addBinding(material, "sparkle", RANGES.sparkle);
        f.addBinding(material, "sparkleScale", { label: "grain", ...RANGES.sparkleScale });
      }
      if (kind === "liquid") {
        f.addBinding(material, "ripple", RANGES.ripple);
        f.addBinding(material, "rippleScale", { label: "wave scale", ...RANGES.rippleScale });
        f.addBinding(material, "flow", RANGES.flow);
      }
      // A pair: `iridescence` is the on-switch, `filmNm` picks which bands sweep the shape.
      f.addBinding(material, "iridescence", RANGES.iridescence);
      f.addBinding(material, "filmNm", { label: "film (nm)", ...RANGES.filmNm });
      return;
    }

    // Opaque: no refraction, so nothing here about paths, absorption or IOR.
    if (kind === "metal") {
      // Measured F0 for real conductors. A hand-picked colour here is the single fastest way to
      // make a metal look fake, so the list leads and the free-form picker follows it.
      const metals: Record<string, string> = { custom: "custom" };
      for (const name of Object.keys(METAL_F0)) metals[name] = name;
      const pick = { metal: matchMetal(material.albedo) };
      f.addBinding(pick, "metal", { options: metals }).on("change", () => {
        const hex = METAL_F0[pick.metal];
        if (!hex) return;
        material.albedo = hex;
        // The measured edge reflectance travels with the metal: they are two halves of one
        // measurement, and F0 without its F82 is the uniformly-coloured metal this was fixing.
        material.edgeTint = METAL_F82[pick.metal] ?? "";
        this.hooks.onChange(false);
        this.refresh();
      });
    }
    f.addBinding(material, "albedo", { label: kind === "metal" ? "F0 colour" : "colour" });
    if (kind === "metal" && material.edgeTint) {
      f.addBinding(material, "edgeTint", { label: "edge (F82)" });
    }
    for (const key of OPAQUE_KEYS) f.addBinding(material, key, rangeFor(key));
  }

  // ---------------------------------------------------------------- output ---

  private addOutput(pane: Pane): void {
    const f = pane.addFolder({ title: "Output", expanded: true });
    const size = this.size;

    const presetOptions: Record<string, string> = {};
    for (const [id, preset] of Object.entries(EXPORT_PRESETS)) {
      const gpu = exportGpuWarning(preset.width, preset.height);
      // The marker LEADS: a <select> shows only the head of the selected option, so a trailing
      // warning is exactly the part that gets truncated away once it is the current choice.
      presetOptions[
        `${gpu ? `⚠ ${gpu.short} · ` : ""}${preset.label} · ${preset.width}×${preset.height}`
      ] = id;
    }
    presetOptions["Custom"] = CUSTOM_EXPORT_PRESET;

    const presetBinding = f.addBinding(size, "preset", { label: "size", options: presetOptions });
    const lockBinding = f.addBinding(size, "lockAspectRatio", { label: "lock ratio" });
    const widthBinding = f.addBinding(size, "width", {
      label: "width px",
      min: MIN_OUTPUT_DIMENSION,
      max: MAX_OUTPUT_DIMENSION,
      step: 1,
    });
    const heightBinding = f.addBinding(size, "height", {
      label: "height px",
      min: MIN_OUTPUT_DIMENSION,
      max: MAX_OUTPUT_DIMENSION,
      step: 1,
    });

    // A readout under the size rows: the exact ratio, plus a warning before an export that will
    // hurt. Four passes per frame means the usual "4K is fine" intuition does not hold.
    const note = document.createElement("div");
    note.className = "g3-note";
    this.sizeNote = note;
    const warn = document.createElement("div");
    warn.className = "g3-warn";
    warn.setAttribute("role", "status");
    warn.hidden = true;
    this.sizeWarn = warn;

    presetBinding.on("change", () => {
      if (this.syncing) return;
      applyExportPreset(size, size.preset);
      this.syncInputs();
      this.updateSizeNote();
    });
    // Beside the dimensions rather than in Guides: this is what those numbers MEAN on screen, and
    // the moment anyone wants it is the moment they have just typed one in and it looked the same.
    const actualBinding = f.addBinding(this.view, "actualSize", { label: "actual size" });
    actualBinding.on("change", () => {
      if (this.syncing) return;
      this.updateSizeNote(); // the preview now renders at the export size, which the note says
    });

    lockBinding.on("change", () => {
      if (this.syncing) return;
      if (size.lockAspectRatio) captureExportAspectRatio(size);
      this.updateSizeNote();
    });
    widthBinding.on("change", (event) => {
      if (this.syncing) return;
      applyCustomExportDimension(size, "width", size.width);
      // Only on the last event of a drag: re-writing the inputs mid-drag fights the pointer.
      if (event.last) this.syncInputs();
      this.updateSizeNote();
    });
    heightBinding.on("change", (event) => {
      if (this.syncing) return;
      applyCustomExportDimension(size, "height", size.height);
      if (event.last) this.syncInputs();
      this.updateSizeNote();
    });
    // The note only: a rebuild does not change the size, so nothing here refits the preview.
    this.renderSizeNote();

    // Only advertise formats this browser can actually encode: canvas encoders silently fall
    // back to PNG rather than failing, so an unsupported choice would produce a mislabelled file.
    this.unsupported.length = 0;
    const imageOptions: Record<string, ImageFormat> = {};
    for (const [format, definition] of Object.entries(IMAGE_FORMATS)) {
      if (canExportImageFormat(format as ImageFormat)) {
        imageOptions[definition.label] = format as ImageFormat;
      } else {
        this.unsupported.push(definition.label);
      }
    }
    if (!Object.values(imageOptions).includes(this.state.imageFormat)) {
      this.state.imageFormat = Object.values(imageOptions)[0] ?? "png";
    }
    const imageFormatBinding = f.addBinding(this.state, "imageFormat", {
      label: "still format",
      options: imageOptions,
    });
    const qualityBinding = f.addBinding(this.state, "imageQuality", {
      label: "quality",
      min: 0.1,
      max: 1,
      step: 0.01,
    });
    const exportImage = f.addButton({ title: "📷 Save still" });
    const refreshImage = (): void => {
      const definition = IMAGE_FORMATS[this.state.imageFormat];
      qualityBinding.hidden = !definition.lossy;
      exportImage.title = `📷 Save still (.${definition.extension})`;
      // Retitling rewrites the button's text, taking its icon and its hint glyph with it.
      applyIcons(this.host);
      applyControlHints(this.host);
      this.renderSizeNote();
    };
    imageFormatBinding.on("change", refreshImage);
    exportImage.on("click", () => this.hooks.onExportImage());
    refreshImage();

    // MP4 recording works in Chromium and Safari but not Firefox, so only offer what
    // MediaRecorder here actually supports; pickVideoMime still falls back at record time.
    const videoOptions: Record<string, RecordFormat> = { WebM: "webm" };
    if (canRecordFormat("mp4")) videoOptions["MP4"] = "mp4";
    else this.unsupported.push("MP4");
    if (canRecordWebpAnimation()) videoOptions["Animated WebP"] = "webp";
    else this.unsupported.push("Animated WebP");
    videoOptions["GIF"] = "gif"; // no browser support to probe; we encode it ourselves
    if (!Object.values(videoOptions).includes(this.state.videoFormat)) {
      this.state.videoFormat = "webm";
    }
    const videoBinding = f.addBinding(this.state, "videoFormat", {
      label: "video format",
      options: videoOptions,
    });
    // Both feed the frame-count hint, so both have to refresh it.
    f.addBinding(this.state, "recordSeconds", { label: "seconds", min: 1, max: 30, step: 1 }).on(
      "change",
      () => this.updateSizeNote(),
    );
    const fpsBinding = f
      .addBinding(this.state, "recordFps", { label: "fps", min: 8, max: 60, step: 1 })
      .on("change", () => this.updateSizeNote());
    const record = f.addButton({ title: this.recordTitle() });
    record.on("click", () => this.hooks.onToggleRecord());
    this.recordButton = record;
    const refreshRecord = (): void => {
      // fps only means anything for the frame-walked formats; MediaRecorder runs at whatever the
      // scene sustains, so showing the slider there would be a lie.
      fpsBinding.hidden = !isFrameWalked(this.state.videoFormat);
      this.syncRecordButton();
      this.renderSizeNote();
    };
    videoBinding.on("change", refreshRecord);
    refreshRecord();

    // A format the browser cannot encode is dropped from the list, which looks like it was never
    // offered. Name it instead ("where did WebP go" is otherwise unanswerable from the UI), and
    // name somewhere it does work, or the note is a dead end.
    //
    // Chromium is always the right answer here whatever is missing, and that is not a coincidence:
    // the two things that can be absent are canvas WebP encoding (which Safari lacks, and which
    // Animated WebP is muxed from) and MediaRecorder H.264 (which Firefox lacks). Chromium has
    // both, so it is the one engine that covers every entry this list can hold.
    if (this.unsupported.length > 0) {
      const missing = document.createElement("div");
      missing.className = "g3-note";
      missing.textContent = `Not encodable in this browser: ${this.unsupported.join(", ")}. Use Chrome.`;
      record.element.after(missing);
    }

    f.addButton({ title: "🖥 Save embed (.html)" }).on("click", () => this.hooks.onExportEmbed());
    f.addButton({ title: "⟨⟩ Get code…" }).on("click", () => this.hooks.onExportCode());

    // Placed last, on purpose: Tweakpane re-appends its rack's own children as each row is added,
    // which pushes any foreign node to the end of the folder. Inserting the readout only once
    // every row exists is what keeps it under the size controls it describes.
    heightBinding.element.after(note);
    note.after(warn);
  }

  private recordTitle(): string {
    if (!this.state.recording) return "🎬 Record clip";
    if (isFrameWalked(this.state.videoFormat)) {
      // Frame-walking is not live, so a plain "Stop" would look hung on a long clip.
      return `⏹ Encoding ${Math.round(this.state.recordProgress * 100)}%`;
    }
    return "⏹ Stop recording";
  }

  /** Flip the record button's label (and re-apply its icon) when recording starts or stops. */
  syncRecordButton(): void {
    if (!this.recordButton) return;
    this.recordButton.title = this.recordTitle();
    applyIcons(this.host);
  }

  /**
   * Re-read the export size into the panel's own inputs.
   *
   * The corner-drag handles write straight to the shared `size` object, so the sliders and the
   * preset dropdown are stale until this runs.
   */
  syncOutputSize(): void {
    this.syncInputs();
    // Deliberately NOT updateSizeNote(): that fires onOutputSizeChange, which refits the frame to
    // the stage, and a corner drag has just set the size the user actually wants it at.
    this.renderSizeNote();
  }

  /**
   * Write the model back into the inputs without the write looking like a user edit.
   *
   * The rebuild guard is not defensive tidiness. Tweakpane throws "View has been already disposed"
   * from a blade whose rack went away, and a pane whose FOLDER SET changed between rebuilds can be
   * left holding one: switching to a scene that has a beam, where the previous one had none, is
   * exactly that shape. A second refresh then works, which is the tell that the state is stale
   * rather than wrong.
   *
   * Rebuilding is the correct recovery and not a mask: it is what a pane out of step with its
   * config needs anyway, `restoreView` puts the folders back as they were, and a refresh failing
   * must never take its caller down: the callers are a file picker and the dev bridge, both of
   * which have already applied the change by the time they ask the panel to catch up.
   */
  private syncInputs(): void {
    this.syncing = true;
    try {
      this.pane.refresh();
    } catch {
      this.syncing = false;
      this.rebuild();
    } finally {
      this.syncing = false;
    }
  }

  /** A size change made from the panel: refit the frame, then redraw the readout. */
  private updateSizeNote(): void {
    this.hooks.onOutputSizeChange();
    this.renderSizeNote();
  }

  private renderSizeNote(): void {
    if (!this.sizeNote || !this.sizeWarn) return;
    const { width, height } = this.size;
    const frames = Math.round(this.state.recordSeconds * this.state.recordFps);
    const walked = isFrameWalked(this.state.videoFormat);
    const gif = this.state.videoFormat === "gif";
    // GIF cannot store most frame rates exactly; say what the file will play at.
    const playbackFps = gif ? gifEffectiveFps(this.state.recordFps) : this.state.recordFps;
    const fpsNote =
      gif && playbackFps !== this.state.recordFps ? ` at ${playbackFps.toFixed(1)} fps` : "";

    // The note is facts: what you will get.
    this.sizeNote.textContent =
      `${width} × ${height} · ${aspectRatioLabel(width, height)}` +
      (walked && !this.state.recording ? ` · ${frames} frames${fpsNote}` : "");

    // The warnings are problems: what will be wrong, or slow, about getting it.
    const warnings: string[] = [];
    const gpu = exportGpuWarning(width, height);
    if (gpu) warnings.push(gpu.detail);
    if (gpu && this.view.actualSize) {
      warnings.push(
        "Actual size renders the live preview at this size too. Turn it off to work at the fitted size.",
      );
    }
    if (
      this.config.transparentBackground &&
      !IMAGE_FORMATS[this.state.imageFormat].supportsTransparency
    ) {
      warnings.push(
        `${IMAGE_FORMATS[this.state.imageFormat].label} has no alpha; the still will come out on black.`,
      );
    }
    if (walked && !this.state.recording) {
      if (gif) {
        warnings.push(
          `GIF is 256 colours per frame; expect banding on these gradients` +
            (Math.max(width, height) > MAX_GIF_EDGE
              ? `, and the clip is downscaled to ${MAX_GIF_EDGE}px.`
              : "."),
        );
      } else if ((width * height * frames) / 1e6 >= 120) {
        warnings.push(`${frames} frames to encode; expect a wait and a large file.`);
      }
    }
    this.sizeWarn.hidden = warnings.length === 0;
    this.sizeWarn.textContent = warnings.map((w) => `⚠ ${w}`).join("  ");
  }

  private addPerformance(pane: Pane): void {
    const f = pane.addFolder({ title: "Performance", expanded: true });
    // Four passes per frame is a real cost; these two are the knobs that matter on a phone.
    this.structural(f.addBinding(this.config, "quality", { min: 0.35, max: 2, step: 0.05 }));
    f.addBinding(this.config, "dprMax", { label: "max DPR", min: 0.5, max: 3, step: 0.25 });
    // Structural: it adds a whole render pass, so the renderer rebuilds rather than refreshes.
    this.structural(
      f.addBinding(this.config, "measuredThickness", { label: "measured thickness" }),
    );

    // The ENGINE, not the backend: "webgpu" selects three's node renderer, which still falls back
    // to a WebGL backend where the browser has no WebGPU. Fetched on demand (it is a second three
    // build), so the first switch has a moment of load.
    //
    // Labelled EXPERIMENTAL in the option itself rather than only in the hint: the hint is a hover,
    // and someone comparing two renders needs to know which one is the reference without going
    // looking for it.
    f.addBinding(this.state, "renderer", {
      label: "engine",
      options: { WebGL: "webgl", "WebGPU (TSL) · experimental": "webgpu" },
    }).on("change", (event) => {
      // Not `structural()`: this replaces the renderer rather than rebuilding it, and the scene
      // config is untouched, so it must not run the usual change/history path.
      if (this.syncing) return;
      void this.hooks.onRendererChange(event.value as RendererKind);
    });
  }

  /** Preview aids. Separate from Scene because none of it is part of the scene: it never
   *  serializes and never reaches an export. */
  private addView(pane: Pane): void {
    const f = pane.addFolder({ title: "Guides", expanded: true });
    const redraw = (): void => this.hooks.onViewChanged();
    f.addBinding(this.view, "grid", { label: "grid" }).on("change", redraw);
    f.addBinding(this.view, "gridDivisions", { label: "divisions", min: 2, max: 12, step: 1 }).on(
      "change",
      redraw,
    );
    f.addBinding(this.view, "gridCentre", { label: "centre lines" }).on("change", redraw);
    // A level, not a rotated grid: set it to match camera roll and it lines up with a deliberately
    // tilted frame; leave it at 0 and it stays true, which is what shows how far off level you are.
    f.addBinding(this.view, "gridTilt", {
      label: "tilt guide °",
      min: -45,
      max: 45,
      step: 0.5,
    }).on("change", redraw);
  }

  private addActions(pane: Pane): void {
    const f = pane.addFolder({ title: "Actions", expanded: true });

    // Presets are the actual product for most people, so the picker leads, and it shows rendered
    // thumbnails rather than a dropdown, because "Skewer" and "Assembly" mean nothing until you
    // have seen them.
    const content = (f.element.querySelector(".tp-fldv_c") as HTMLElement | null) ?? f.element;
    this.presets = new PresetPicker(content, Object.keys(PRESETS), presetLabel, this.presetName, {
      onSelect: (name) => this.hooks.onSelectPreset(name),
    });

    f.addButton({ title: "🔄 Reset to preset" }).on("click", () => this.hooks.onReset());
    f.addButton({ title: "✏ Edit config…" }).on("click", () => this.hooks.onEditConfig());
    // These four confirm ON the button rather than through a toast: the eye is already there,
    // and a toast in the far corner asks it to travel for no reason.
    const save = f.addButton({ title: "💾 Save config (.json)" });
    save.on("click", () => void this.flashAction(save.element, "Saved", this.hooks.onSaveConfig));
    f.addButton({ title: "📂 Load config (.json)" }).on("click", () => this.hooks.onLoadConfig());
    const link = f.addButton({ title: "🔗 Copy share link" });
    link.on("click", () => void this.flashAction(link.element, "Link copied", this.hooks.onShare));
    const wallpaper = f.addButton({ title: "🖥 Wallpaper folder (.zip)" });
    wallpaper.on(
      "click",
      () => void this.flashAction(wallpaper.element, "Saved", this.hooks.onExportWallpaper),
    );
    f.addButton({ title: "🌍 Publish to gallery" }).on("click", () => this.hooks.onPublish());
  }
}
