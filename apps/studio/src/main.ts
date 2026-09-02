/**
 * Materials Studio.
 *
 * One `SceneConfig` object is the single source of truth: the renderer reads it every frame, the
 * Tweakpane panel mutates it in place, and every export serializes it.
 *
 * That object is **the renderer's own** — `renderer.getConfig()`. The renderer normalizes whatever
 * it is handed through `ensureSceneConfig`, which returns a fresh object, so anything holding on
 * to the config it passed *in* is mutating something nothing reads. `adopt()` is the one place
 * that re-syncs, and every path that replaces the scene goes through it.
 */

import "./style.css";
import {
  groupItems,
  groupLabel,
  defaultSides,
  MAX_OUTLINE,
  outlineFromSvg,
  pruneGroups,
  type SceneConfig,
  type ItemConfig,
  type ShapeConfig,
  ungroupItems,
} from "@materials3d/core";
import { bakeScatter, MaterialRenderer } from "@materials3d/core/renderer";
import type { RendererKind } from "@materials3d/core";
import type { MaterialItem } from "@materials3d/core";
import { PRESETS } from "@materials3d/core/presets";
import { ControlPanel, type PanelState, type ViewState } from "./ui/ControlPanel";
import type { CodeEditor, EditorLanguage } from "./ui/CodeEditor";
import { publishToGallery } from "./publishToGallery";
import { toast } from "./ui/Toast";
import { CODE_TARGETS, exportCode, minimalConfig, type CodeTarget } from "./export/exportCode";
import { exportEmbedHtml, exportWallpaperFolder, saveConfig, saveStill } from "./export/exporters";
import { recordAnimatedWebp, recordGif, startRecording, type Recording } from "./export/record";
import {
  aspectRatioLabel,
  DEFAULT_EXPORT_SIZE,
  exportGpuWarning,
  isFrameWalked,
  type ExportSize,
} from "./output/formats";
import { randomizeConfig, randomizeLamps } from "./randomize";
import { presetLabel } from "./presetLabels";
import { History } from "./history";
import { HistoryControls } from "./ui/HistoryControls";
import { generatePresetThumbs, HistoryThumbnailer } from "./ui/thumbs";
import { GESTURE_ICONS } from "./ui/icons";
import { SelectionOverlay } from "./ui/SelectionOverlay";
import { DEFAULT_GRID, GridOverlay } from "./ui/GridOverlay";
import { ScrollTestOverlay } from "./ui/ScrollTestOverlay";
import { OutputResizeHandle } from "./ui/OutputResizeHandle";
import { RecordingOverlay } from "./ui/RecordingOverlay";
import { byId, on } from "./util/dom";
import { copy } from "./util/download";
import { fromLocationHash, toShareUrl } from "./util/share";

/** Which language each code tab is highlighted as. */
const TARGET_LANGUAGE: Record<CodeTarget, EditorLanguage> = {
  react: "tsx",
  element: "html",
  vanilla: "js",
  cdn: "html",
  json: "json",
};

const JSON_HINT = "Linted as you type; Apply runs the same validator the renderer uses.";

const stage = byId("stage");
const scene = byId("scene");
const captureSize = byId("capture-size");
const dialog = byId<HTMLDialogElement>("dialog");
const dialogHost = byId("dialog-body");
const dialogTabs = byId("dialog-tabs");
const dialogTitle = byId("dialog-title");
const dialogNote = byId("dialog-note");
const applyButton = byId<HTMLButtonElement>("dialog-apply");
const saveButton = byId<HTMLButtonElement>("dialog-save");
const embedButton = byId<HTMLButtonElement>("dialog-embed");
const fileInput = byId<HTMLInputElement>("file-input");

let presetName = "skewer";
let renderer: MaterialRenderer;
/** Which engine is live. Studio-only state; the scene config says nothing about it. */
let rendererKind: RendererKind = "webgl";
let panel: ControlPanel;
// CodeMirror is ~540kB of the studio bundle and nothing needs it until a dialog opens, so it is
// fetched on first use. Every dialog entry point is already async-tolerant.
let editor: CodeEditor | null = null;
let editorLoading: Promise<CodeEditor> | null = null;
let recording: Recording | null = null;
let recordingOverlay: RecordingOverlay;
let history: History;
let historyControls: HistoryControls;
let selection: SelectionOverlay;
let grid: GridOverlay;
let scrollTest: ScrollTestOverlay;
/** True while WE swap the config (preset / undo / redo / import). Suppresses edit capture, so a
 *  restore does not immediately commit itself back onto the timeline. */
const applying = { on: false };
/** Timestamp of the last panel refresh during a viewport gesture — see the throttle in onTransform. */
let lastPanelSync = 0;
let codeTarget: CodeTarget = "react";
let dialogMode: "code" | "json" = "code";

