// The synchronous half of the interactivity layer: pure config predicates. Nothing here touches the
// DOM, holds state, or imports three.
//
// It is a SEPARATE MODULE for one reason — the tree-shaking boundary. Both renderers need these
// answers synchronously (they decide whether the layer runs at all), but the runtime behind them —
// the controller, its listeners, the applier tables, the tilt sensor — is ~3.7 KB gzipped that a
// scene with no bindings never executes. Keeping the two in one file forced a static import of the
// whole layer into every bundle. Split, the renderers import only this (a few hundred bytes) and
// reach interaction.ts through a dynamic import, so the runtime is a chunk that is fetched only by
// pages that actually interact.
//
// The rule this file exists to enforce: NOTHING in the eager import graph may import
// `./interaction` — reach it through `import("./interaction")` instead.
import type {
  ItemInteractionBinding,
  LampInteractionBinding,
  SceneConfig,
  SceneInteractionBinding,
} from "../config/model";

type AnyBinding = ItemInteractionBinding | LampInteractionBinding | SceneInteractionBinding;

/** Whether the interaction layer should run at all: not disabled, and SOME binding list exists,
 *  on the scene, a shape (authored or scatter-generated), or a lamp. Keyed off config only, so
 *  input can never trigger it — and so it can decide whether the runtime chunk is ever fetched. */
export function interactionActive(cfg: SceneConfig): boolean {
  if (cfg.interaction?.enabled === false) return false;
  if ((cfg.interaction?.bindings?.length ?? 0) > 0) return true;
  if (cfg.lamps.some((lamp) => (lamp.bindings?.length ?? 0) > 0)) return true;
  // Mirror resolveItems: a scatter REPLACES the item list, so its shared reaction list is what
  // the generated shapes will carry, and `items` is the authored fallback.
  if (cfg.scatter) return (cfg.scatter.interaction?.bindings?.length ?? 0) > 0;
  return cfg.items.some((item) => (item.interaction?.bindings?.length ?? 0) > 0);
}

/** True when any binding in the list reads the orientation sensor. */
function anyTiltSource(bindings: readonly AnyBinding[] | undefined): boolean {
  if (!bindings) return false;
  for (let i = 0; i < bindings.length; i++) {
    const s = bindings[i].source;
    if (s === "tiltX" || s === "tiltY") return true;
  }
  return false;
}

/**
 * Whether anything in this scene reads the orientation sensor: a `tiltX` / `tiltY` binding
 * anywhere, or the opt-in that lets tilt stand in for the cursor. A tilt BINDING is the switch —
 * the `interaction.tilt` block is tuning, exactly as `pointerX` needs no "pointer" block — so a
 * scene that never mentions tilt attaches no `deviceorientation` listener and touches no sensor.
 * Mirrors {@link interactionActive}'s walk, scatter's shared reaction list included — but with
 * indexed loops and no closures, because unlike its sibling this one is checked every frame.
 */
export function tiltActive(cfg: SceneConfig): boolean {
  if (cfg.interaction?.enabled === false) return false;
  if (cfg.interaction?.tilt?.pointer) return true;
  if (anyTiltSource(cfg.interaction?.bindings)) return true;
  for (let i = 0; i < cfg.lamps.length; i++) {
    if (anyTiltSource(cfg.lamps[i].bindings)) return true;
  }
  if (cfg.scatter) return anyTiltSource(cfg.scatter.interaction?.bindings);
  for (let i = 0; i < cfg.items.length; i++) {
    if (anyTiltSource(cfg.items[i].interaction?.bindings)) return true;
  }
  return false;
}
