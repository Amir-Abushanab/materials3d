// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ensureSceneConfig, type SceneConfig } from "@materials3d/core";
import { toShareUrl } from "./share";

/** A one-shape scene whose shape names `model`. */
function sceneWith(model: string): SceneConfig {
  return ensureSceneConfig({
    items: [{ shape: { kind: "model", model, r: 2 } }],
  } as unknown as Partial<SceneConfig>);
}

const DATA_URI = `data:model/gltf-binary;base64,${"A".repeat(400)}`;

describe("share links carrying a model", () => {
  it("keeps a hosted url, which travels fine", () => {
    const link = toShareUrl(sceneWith("/hero.glb"));
    expect(link?.strippedMedia).toBe(false);
    expect(decodeURIComponent(link?.url ?? "")).toBeTruthy();
    // The url survives into the payload, so the link opens the real scene.
    const encoded = /#c=(.+)$/.exec(link?.url ?? "")?.[1] ?? "";
    const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    expect(json).toContain("/hero.glb");
  });

  it("drops a picked file, and says so", () => {
    const link = toShareUrl(sceneWith(DATA_URI));
    expect(link?.strippedMedia).toBe(true);
    expect(link?.url).not.toContain("Z2x0Zi1iaW5hcnk");
  });

  it("leaves the shape in place when it drops the file", () => {
    // The point of stripping rather than deleting the item: the link still opens a scene with the
    // shape where it belongs, drawing the placeholder, which reads as "point this at your file".
    const link = toShareUrl(sceneWith(DATA_URI));
    const encoded = /#c=(.+)$/.exec(link?.url ?? "")?.[1] ?? "";
    const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    expect(json).toContain('"kind":"model"');
  });

  it("does not strip the model out of the caller's own config", () => {
    // The regression this guards: `toShareUrl` used to take a shallow copy, so deleting a field on
    // a shape several levels down reached through to the live scene. Asking for a share link would
    // have erased the file you just picked.
    const config = sceneWith(DATA_URI);
    toShareUrl(config);
    expect(config.items[0].shape.model).toBe(DATA_URI);
  });
});