const size: ExportSize = { ...DEFAULT_EXPORT_SIZE };
const view: ViewState = {
  actualSize: false,
  grid: false,
  gridDivisions: DEFAULT_GRID.divisions,
  gridCentre: DEFAULT_GRID.centre,
  gridTilt: DEFAULT_GRID.tilt,
};
const state: PanelState = {
  renderer: "webgl",
  imageFormat: "webp",
  imageQuality: 0.94,
  videoFormat: "webm",
  recordSeconds: 6,
  recordFps: 24,
  recording: false,
  recordProgress: 0,
};

/** The live config — always the renderer's own object, never a copy. */
function config(): SceneConfig {
  return renderer.getConfig();
}

/** A checkerboard behind the canvas, so "transparent" is visible rather than merely true. */
function syncTransparency(transparent: boolean): void {
  scene.dataset.transparent = transparent ? "1" : "";
}

/** Structural changes rebuild geometry; everything else is a uniform push. */
function applyChange(structural: boolean): void {
  if (structural) {
    // rebuild(), not setConfig(): the panel has already mutated the renderer's own config, so
    // setConfig's structural diff would compare that object against itself and find nothing.
    // Identity is preserved either way, so the panel's bindings stay valid.
    renderer.rebuild();
    if (!applying.on) history.markDirty();
    return;
  }
  renderer.refresh();
  renderer.refreshPlayback();
  // Paused and reduced-motion scenes have no loop to pick the change up on their own.
  if (config().paused) renderer.renderOnce();
  if (!applying.on) history.markDirty();
}

/** Copy a dragged mesh's live transform back into its config, so it survives a save or reload. */
function syncItemTransform(item: MaterialItem): void {
  if (!item.config) return;
  // Read `home`/`homeRotation`, which the gesture edits — NOT the mesh, whose pose a running
  // motion has already displaced. Capturing the animated pose would bake a frame of the animation
  // into the shape's resting position every time you touched it.
  const { home, homeRotation, mesh } = item;
  item.config.position = { x: home.x, y: home.y, z: home.z };
  item.config.rotation = { x: homeRotation.x, y: homeRotation.y, z: homeRotation.z };
  item.config.scale = { x: mesh.scale.x, y: mesh.scale.y, z: mesh.scale.z };
}

/**
 * Make a scattered scene individually editable.
 *
 * A `scatter` block generates its shapes, so a generated rod has no config of its own to move or
 * highlight. Baking expands it into a concrete `items` list — pixel-identical, since the same
 * generator produced it — and is a normal undoable step, so it costs nothing to try.
 *
 * Deliberately silent. It fires on the way into a selection, a marquee, a group — gestures where
 * the frame does not change and the announcement is the only thing that moves. The history entry
 * is where it belongs on the record.
 */
function ensureSelectable(): boolean {
  if (!config().scatter) return false;
  history.flush();
  bakeScatter(config());
  renderer.rebuild();
  panel.setConfig(config(), presetName);
  history.commit(config(), presetName, "make shapes editable");
  return true;
}

/**
 * Delete shapes. The one implementation every remove route funnels into — the panel's per-shape
 * button, its remove-group and remove-selection buttons, and the Delete key.
 *
 * The selection is cleared FIRST: `rebuild()` disposes every `MaterialItem`, and the overlay tracks
 * what it holds on an animation frame, so leaving a deleted shape selected means projecting bounds
 * from a disposed mesh on the very next tick.
 */
function removeConfigs(configs: readonly ItemConfig[]): void {
  const live = config();
  const doomed = new Set(configs.filter((item) => live.items.includes(item)));
  if (doomed.size === 0) return;
  history.flush();
  selection.select(null);
  live.items = live.items.filter((item) => !doomed.has(item));
  // Deleting members can leave a group below the minimum, or empty it entirely.
  pruneGroups(live);
  renderer.rebuild();
  panel.setConfig(live, presetName);
  history.commit(
    live,
    presetName,
    doomed.size > 1 ? `remove ${doomed.size} shapes` : "remove shape",
  );
}

/**
 * The viewport route into {@link removeConfigs}: bake first, because a generated shape has no
 * config to delete, and read the items back by INDEX since the bake replaces every one of them.
 */
function removeItems(items: readonly MaterialItem[]): void {
  const live = renderer.getItems();
  const indices = items.map((item) => live.indexOf(item)).filter((index) => index >= 0);
  ensureSelectable();
  removeConfigs(
    indices
      .map((index) => renderer.getItems()[index]?.config)
      .filter((c): c is ItemConfig => Boolean(c)),
  );
}

