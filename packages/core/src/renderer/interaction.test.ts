import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultConfig,
  createItem,
  createLamp,
  ensureSceneConfig,
  type ItemInteractionBinding,
  type SceneConfig,
  type SceneInteractionBinding,
} from "../config/model";
import {
  InteractionController,
  interactionActive,
  ITEM_APPLIERS,
  SCENE_APPLIERS,
} from "./interaction";
import { expandScatter } from "./shared";

/**
 * A stand-in container: records the controller's listeners so a test can feed synthetic pointer
 * events, and reports a fixed 100x100 box so client coords map to NDC predictably. No DOM: the
 * controller's browser-only paths (computeScroll, the window release watch) guard on
 * `typeof window`.
 */
function stubContainer() {
  const listeners = new Map<string, (e: unknown) => void>();
  const counts = { added: 0, removed: 0 };
  const el = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      counts.added++;
      listeners.set(type, fn);
    },
    removeEventListener: (type: string) => {
      if (listeners.delete(type)) counts.removed++;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  } as unknown as HTMLElement;
  const fire = (type: string, e: Record<string, unknown> = {}): void => {
    listeners.get(type)?.({ pointerType: "mouse", clientX: 50, clientY: 50, ...e });
  };
  return { el, fire, listeners, counts };
}

/** A stand-in window, for the release listeners the controller adds while a press is held. */
function stubWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const counts = { added: 0, removed: 0 };
  const win = {
    innerHeight: 800,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      counts.added++;
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (listeners.get(type)?.delete(fn)) counts.removed++;
    },
  };
  const fire = (type: string, e: Record<string, unknown> = {}): void => {
    for (const fn of listeners.get(type) ?? []) fn({ pointerType: "mouse", ...e });
  };
  return { win, fire, counts };
}

/** Advance the controller far enough that every exponential lag has effectively converged. */
function converge(ic: InteractionController, steps = 240): void {
  for (let i = 0; i < steps; i++) ic.update(1 / 60);
}

function sceneWith(bindings: SceneInteractionBinding[]): SceneConfig {
  const config = createDefaultConfig();
  config.interaction = { bindings };
  return config;
}

describe("interactionActive", () => {
  it("is off for a default scene, on when any binding list exists", () => {
    const config = createDefaultConfig();
    expect(interactionActive(config)).toBe(false);
    expect(interactionActive(sceneWith([{ source: "hover", target: "bloom", to: 0.2 }]))).toBe(
      true,
    );

    const lampScene = createDefaultConfig();
    lampScene.lamps[0].bindings = [{ source: "pointerX", target: "x", to: 0.9 }];
    expect(interactionActive(lampScene)).toBe(true);

    const itemScene = createDefaultConfig();
    itemScene.scatter = undefined;
    const item = createItem();
    item.interaction = { bindings: [{ source: "press", target: "emission", to: 0.5 }] };
    itemScene.items = [item];
    expect(interactionActive(itemScene)).toBe(true);
  });

  it("honours the master switch over any binding", () => {
    const config = sceneWith([{ source: "hover", target: "bloom", to: 0.2 }]);
    config.interaction!.enabled = false;
    expect(interactionActive(config)).toBe(false);
  });

  it("turns on for a scatter carrying shared reactions", () => {
    const config = createDefaultConfig();
    expect(interactionActive(config)).toBe(false);
    config.scatter!.interaction = {
      bindings: [{ source: "hoverSelf", target: "hueShift", to: 0.4 }],
    };
    expect(interactionActive(config)).toBe(true);
  });
});

