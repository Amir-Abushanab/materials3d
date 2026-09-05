// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ensureSceneConfig, type SceneConfig } from "@materials3d/core";
import { History } from "./history";

/** A big enough payload that the store holds it out of line rather than inside every clone. */
const PICKED = `data:model/gltf-binary;base64,${"A".repeat(4000)}`;

function scene(model: string, r: number): SceneConfig {
  return ensureSceneConfig({
    items: [{ shape: { kind: "model", model, r } }],
  } as unknown as Partial<SceneConfig>);
}

function history(live: () => SceneConfig): History {
  return new History({ getLive: live, getPresetName: () => "test", onChange: () => {} });
}

describe("a picked model through the timeline", () => {
  it("comes back intact after an undo", () => {
    let live = scene(PICKED, 2);
    const h = history(() => live);
    h.reset(live, "test");
    live = scene(PICKED, 3);
    h.commit(live, "test", "resize");
    expect(h.undo()?.config.items[0].shape.model).toBe(PICKED);
  });

  it("leaves the live config alone on the way in", () => {
    // The store swaps the payload for a short reference; doing that to the caller's own object
    // would break the scene the moment anything was committed.
    const live = scene(PICKED, 2);
    const h = history(() => live);
    h.reset(live, "test");
    h.commit(live, "test", "edit");
    expect(live.items[0].shape.model).toBe(PICKED);
  });

  it("holds one copy however many versions name it", () => {
    // The reason this exists: eighty entries each deep-cloning a multi-megabyte data URI is what
    // an undo timeline must never do.
    let live = scene(PICKED, 1);
    const h = history(() => live);
    h.reset(live, "test");
    for (let i = 2; i < 12; i++) {
      live = scene(PICKED, i);
      h.commit(live, "test", `resize ${i}`);
    }
    const entry = h.getConfigById(h.getState().entries[4].id);
    expect(entry?.items[0].shape.model).toBe(PICKED);
    // Every stored entry carries the reference, not the payload, so the timeline stays small.
    const stored = JSON.stringify(h.getState());
    expect(stored).not.toContain("AAAA");
  });

  it("keeps a hosted url inline, since a short string costs nothing", () => {
    const live = scene("/hero.glb", 2);
    const h = history(() => live);
    h.reset(live, "test");
    expect(h.getConfigById(h.getState().entries[0].id)?.items[0].shape.model).toBe("/hero.glb");
  });
});