/**
 * Bind the selected shapes into one group, or dissolve the groups they belong to.
 *
 * Grouping is a config edit like any other — it needs a bake first (a generated scene has no
 * shapes to group), a history step, and a panel rebuild, because the shape list is laid out BY
 * group. The selection is then re-asserted so the new group comes up selected as one object,
 * which is both the confirmation that it worked and where you want to be next.
 */
function regroup(items: readonly MaterialItem[], mode: "group" | "ungroup"): void {
  // Indices BEFORE the bake. Baking replaces every `MaterialItem`, so the objects the overlay handed
  // us — and the configs they point at — are stale on the far side of it. Position is what
  // survives: the bake preserves order and count by construction.
  const live = renderer.getItems();
  const indices = items.map((item) => live.indexOf(item)).filter((index) => index >= 0);
  ensureSelectable();
  const configs = indices
    .map((index) => renderer.getItems()[index]?.config)
    .filter((c): c is ItemConfig => Boolean(c));
  if (configs.length === 0) return;

  history.flush();
  const done =
    mode === "group" ? Boolean(groupItems(config(), configs)) : ungroupItems(config(), configs);
  if (!done) {
    toast(mode === "group" ? "Select two or more shapes to group" : "Nothing grouped here");
    return;
  }
  panel.setConfig(config(), presetName);
  history.commit(
    config(),
    presetName,
    mode === "group" ? `group ${configs.length} shapes` : "ungroup",
  );
  toast(mode === "group" ? `Grouped ${configs.length} shapes` : "Ungrouped");
  // Nothing rebuilt the scene — grouping touches no geometry — so the same `MaterialItem`s are still
  // the members, and re-asserting brings the new group up selected as one object.
  selection.setSelection(
    renderer.getItems().filter((item) => item.config && configs.includes(item.config)),
  );
}

/**
 * Replace the whole scene and re-sync the panel to the renderer's new config object.
 *
 * `record` is false only for undo/redo/jump: those already know where they are on the timeline,
 * and committing the restore would append it as a new step and make redo unreachable.
 */
function adopt(next: Partial<SceneConfig>, name: string, record = true, label?: string): void {
  if (record) history.flush(); // commit any pending manual edit as its own step first
  applying.on = true;
  selection?.select(null); // the items about to be replaced are what the selection points at
  renderer.setConfig(next);
  presetName = name;
  panel.setConfig(config(), presetName);
  syncTransparency(config().transparentBackground);
  applying.on = false;
  if (record) history.commit(config(), presetName, label);
}

function doUndo(): void {
  history.flush();
  const restored = history.undo();
  if (restored) adopt(restored.config, restored.presetName, false);
}

function doRedo(): void {
  history.flush();
  const restored = history.redo();
  if (restored) adopt(restored.config, restored.presetName, false);
}

function doJump(id: number): void {
  history.flush();
  const restored = history.jumpToId(id);
  if (restored) adopt(restored.config, restored.presetName, false);
}

// ------------------------------------------------------------------ dialog --

async function ensureEditor(): Promise<CodeEditor> {
  if (editor) return editor;
  editorLoading ??= import("./ui/CodeEditor").then(({ CodeEditor: Editor }) => {
    editor = new Editor(dialogHost, {
      // Clear a stale parse message the moment you start fixing it.
      onChange: () => {
        if (dialogMode === "json" && dialogNote.dataset.error) {
          delete dialogNote.dataset.error;
          dialogNote.textContent = JSON_HINT;
        }
      },
    });
    return editor;
  });
  return editorLoading;
}

function renderDialogBody(): void {
  if (!editor) return;
  if (dialogMode === "json") {
    editor.set(`${JSON.stringify(config(), null, 2)}\n`, "json", false);
    return;
  }
  const snippet = exportCode(
    config(),
    codeTarget,
    presetName === "custom" ? undefined : presetName,
  );
  editor.set(snippet, TARGET_LANGUAGE[codeTarget], true);
}

function buildDialogTabs(): void {
  dialogTabs.replaceChildren();
  if (dialogMode !== "code") return;
  for (const target of CODE_TARGETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = target.label;
    button.setAttribute("aria-selected", String(target.id === codeTarget));
    button.addEventListener("click", () => {
      codeTarget = target.id;
      buildDialogTabs();
      renderDialogBody();
    });
    dialogTabs.appendChild(button);
  }
}

async function openDialog(mode: "code" | "json"): Promise<void> {
  dialogMode = mode;
  dialogTitle.textContent = mode === "code" ? "Get code" : "Edit config";
  dialogNote.textContent =
    mode === "code" ? "Defaults are stripped — what's left is what you changed." : JSON_HINT;
  delete dialogNote.dataset.error;
  applyButton.hidden = mode !== "json";
  saveButton.hidden = mode !== "json";
  embedButton.hidden = mode !== "code";
  buildDialogTabs();
  dialog.showModal();
  const ready = await ensureEditor();
  // The mode can have changed while the chunk was in flight (a second click); re-read it rather
  // than rendering the body this call was opened for.
  renderDialogBody();
  if (dialogMode === "json") ready.focus();
}