describe("InteractionController sources", () => {
  it("ramps hover toward 1 on enter and back on leave", () => {
    const { el, fire } = stubContainer();
    const binding: SceneInteractionBinding = { source: "hover", target: "bloom", to: 1 };
    const config = sceneWith([binding]);
    const ic = new InteractionController(el, () => config);

    fire("pointerenter");
    converge(ic);
    expect(ic.bindingValue(binding)).toBeGreaterThan(0.98);

    fire("pointerleave");
    converge(ic);
    expect(ic.bindingValue(binding)).toBeLessThan(0.02);
    ic.dispose();
  });

  it("maps pointer position to 0..1 pointerX/pointerY", () => {
    const { el, fire } = stubContainer();
    const bx: SceneInteractionBinding = { source: "pointerX", target: "bloom", to: 1 };
    const by: SceneInteractionBinding = { source: "pointerY", target: "grain", to: 1 };
    const config = sceneWith([bx, by]);
    const ic = new InteractionController(el, () => config);

    fire("pointermove", { clientX: 100, clientY: 0 }); // right edge, top edge
    converge(ic);
    expect(ic.bindingValue(bx)).toBeCloseTo(1, 1);
    expect(ic.bindingValue(by)).toBeCloseTo(1, 1); // y flips: top of the box is 1
    ic.dispose();
  });

  it("ignores touch unless the scene opts in", () => {
    const { el, fire } = stubContainer();
    const binding: SceneInteractionBinding = { source: "press", target: "bloom", to: 1 };
    const config = sceneWith([binding]);
    const ic = new InteractionController(el, () => config);

    fire("pointerdown", { pointerType: "touch" });
    converge(ic);
    expect(ic.bindingValue(binding)).toBe(0);

    config.interaction!.touch = true;
    fire("pointerdown", { pointerType: "touch" });
    converge(ic);
    expect(ic.bindingValue(binding)).toBeGreaterThan(0.98);
    ic.dispose();
  });

  it("latches appear on the first update and ramps the binding from 0", () => {
    const { el } = stubContainer();
    const binding: SceneInteractionBinding = { source: "appear", target: "bloom", to: 1 };
    const config = sceneWith([binding]);
    const ic = new InteractionController(el, () => config);

    ic.update(1 / 60);
    const early = ic.bindingValue(binding);
    expect(early).toBeGreaterThan(0); // ramping…
    expect(early).toBeLessThan(0.5); // …but from 0, not snapped
    converge(ic);
    expect(ic.bindingValue(binding)).toBeGreaterThan(0.98);
    ic.dispose();
  });

  it("feeds custom inputs by name", () => {
    const { el } = stubContainer();
    const binding: SceneInteractionBinding = { source: "custom:beat", target: "bloom", to: 1 };
    const config = sceneWith([binding]);
    const ic = new InteractionController(el, () => config);

    ic.setInput("beat", 0.75);
    converge(ic);
    expect(ic.bindingValue(binding)).toBeCloseTo(0.75, 2);
    ic.dispose();
  });

  it("resolves hoverSelf per item from the reported hit, not shared presence", () => {
    const { el, fire } = stubContainer();
    const config = createDefaultConfig();
    config.scatter = undefined;
    const a = createItem();
    a.interaction = { bindings: [{ source: "hoverSelf", target: "emission", to: 1 }] };
    const b = createItem();
    b.interaction = { bindings: [{ source: "hoverSelf", target: "emission", to: 1 }] };
    config.items = [a, b];
    const ic = new InteractionController(el, () => config);

    fire("pointerenter"); // shared presence is up, but no shape is hit yet
    ic.setHoverItem(null);
    converge(ic);
    expect(ic.bindingValue(a.interaction.bindings![0])).toBe(0);

    ic.setHoverItem(1); // the cursor lands on shape B only
    converge(ic);
    expect(ic.bindingValue(a.interaction.bindings![0])).toBeLessThan(0.02);
    expect(ic.bindingValue(b.interaction.bindings![0])).toBeGreaterThan(0.98);

    ic.settle(); // settled = no shape under the cursor
    expect(ic.bindingValue(b.interaction.bindings![0])).toBe(0);
    ic.dispose();
  });

  it("advances bindings on a renderer-supplied resolved list, so scatter shapes answer hoverSelf", () => {
    const { el, fire } = stubContainer();
    const config = createDefaultConfig();
    config.scatter!.interaction = {
      bindings: [{ source: "hoverSelf", target: "hueShift", to: 0.4 }],
    };
    // What the renderer does: expand once, build meshes from it, and hand the controller that
    // exact list, the generated shapes never appear in config.items.
    const resolved = expandScatter(config.scatter!);
    const ic = new InteractionController(
      el,
      () => config,
      () => resolved,
    );

    fire("pointerenter");
    ic.setHoverItem(2); // the raycast lands on the third rod
    converge(ic);
    expect(ic.bindingValue(resolved[2].interaction!.bindings![0])).toBeGreaterThan(0.98);
    expect(ic.bindingValue(resolved[3].interaction!.bindings![0])).toBeLessThan(0.02);

    ic.settle(); // the settled frame eases every rod back to the authored colour
    expect(ic.bindingValue(resolved[2].interaction!.bindings![0])).toBe(0);
    ic.dispose();
  });

  it("latches pressSelf to the shape the press began on, and rides the press envelope", () => {
    const { el, fire } = stubContainer();
    const config = createDefaultConfig();
    config.scatter = undefined;
    const a = createItem();
    a.interaction = { bindings: [{ source: "pressSelf", target: "emission", to: 1 }] };
    const b = createItem();
    b.interaction = { bindings: [{ source: "pressSelf", target: "emission", to: 1 }] };
    config.items = [a, b];
    const ic = new InteractionController(el, () => config);

    fire("pointerdown");
    expect(ic.pendingPress()).not.toBeNull(); // the down waits for the renderer's hit test
    ic.setPressItem(0); // …which resolves it to shape A
    expect(ic.pendingPress()).toBeNull(); // consumed, each down is tested once
    converge(ic);
    expect(ic.bindingValue(a.interaction.bindings![0])).toBeGreaterThan(0.98);
    expect(ic.bindingValue(b.interaction.bindings![0])).toBe(0);

    fire("pointerup"); // release: the shared press envelope eases everything back
    converge(ic);
    expect(ic.bindingValue(a.interaction.bindings![0])).toBeLessThan(0.02);

    fire("pointerdown"); // a new down on empty space replaces the latch
    ic.setPressItem(null);
    converge(ic);
    expect(ic.bindingValue(a.interaction.bindings![0])).toBeLessThan(0.001);
    ic.dispose();
  });

  it("prunes smoothing state for bindings that no longer exist", () => {
    const { el, fire } = stubContainer();
    const binding: SceneInteractionBinding = { source: "hover", target: "bloom", to: 1 };
    const config = sceneWith([binding]);
    const ic = new InteractionController(el, () => config);
    fire("pointerenter");
    converge(ic);
    expect(ic.bindingValue(binding)).toBeGreaterThan(0.98);

    config.interaction!.bindings = [];
    ic.update(1 / 60);
    expect(ic.bindingValue(binding)).toBe(0); // unknown again
    ic.dispose();
  });
});

