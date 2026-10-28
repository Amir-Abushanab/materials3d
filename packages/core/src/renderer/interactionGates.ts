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

/** A position to write and the authored home it rests at: a shape's mesh and `home`, structurally,
 *  so this module keeps its promise not to import three. */
interface Vec2Like {
  x: number;
  y: number;
}

/**
 * Hold a shape's BOUND position axes at its authored home: what the `positionX` / `positionY`
 * appliers write at rest, done without them.
 *
 * For the frames between the config turning the layer on and the chunk landing. Every OTHER
 * binding rests at a value the unbound frame already shows (a uniform at its authored base), but a
 * position binding runs after the motions and WINS over a drift on the same axis, so at rest it
 * pins that axis to home. Skipping the write before the chunk left the drift on, and the scene
 * opened in a pose it never shows again, snapping once the chunk arrived. A capture taken in that
 * window exported the drifted pose, so the same config rendered differently depending on how fast
 * one dynamic import resolved. `staircase`, whose twenty treads all drift on Y and bind `positionY`
 * to scroll, was the scene that showed it.
 *
 * Mirrors `ITEM_APPLIERS.positionX/positionY` (interaction.ts); a test holds the two together.
 */
export function pinBoundAxes(
  bindings: readonly ItemInteractionBinding[] | undefined,
  position: Vec2Like,
  home: Readonly<Vec2Like>,
): void {
  if (!bindings) return;
  for (let i = 0; i < bindings.length; i++) {
    const target = bindings[i].target;
    if (target === "positionX") position.x = home.x;
    else if (target === "positionY") position.y = home.y;
  }
}