function applyJson(): void {
  let parsed: Partial<SceneConfig>;
  try {
    parsed = JSON.parse(editor?.value ?? "") as Partial<SceneConfig>;
  } catch (error) {
    // The lint gutter already marks the line; move the cursor there too, since a long config can
    // put the offending line well off screen.
    const message = (error as Error).message;
    dialogNote.textContent = message;
    dialogNote.dataset.error = "1";
    const position = /at position (\d+)/.exec(message);
    if (position) editor?.revealOffset(Number(position[1]));
    return;
  }
  adopt(parsed, "custom", true, "edit config");
  dialog.close();
  toast("Config applied");
}

// ----------------------------------------------------------------- exports --

function exportName(): string {
  return `glass-${presetName}`;
}

/** Re-roll the lamp field — one flushed, labelled history entry. Shared by the panel's shuffle
 *  button and the `r` key, so both take the same commit/toast path. */
function shuffleLampField(): void {
  history.flush();
  randomizeLamps(config());
  panel.refresh();
  applyChange(false);
  history.commit(config(), presetName, "shuffle lamps");
  toast("New lamp field");
}

function exportImage(): void {
  void saveStill(renderer, exportName(), state.imageFormat, state.imageQuality, size).then(
    () => toast(`Saved ${size.width}×${size.height}`),
    (error: Error) => toast(error.message),
  );
}

/**
 * Pick a backdrop image or video off disk.
 *
 * Read as a data URI rather than an object URL so the choice survives a save/reload and travels
 * inside a shared config — an object URL is only valid for the tab that made it. Large files make
 * for large configs; that is the trade for a config that is a single self-contained document.
 */
function pickBackgroundMedia(kind: "image" | "video"): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = kind === "video" ? "video/*" : "image/*";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("error", () => toast(`Could not read ${file.name}`));
    reader.addEventListener("load", () => {
      const url = typeof reader.result === "string" ? reader.result : undefined;
      if (!url) return;
      const c = config();
      // One source at a time — a video would otherwise always win and the image look ignored.
      c.backgroundImageUrl = kind === "image" ? url : undefined;
      c.backgroundVideoUrl = kind === "video" ? url : undefined;
      c.backgroundMode = "image";
      applyChange(true);
      panel.refresh();
      history.commit(config(), presetName, `backdrop ${kind}`);
    });
    reader.readAsDataURL(file);
  });
  input.click();
}

/**
 * Load a shape's outline from a `.svg` on disk.
 *
 * Read as TEXT, not as a data URI like the backdrop media above: an outline is not an asset the
 * scene displays, it is geometry the config carries, and it goes through the same
 * {@link outlineFromSvg} the normalizer uses on a pasted string — so an upload and a paste of the
 * same file cannot produce different shapes.
 *
 * A file with no `<path>` in it says so rather than falling back. Substituting the default outline
 * would tell someone who just uploaded a logo that their file was fine.
 */
function pickOutlineSvg(shape: ShapeConfig): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".svg,image/svg+xml";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("error", () => toast(`Could not read ${file.name}`));
    reader.addEventListener("load", () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const outline = outlineFromSvg(text, MAX_OUTLINE);
      if (!outline) {
        toast(`No <path> in ${file.name} — flatten shapes to paths and re-export`);
        return;
      }
      shape.outline = outline;
      // The kind is usually still whatever it was: the button sits on every shape, and picking a
      // file is a statement of what the shape is meant to BE. Leaving a rod as a rod would drop
      // the file on the floor and read as a failed upload.
      const wasPath = shape.kind === "path";
      shape.kind = "path";
      if (!wasPath) shape.sides = defaultSides("path");
      applyChange(true);
      // setConfig, not refresh(): becoming a `path` adds the outline field to the panel, and
      // refresh only re-reads the controls that already exist.
      panel.setConfig(config(), presetName);
      history.commit(config(), presetName, `shape from ${file.name}`);
    });
    reader.readAsText(file);
  });
  input.click();
}

/** The badge under the frame. `withWarning` is skipped mid-drag — the size is still changing. */
function exportAreaLabel(withWarning: boolean): string {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  const warning = withWarning ? exportGpuWarning(width, height) : undefined;
  return (
    `EXPORT AREA · ${width} × ${height} · ${aspectRatioLabel(width, height)}` +
    (warning ? ` · ⚠ ${warning.short.toUpperCase()}` : "")
  );
}