describe("press release", () => {
  afterEach(() => vi.unstubAllGlobals());

  function pressScene() {
    const binding: SceneInteractionBinding = { source: "press", target: "bloom", to: 1 };
    return { binding, config: sceneWith([binding]) };
  }

  it("ends a press released outside the container", () => {
    // The container's listeners stop at its edge, so a press that starts inside and ends outside
    // never saw its pointerup and stayed latched until the next click. The window sees it.
    const { el, fire } = stubContainer();
    const win = stubWindow();
    vi.stubGlobal("window", win.win);
    const { binding, config } = pressScene();
    const ic = new InteractionController(el, () => config);

    fire("pointerdown", { pointerId: 1 });
    converge(ic);
    expect(ic.bindingValue(binding)).toBeGreaterThan(0.98);

    fire("pointerleave", { pointerId: 1, buttons: 1 }); // dragged out with the button still held
    converge(ic);
    expect(ic.bindingValue(binding)).toBeGreaterThan(0.98);

    win.fire("pointerup", { pointerId: 1 }); // released out there, where only the window sees it
    converge(ic);
    expect(ic.bindingValue(binding)).toBeLessThan(0.02);
    ic.dispose();
  });

  it("ends a press on pointercancel", () => {
    const { el, fire } = stubContainer();
    const { binding, config } = pressScene();
    const ic = new InteractionController(el, () => config);
    fire("pointerdown", { pointerId: 1 });
    converge(ic);
    expect(ic.bindingValue(binding)).toBeGreaterThan(0.98);
    fire("pointercancel", { pointerId: 1 });
    converge(ic);
    expect(ic.bindingValue(binding)).toBeLessThan(0.02);
    ic.dispose();
  });

  it("ends a press when the pointer leaves with no button held", () => {
    const { el, fire } = stubContainer();
    const { binding, config } = pressScene();
    const ic = new InteractionController(el, () => config);
    fire("pointerdown", { pointerId: 1 });
    converge(ic);
    fire("pointerleave", { pointerId: 1, buttons: 0 });
    converge(ic);
    expect(ic.bindingValue(binding)).toBeLessThan(0.02);
    ic.dispose();
  });

  it("ignores another pointer's release", () => {
    const { el, fire } = stubContainer();
    const { binding, config } = pressScene();
    const ic = new InteractionController(el, () => config);
    fire("pointerdown", { pointerId: 1 });
    converge(ic);
    fire("pointerup", { pointerId: 2 });
    converge(ic);
    expect(ic.bindingValue(binding)).toBeGreaterThan(0.98);
    fire("pointerup", { pointerId: 1 });
    converge(ic);
    expect(ic.bindingValue(binding)).toBeLessThan(0.02);
    ic.dispose();
  });

  it("removes every listener it added, on the container and on the window", () => {
    const { el, fire, listeners, counts } = stubContainer();
    const win = stubWindow();
    vi.stubGlobal("window", win.win);
    const { config } = pressScene();
    const ic = new InteractionController(el, () => config);
    fire("pointerdown", { pointerId: 1 }); // arms the window watch mid-press
    expect(win.counts.added).toBe(2);
    ic.dispose();
    expect(listeners.size).toBe(0);
    expect(counts.removed).toBe(counts.added);
    expect(win.counts.removed).toBe(win.counts.added);
  });
});

