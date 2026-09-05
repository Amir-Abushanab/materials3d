// @vitest-environment jsdom
/**
 * Drift audit for the control panel's config bindings.
 *
 * Tweakpane picks a controller from the VALUE it is handed and throws
 * `No matching controller for '<key>'` for anything it has no widget for, notably `undefined`.
 * So every config field the panel binds has to be backfilled by @materials3d/core's normalizers, and a
 * field added to the panel without a matching backfill takes the whole panel down. An optional
 * field in the type that only `createDefaultConfig` sets looks fine until someone loads a config
 * that predates it.
 *
 * Rather than restate the field list here, which would drift immediately, this reads the real
 * `addBinding` call sites out of ControlPanel.ts, normalizes the most minimal config a hand-edit
 * can produce, and asks Tweakpane to bind each one for real.
 */
import { describe, expect, it } from "vitest";
import { Pane } from "tweakpane";
import { ensureSceneConfig, type SceneConfig } from "@materials3d/core";
import { backfillMaterial } from "./ControlPanel";
// Vite's `?raw` rather than node:fs: it keeps the audit pinned to the real source file, so a
// rename breaks the import instead of silently matching nothing.
import SOURCE from "./ControlPanel.ts?raw";

/** Receivers backed by the document config: the ones the normalizers are responsible for. */
const CONFIG_RECEIVERS: Record<string, (c: SceneConfig) => unknown> = {
  "this.config": (c) => c,
  "this.config.camera": (c) => c.camera,
  "this.config.camera.lookAt": (c) => c.camera.lookAt,
  "this.config.post": (c) => c.post,
  "this.config.plate": (c) => c.plate,
  "this.config.plate.scale": (c) => c.plate.scale,
  "this.config.plate.offset": (c) => c.plate.offset,
  "this.config.lampGate": (c) => c.lampGate,
  "this.config.backgroundImagePosition": (c) => c.backgroundImagePosition,
  lamp: (c) => c.lamps[0],
  item: (c) => c.items[0],
  "item.shape": (c) => c.items[0].shape,
  // A carve-out is element-level like a lamp, so `minimalConfig` seeds one from `{}`, which
  // also pins down that a cut with no fields at all normalizes into a bindable one.
  cut: (c) => c.items[0].shape.cuts?.[0],
  // The one receiver the normalizers deliberately DON'T make concrete: an item's material is a
  // sparse override set, so the panel backfills it before binding. Auditing it therefore means
  // auditing that backfill, which is the real invariant here, and why it is a shared helper
  // rather than a literal inside the panel.
  material: (c) => backfillMaterial(c.items[0].material),
  motion: (c) => c.items[0].motion,
  scatter: (c) => c.scatter,
  // Optional on the config, so `minimalConfig` seeds one from `{}`, which also pins down that a
  // beam with no fields at all normalizes into a bindable one. `entryAngle` and `entrySweep` stay
  // absent by design (0 is a real bearing), so the panel guards those two inline.
  beam: (c) => c.beam,
  "scatter.shape": (c) => c.scatter?.shape,
  "scatter.position": (c) => c.scatter?.position,
  stop: (c) => c.backgroundPalette[0],
  point: (c) => c.backgroundMeshPoints[0],
};

/**
 * Receivers that are panel-local UI state rather than document config: the export size, the
 * grid-overlay toggles, the recording/format state, and the derived "phase spread in turns" proxy.
 * These are always constructed with concrete values, so the normalizers have no say over them.
 */
const UI_STATE_RECEIVERS = new Set([
  "size",
  "this.state",
  "this.view",
  "turns",
  "pick",
  "palette",
  "label",
  // Interaction authoring: the shared-input proxies and the reaction slots are panel-local models,
  // serialized into config.interaction / item.interaction / lamp.bindings by their sync functions.
  "uiInputs",
  "slot",
  // The `model` field's display value. A picked `.glb` lives in the config as a megabyte of
  // base64, so the field binds a stand-in string and writes back only what someone types.
  "modelField",
]);

const BINDING_RE = /addBinding\(\s*([A-Za-z_][\w.]*)\s*,\s*["'](\w+)["']/g;

/**
 * Every UNCONDITIONAL `addBinding(receiver, "key")` in the panel, grouped by receiver.
 *
 * Bindings guarded by an `if` on the same line are skipped on purpose: a couple of fields
 * (`material.path`, `material.tint`) are genuinely optional overrides that the panel only shows
 * when the shape carries them, so requiring the normalizers to backfill those would be asking for
 * the wrong thing. Everything else must survive normalization.
 */
function parseBindings(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of SOURCE.split("\n")) {
    for (const match of line.matchAll(BINDING_RE)) {
      const guard = line.indexOf("if (");
      if (guard !== -1 && guard < (match.index ?? 0)) continue;
      const keys = out.get(match[1]) ?? new Set<string>();
      keys.add(match[2]);
      out.set(match[1], keys);
    }
  }
  return out;
}

/**
 * The most minimal config a hand-edit can produce, with one shape and one lamp so the
 * element-level bindings are covered too. Everything else has to come from the normalizers,
 * which is the point.
 */
function minimalConfig(): SceneConfig {
  return ensureSceneConfig({
    items: [{ shape: { cuts: [{}] } }],
    lamps: [{}],
    scatter: {},
    beam: {},
  } as unknown as Partial<SceneConfig>);
}

describe("every config field the panel binds survives normalization", () => {
  it("finds the binding call sites (guards against the regex silently matching nothing)", () => {
    const bindings = parseBindings();
    expect(bindings.get("this.config")?.size ?? 0).toBeGreaterThan(10);
    expect(bindings.get("this.config.post")?.size ?? 0).toBeGreaterThan(15);
  });

  it("classifies every binding receiver, so a new one can't go unaudited", () => {
    const unknown = [...parseBindings().keys()].filter(
      (receiver) => !(receiver in CONFIG_RECEIVERS) && !UI_STATE_RECEIVERS.has(receiver),
    );
    expect(
      unknown,
      "new addBinding receiver(s): add each to CONFIG_RECEIVERS (if it is document config, so its " +
        "fields get audited) or to UI_STATE_RECEIVERS (if it is panel-local state)",
    ).toEqual([]);
  });

  it("lets Tweakpane bind every one of them", () => {
    const config = minimalConfig();
    // Some Tweakpane widgets paint to a canvas, which jsdom doesn't implement; the binding itself
    // is what's under test, so stub it rather than let the warnings bury a real failure.
    HTMLCanvasElement.prototype.getContext = () => null;
    const pane = new Pane();
    const failures: string[] = [];
    try {
      for (const [receiver, keys] of parseBindings()) {
        if (!(receiver in CONFIG_RECEIVERS)) continue; // UI state: covered by the test above
        const target = CONFIG_RECEIVERS[receiver](config);
        if (target === null || typeof target !== "object") {
          failures.push(`${receiver} is ${String(target)}, not an object`);
          continue;
        }
        for (const key of keys) {
          try {
            pane.addBinding(target as Record<string, unknown>, key);
          } catch (error) {
            failures.push(
              `${receiver}.${key}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } finally {
      pane.dispose();
    }
    expect(failures, "field(s) the normalizers left in a state the panel can't bind").toEqual([]);
  });
});