/**
 * Point the preview frame at the export aspect and label it.
 *
 * The renderer is NOT given a fixed output size here — the preview stays at its own device
 * resolution, and `setOutputSize` is reserved for captures. What changes is the SHAPE of the frame,
 * which is what `camera.fit` reconciles the composition against.
 */
/**
 * Size the preview frame: the export box, either fitted to the stage or at its true pixel size.
 *
 * The fit is computed here rather than left to CSS because CSS cannot express it. `aspect-ratio`
 * needs one axis to be indefinite to derive the other, so `inline-size: 100%` makes width win and
 * a `max-block-size` clamp then truncates the height WITHOUT giving the width back — the frame
 * silently keeps the stage's own proportions. Every export aspect other than one already close to
 * the stage's came out wrong: 1:1, 4:5 and 9:16 all rendered as the same 1.17 letterbox, so
 * choosing a portrait size changed the exported file and the label but not the thing you were
 * composing against.
 */
function refitPreview(): void {
  stage.classList.toggle("actual-size", view.actualSize);
  if (view.actualSize) {
    // One export pixel per CSS pixel — the same "100%" a design tool means, and NOT one export
    // pixel per device pixel. On a 2× display the preview is still rendered at devicePixelRatio,
    // so this shows the export at its true SIZE while remaining sharper than the file will be;
    // sizing to device pixels instead would halve the frame and mean nothing to anyone composing.
    scene.style.setProperty("inline-size", `${Math.round(size.width)}px`);
    scene.style.setProperty("block-size", `${Math.round(size.height)}px`);
  } else {
    // The largest box of the export's aspect that fits inside the stage's content area.
    const box = stage.getBoundingClientRect();
    const pad = getComputedStyle(stage);
    const availWidth =
      box.width - Number.parseFloat(pad.paddingLeft) - Number.parseFloat(pad.paddingRight);
    const availHeight =
      box.height - Number.parseFloat(pad.paddingTop) - Number.parseFloat(pad.paddingBottom);
    if (availWidth > 0 && availHeight > 0) {
      const scale = Math.min(availWidth / size.width, availHeight / size.height);
      scene.style.setProperty("inline-size", `${Math.floor(size.width * scale)}px`);
      scene.style.setProperty("block-size", `${Math.floor(size.height * scale)}px`);
    }
  }
  scene.style.setProperty(
    "--capture-aspect",
    `${Math.round(size.width)} / ${Math.round(size.height)}`,
  );
  captureSize.textContent = exportAreaLabel(true);
}

function toggleRecord(): void {
  if (recording) {
    recording.stop();
    return;
  }
  // Record at the chosen output size, not the preview's: both paths read the backing buffer, so
  // pinning it is what makes "1920 × 1080" actually mean 1920 × 1080.
  renderer.setOutputSize({ width: size.width, height: size.height });

  if (isFrameWalked(state.videoFormat)) {
    // Stepped rather than recorded: deterministic, and the only paths that can carry alpha (WebP)
    // or produce a GIF at all.
    state.recording = true;
    state.recordProgress = 0;
    panel.syncRecordButton();
    recordingOverlay.start();
    const walk = {
      seconds: state.recordSeconds,
      fps: state.recordFps,
      quality: state.imageQuality,
      onProgress: (fraction: number) => {
        state.recordProgress = fraction;
        panel.syncRecordButton();
      },
    };
    const run =
      state.videoFormat === "gif"
        ? recordGif(renderer, walk, exportName())
        : recordAnimatedWebp(renderer, walk, exportName());
    void run
      .then(
        (frames) => toast(`Saved ${frames} frames`),
        (error: Error) => toast(error.message),
      )
      .finally(() => {
        state.recording = false;
        state.recordProgress = 0;
        panel.syncRecordButton();
        recordingOverlay.stop();
        renderer.setOutputSize(undefined);
      });
    return;
  }

  let started: Recording;
  try {
    started = startRecording(renderer, state.videoFormat, state.recordSeconds, exportName());
  } catch (error) {
    renderer.setOutputSize(undefined);
    toast((error as Error).message);
    return;
  }
  recording = started;
  state.recording = true;
  panel.syncRecordButton();
  recordingOverlay.start();
  toast(`Recording ${state.recordSeconds}s…`);
  void started.done
    .then(
      (ext) => toast(`Saved .${ext}`),
      (error: Error) => toast(error.message),
    )
    .finally(() => {
      recording = null;
      state.recording = false;
      panel.syncRecordButton();
      recordingOverlay.stop();
      renderer.setOutputSize(undefined);
    });
}