describe("settle", () => {
  it("collapses pointer input to rest and appear to its final state", () => {
    const { el, fire } = stubContainer();
    const hover: SceneInteractionBinding = { source: "hover", target: "bloom", to: 1 };
    const appear: SceneInteractionBinding = { source: "appear", target: "grain", to: 1 };
    const config = sceneWith([hover, appear]);
    const ic = new InteractionController(el, () => config);
    fire("pointerenter");
    converge(ic);
    expect(ic.bindingValue(hover)).toBeGreaterThan(0.98);

    ic.settle();
    // Reduced-motion users must see the FINAL entered state, not a frozen mid-gesture.
    expect(ic.bindingValue(hover)).toBe(0);
    expect(ic.bindingValue(appear)).toBe(1);
    ic.dispose();
  });
});

describe("scroll preview", () => {
  it("overrides the scroll signal and snaps scroll bindings immediately", () => {
    const { el } = stubContainer();
    const binding: SceneInteractionBinding = { source: "scroll", target: "timeOffset", to: 10 };
    const config = sceneWith([binding]);
    const ic = new InteractionController(el, () => config);
    ic.update(1 / 60);

    ic.scrollOverride = 0.8;
    ic.snapScroll();
    expect(ic.bindingValue(binding)).toBeCloseTo(0.8, 6);
    ic.dispose();
  });
});

describe("applier tables", () => {
  it("reads item bases from the resolved material, mirroring what refresh() restores", () => {
    // The contract that makes a binding at rest invisible: base() must equal the pushed value.
    const material = { density: 2.5, emission: 0.3, ripple: 0.6 };
    const home = { x: 1.5, y: -2 } as never;
    const resolved = { ...material } as never;
    expect(ITEM_APPLIERS.density.base(resolved)).toBe(2.5);
    expect(ITEM_APPLIERS.emission.base(resolved)).toBe(0.3);
    expect(ITEM_APPLIERS.ripple.base(resolved)).toBe(0.6);
    expect(ITEM_APPLIERS.positionX.base(resolved, home)).toBe(1.5);
    expect(ITEM_APPLIERS.positionY.base(resolved, home)).toBe(-2);
  });

  it("keeps cameraZoom a pure multiplier with a rest value of 1", () => {
    expect(SCENE_APPLIERS.cameraZoom.base()).toBe(1);
  });

  /**
   * The camera swing is an OFFSET over whatever a drag-orbit has set, so its rest value has to be
   * zero. A base of anything else would make a scene that merely declares the binding sit at a
   * different angle from one that does not.
   */
  it("rests the camera swing at zero, since it is added to the drag-orbit", () => {
    expect(SCENE_APPLIERS.cameraYaw.base()).toBe(0);
    expect(SCENE_APPLIERS.cameraPitch.base()).toBe(0);
  });

  /** The beam targets fall back to the authored values, so a scene without a beam is inert. */
  it("bases the beam targets on the authored beam, and on rest values without one", () => {
    const withBeam = ensureSceneConfig({
      beam: { radius: 4, sides: 3, face: 0, incidence: 41, entry: 0.3 },
    });
    expect(SCENE_APPLIERS.beamIncidence.base(withBeam)).toBe(41);
    expect(SCENE_APPLIERS.beamEntry.base(withBeam)).toBe(0.3);
    const noBeam = ensureSceneConfig({});
    expect(noBeam.beam).toBeUndefined();
    expect(SCENE_APPLIERS.beamEntry.base(noBeam)).toBe(0.5);
  });
});