/**
 * (Re)build the overlays that hold a direct reference to the renderer.
 *
 * Extracted because switching engines replaces the renderer object, and these two captured the old
 * one at construction — everything else reaches it through the module-level binding and follows a
 * reassignment on its own.
 */
function buildRendererOverlays(): void {
  scrollTest?.dispose();
  selection?.dispose();
  scrollTest = new ScrollTestOverlay(scene, renderer);
  selection = new SelectionOverlay(scene, renderer, {
    onEditStart: () => history.flush(),
    onTransform: (item) => {
      syncItemTransform(item);
      // The panel binds to the config, and a gesture changes it from outside Tweakpane, so the
      // rows need re-reading — but THROTTLED. A full pane refresh walks every binding and, through
      // the pane's change handler, triggers a uniform push and a render; doing that once per
      // pointer event made a drag stutter and could wedge the page outright. Ten times a second is
      // indistinguishable while dragging, and onEditEnd guarantees the final value lands.
      const now = performance.now();
      if (now - lastPanelSync < 100) return;
      lastPanelSync = now;
      panel.refresh();
    },
    onEditEnd: (label) => {
      panel.refresh(); // the throttle may have skipped the last move
      history.commit(config(), presetName, label);
    },
    onSelect: (items) => {
      // The panel follows the PRIMARY selection — the last one added. Revealing every member at
      // once would scroll the pane somewhere arbitrary and expand a dozen folders.
      const primary = items[items.length - 1] ?? null;
      panel.setSelectionCount(items.length);
      panel.focusItem(primary?.config ? renderer.getItems().indexOf(primary) : null);
    },
    prepareSelection: ensureSelectable,
    onDelete: removeItems,
    onGroup: (items) => regroup(items, "group"),
    onUngroup: (items) => regroup(items, "ungroup"),
    groupName: (id) => {
      const group = config().groups.find((g) => g.id === id);
      return group ? groupLabel(config(), group) : id;
    },
  });
}

/**
 * Swap the live engine, keeping the scene exactly as it is.
 *
 * The node engine is fetched on demand rather than imported at the top: it is a second three build
 * and the studio should not carry it for everyone who never switches. That is the same reason
 * `createMaterials` splits on a literal specifier — see `core-loader-webgpu`.
 *
 * The config object survives the swap. It is the studio's single source of truth and the new
 * renderer normalizes the same object, so the panel keeps binding to what it was already bound to.
 */
async function useRenderer(kind: RendererKind): Promise<void> {
  if (kind === rendererKind) return;
  const live = config();
  const wasPaused = live.paused;

  renderer.stop();
  renderer.dispose();

  if (kind === "webgpu") {
    const { NodeMaterialRenderer } = await import("@materials3d/core/renderer-webgpu");
    // The same nominal gap `core-loader-webgpu` bridges: both classes implement `Engine`, and the
    // compiler checks that, but they share no base type so it cannot see the match here.
    renderer = new NodeMaterialRenderer(scene, live, {
      respectReducedMotion: false,
    }) as unknown as MaterialRenderer;
  } else {
    renderer = new MaterialRenderer(scene, live, { respectReducedMotion: false });
  }
  rendererKind = kind;
  state.renderer = kind;

  renderer.start();
  buildRendererOverlays();
  // Re-point the panel at the NEW renderer's config object — same values, different identity.
  panel.setConfig(config(), presetName);
  if (wasPaused) renderer.renderOnce();
}

// ------------------------------------------------------------------- boot ---

function boot(): void {
  // A shared link wins over the default preset — someone opening it wants that scene, not ours.
  const shared = fromLocationHash();
  const initial = shared ?? PRESETS[presetName]();
  if (shared) presetName = "custom";

  renderer = new MaterialRenderer(scene, initial, { respectReducedMotion: false });
  renderer.start();

  history = new History({
    getLive: () => config(),
    getPresetName: () => presetName,
    onChange: () => historyControls?.update(history.getState()),
  });

  panel = new ControlPanel(byId("pane"), config(), presetName, state, view, size, {
    onChange: applyChange,
    onExportImage: exportImage,
    onToggleRecord: toggleRecord,
    onExportEmbed: () =>
      void exportEmbedHtml(config(), exportName()).then(
        () => toast("Embed saved"),
        (error: Error) => toast(error.message),
      ),
    onExportCode: () => void openDialog("code"),
    onEditConfig: () => void openDialog("json"),
    // No toast: the panel flashes ✓ on the button itself. Returning false would flash ✕.
    onSaveConfig: () => {
      saveConfig(config(), exportName());
    },
    onLoadConfig: () => {
      fileInput.value = "";
      fileInput.click();
    },
    // Resolving false makes the button flash ✕ — a refused clipboard write doesn't throw.
    onShare: () => copy(toShareUrl(minimalConfig(config()))),
    onShuffle: shuffleLampField,
    onRandomizeAll: () => {
      history.flush();
      randomizeConfig(config());
      panel.setConfig(config(), presetName);
      // Structural: the scatter's seed and count changed, so the geometry has to be rebuilt.
      applyChange(true);
      history.commit(config(), presetName, "randomize scene");
      toast("New scene");
    },
    onReset: () => {
      const name = presetName in PRESETS ? presetName : "skewer";
      adopt(PRESETS[name](), name, true, `reset · ${presetLabel(name)}`);
    },
    onResetCamera: () => renderer.resetCamera(),
    onTransparencyChange: syncTransparency,
    onSelectPreset: (name) => adopt(PRESETS[name](), name, true, presetLabel(name)),
    onViewChanged: () =>
      grid.set(view.grid, {
        divisions: view.gridDivisions,
        centre: view.gridCentre,
        tilt: view.gridTilt,
      }),
    onOutputSizeChange: refitPreview,
    onPickBackgroundMedia: pickBackgroundMedia,
    onPickOutline: pickOutlineSvg,
    onScrollPreview: (value) => renderer.setScrollPreview(value),
    onOpenScrollTest: () => scrollTest.toggle(),
    onRendererChange: (kind) =>
      useRenderer(kind).catch((error: Error) => {
        // Put the control back where the engine actually is, or the panel claims a switch that
        // did not happen — the second engine is fetched over the network and can fail to arrive.
        state.renderer = rendererKind;
        panel.refresh();
        toast(`Could not switch engine: ${error.message}`);
      }),
    onExportWallpaper: () => exportWallpaperFolder(config(), exportName(), renderer),
    onPublish: () => publishToGallery(config()),
    onLocateItem: (index) => selection.select(renderer.getItems()[index] ?? null),
    onBakeForEdit: (index) => {
      // ensureSelectable() rebuilds the panel, so focus the shape after it — the folder the user
      // just opened only exists on the far side of the bake.
      ensureSelectable();
      panel.focusItem(index);
      selection.select(renderer.getItems()[index] ?? null);
    },
    onRenamed: (label) => history.commit(config(), presetName, label),
    onGroup: () => regroup(selection.items, "group"),
    // No id means "whatever the viewport has selected" — the button inside the selection editor.
    onUngroup: (id) =>
      regroup(
        id ? renderer.getItems().filter((item) => item.config?.group === id) : selection.items,
        "ungroup",
      ),
    onLocateGroup: (id) =>
      selection.setSelection(renderer.getItems().filter((item) => item.config?.group === id)),
    onRemoveShapes: removeConfigs,
    // The overlay holds MaterialItems; the panel edits ItemConfigs. `item.config` is the very same
    // object the panel binds to (the identity contract in buildItems), so this is a lookup, not a
    // copy — a bulk edit through it lands on the rows the user is looking at.
    selectedConfigs: () =>
      selection.items.map((item) => item.config).filter((c): c is ItemConfig => Boolean(c)),
    onShapesChanged: (label) => {
      // Adding to a generated scene means authoring it, so bake first — otherwise the new shape
      // would be wiped by the next regeneration from the scatter.
      ensureSelectable();
      history.flush();
      renderer.rebuild();
      history.commit(config(), presetName, label);
    },
  });
  panel.bindSearch(byId<HTMLInputElement>("control-search-input"));

  syncTransparency(config().transparentBackground);

  historyControls = new HistoryControls(byId("history-slot"), {
    onUndo: doUndo,
    onRedo: doRedo,
    onJump: doJump,
    // Wipe the timeline back to one baseline; the live scene stays. Reversible for as long as the
    // toast is up, because clearing history you meant to keep is unrecoverable otherwise.
    onClear: () => {
      history.clear(config(), presetName);
      toast("History cleared — press U to undo that", 4000);
    },
    thumb: new HistoryThumbnailer((id) => history.getConfigById(id)),
  });
  history.reset(config(), presetName, presetLabel(presetName));
  refitPreview();
  // The fit is computed, so the stage growing or shrinking no longer re-derives it for free.
  new ResizeObserver(() => refitPreview()).observe(stage);

  // Corner-drag the export frame. The renderer is only told about the new size on release —
  // dragging just reshapes the DOM frame, which is cheap.
  // Lives for the page's lifetime; its listeners are on elements that do too.
  void new OutputResizeHandle(
    byId("stage"),
    scene,
    [...scene.querySelectorAll<HTMLButtonElement>(".output-resize-handle")],
    size,
    {
      // The frame's corners sit on top of the canvas, so a resize and a marquee are the same
      // sweep over the same pixels: the overlay stands down for the length of the gesture, and
      // the selection goes with it — its box is projected from the camera the commit refits.
      onDragStart: () => {
        selection.setInteractive(false);
        selection.select(null);
      },
      onPreviewChange: () => {
        // Label only — the frame is already following the pointer via inline styles.
        captureSize.textContent = exportAreaLabel(false);
      },
      onCommit: (refit) => {
        // First, so a failure in the resize below cannot strand the stage with gestures off.
        selection.setInteractive(true);
        if (refit) refitPreview();
        panel.syncOutputSize();
        renderer.resize();
      },
    },
  );

  // The margin around the export frame is still the canvas as far as anyone is concerned, so
  // pressing there clears the selection exactly as pressing empty space inside the frame does.
  // Bound to #stage rather than the document: the panel and the dialog are its siblings, so
  // reaching for a knob can never deselect what the knob is about to edit.
  on(byId("stage"), "pointerdown", (event) => {
    if (!scene.contains(event.target as Node)) selection.select(null);
  });

  historyControls.addHelp([
    { icon: GESTURE_ICONS.left, text: "Double-click a shape to select" },
    { icon: GESTURE_ICONS.left, text: "Drag empty space to marquee" },
    { icon: GESTURE_ICONS.key, text: "Shift-click to add to the selection" },
    { icon: GESTURE_ICONS.key, text: "⌘G groups · ⌘⇧G ungroups" },
    { icon: GESTURE_ICONS.key, text: "Alt-click to drill into a group" },
    { icon: GESTURE_ICONS.key, text: "Delete removes the selection" },
    { icon: GESTURE_ICONS.left, text: "Drag to move · Shift for depth" },
    { icon: GESTURE_ICONS.right, text: "Drag to rotate · Shift to roll" },
    { icon: GESTURE_ICONS.handles, text: "Corner handles to scale" },
    { icon: GESTURE_ICONS.right, text: "Right-drag empty space to orbit" },
    { icon: GESTURE_ICONS.wheel, text: "Wheel zooms" },
    { icon: GESTURE_ICONS.key, text: "Esc to deselect" },
  ]);

  // Preset thumbnails are real renders, generated after first paint so they never delay startup.
  void generatePresetThumbs(PRESETS, () => panel.refreshPresetThumbs());

  grid = new GridOverlay(scene);
  recordingOverlay = new RecordingOverlay(scene);
  buildRendererOverlays();

  on(dialog, "click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset
      .action;
    if (action === "dialog-copy") {
      void copy(editor?.value ?? "").then((ok) => toast(ok ? "Copied" : "Could not copy"));
    } else if (action === "dialog-apply") {
      applyJson();
    } else if (action === "dialog-save") {
      saveConfig(config(), exportName());
      toast("Config saved");
    } else if (action === "dialog-embed") {
      void exportEmbedHtml(config(), exportName()).then(
        () => toast("Embed saved"),
        (error: Error) => toast(error.message),
      );
    }
  });

  on(fileInput, "change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then(
      (text) => {
        try {
          adopt(JSON.parse(text) as Partial<SceneConfig>, "custom", true, file.name);
          toast(`Loaded ${file.name}`);
        } catch (error) {
          toast(`Invalid config: ${(error as Error).message}`);
        }
      },
      () => toast("Could not read that file"),
    );
  });

  // Undo/redo. Registered separately from the plain shortcuts below because it is the one binding
  // that WANTS the modifier, and it must not fire while the user is typing in a field — the
  // browser's own text undo wins there.
  on(window, "keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    // Not while the modal is up: undoing the scene behind it would leave the dialog showing (and
    // on Apply, re-applying) a config the undo just replaced.
    if (dialog.open) return;
    const target = event.target as HTMLElement | null;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) {
      return;
    }
    event.preventDefault();
    if (key === "y" || event.shiftKey) doRedo();
    else doUndo();
  });

  // End-of-gesture commit: flush a pending edit when a drag releases, so one gesture is one entry
  // rather than one per frame. The microtask defers past Tweakpane's own pointerup handling, so we
  // snapshot the value it settles on.
  const flushOnRelease = (): void => {
    if (history.isDirty()) queueMicrotask(() => history.flush());
  };
  on(window, "pointerup", flushOnRelease);
  on(window, "pointercancel", flushOnRelease);

  // Keyboard: S saves a still, C opens the code dialog, J the config editor, R re-rolls the lamps,
  // U takes back a history clear.
  on(document, "keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || dialog.open) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
      return;
    }
    if (event.key === "s") exportImage();
    else if (event.key === "c") void openDialog("code");
    else if (event.key === "j") void openDialog("json");
    else if (event.key === "r") shuffleLampField();
    else if (event.key === "u") {
      if (history.undoClear()) toast("History restored");
    }
  });
}

boot();