/**
 * `ensureSceneConfig` owns binding validation and has its own suite next door. It is exercised
 * here as well because every raw value this layer reads arrives through it: a source or target
 * it let through would reach the applier tables above unchecked.
 */
describe("ensureSceneConfig, the binding contract the controller relies on", () => {
  it("drops junk and keeps custom sources when normalizing a scene", () => {
    const config = ensureSceneConfig({
      interaction: {
        bindings: [
          { source: "hover", target: "bloom", to: 0.3 },
          { source: "nope", target: "bloom", to: 0.3 },
          { source: "hover", target: "sparkle", to: 0.3 },
          { source: "hover", target: "grain", to: Number.NaN },
          { source: "custom:beat", target: "vignette", to: 0.5, smoothing: 9 },
        ],
      },
    } as unknown as Partial<SceneConfig>);
    expect(config.interaction?.bindings).toEqual([
      { source: "hover", target: "bloom", to: 0.3 },
      { source: "custom:beat", target: "vignette", to: 0.5, smoothing: 2 },
    ]);
  });

  it("stays absent when absent, and survives a JSON round trip when present", () => {
    const plain = ensureSceneConfig({});
    expect("interaction" in plain).toBe(false);
    expect(plain.lamps.every((lamp) => !("bindings" in lamp))).toBe(true);

    const item = createItem();
    const itemBindings: ItemInteractionBinding[] = [
      { source: "press", target: "emission", to: 0.5 },
    ];
    item.interaction = { bindings: itemBindings };
    const lamp = createLamp();
    lamp.bindings = [{ source: "pointerX", target: "x", to: 0.9, from: 0.1 }];
    const config = ensureSceneConfig({
      items: [item],
      lamps: [lamp],
      interaction: { touch: true, bindings: [{ source: "scroll", target: "timeOffset", to: 8 }] },
    });
    const roundTripped = ensureSceneConfig(JSON.parse(JSON.stringify(config)));
    expect(roundTripped).toEqual(config);
    expect(roundTripped.items[0].interaction?.bindings).toEqual(itemBindings);
    expect(roundTripped.lamps[0].bindings?.[0].from).toBe(0.1);
  });

  it("carries a scatter's shared reactions through normalization and cleans junk", () => {
    // An inert scatter stays inert: no interaction key materializes from normalization.
    expect("interaction" in ensureSceneConfig({}).scatter!).toBe(false);

    const config = ensureSceneConfig({
      scatter: {
        ...createDefaultConfig().scatter!,
        interaction: {
          bindings: [
            { source: "hoverSelf", target: "hueShift", to: 0.4 },
            { source: "nope", target: "hueShift", to: 0.4 },
          ],
        },
      },
    } as unknown as Partial<SceneConfig>);
    expect(config.scatter?.interaction?.bindings).toEqual([
      { source: "hoverSelf", target: "hueShift", to: 0.4 },
    ]);
    const roundTripped = ensureSceneConfig(JSON.parse(JSON.stringify(config)));
    expect(roundTripped.scatter?.interaction).toEqual(config.scatter?.interaction);
  });
});
