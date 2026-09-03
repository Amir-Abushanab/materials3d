/**
 * The optional interactivity runtime: input-to-parameter bindings. There is no pointer FIELD
 * (hover swell, drag-wake, click ripples deform a membrane; these shapes are rigid). It lives in
 * renderer/ so it stays below the
 * shell/studio/index layers; it may import only `three`, ../config/model, and ../util/math.
 *
 * Split of responsibility with MaterialRenderer: this controller owns ALL input + smoothing (the
 * one cursor's position / presence / press / velocity, scroll progress + velocity, the `appear`
 * latch, custom inputs, and every binding's smoothed 0..1 source value, keyed by binding
 * identity, so scene + per-item + per-lamp lists all get their own smoothing). The renderer calls
 * update(dt) once per frame and writes uniforms through the applier tables below. Bindings NEVER
 * mutate `config`, so any refresh restores the authored base.
 */

import type * as THREE from "three";
import { clamp01 } from "../util/math";
import type {
  InteractionSource,
  ItemConfig,
  ItemInteractionBinding,
  ItemInteractionTarget,
  LampConfig,
  LampInteractionBinding,
  LampInteractionTarget,
  MaterialConfig,
  SceneConfig,
  SceneInteractionBinding,
  SceneInteractionTarget,
} from "../config/model";

const VELOCITY_TAU = 0.08; // pointer-velocity smoothing time constant (seconds)
const POINTER_SPEED_REF = 4.0; // NDC/s that normalizes pointerSpeed to 1.0
const SCROLL_VELOCITY_REF = 2.0; // progress/s that normalizes scrollVelocity to 1.0
const SCROLL_VELOCITY_TAU = 0.15; // scroll-velocity smoothing (seconds)
const DEFAULT_POINTER_TAU = 0.12; // pointer-follow smoothing (seconds)
const DEFAULT_BINDING_TAU = 0.25; // per-binding source smoothing default (seconds)
const PASSIVE = { passive: true } as const;

type AnyBinding = ItemInteractionBinding | LampInteractionBinding | SceneInteractionBinding;

/** Frame-rate-independent exponential smoothing factor for time constant `tau` (seconds). */
function alpha(tau: number, dt: number): number {
  return tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
}

// ---- Binding applier tables -----------------------------------------------------------------

/** What an item-scoped applier writes into: one shape's uniforms + its mesh transform. Bases read
 *  from the shape's RESOLVED material (the renderer caches it at push time) and its authored
 *  `home` pose, mirroring exactly what refresh() would restore, so a binding at rest writes the
 *  value the renderer already had, with no visible jump. */
export interface ItemApplyArgs {
  u: Record<string, THREE.IUniform>;
  mesh: THREE.Object3D;
  home: THREE.Vector3;
}
/** What a lamp-scoped applier writes into: that lamp's packed uniform (xy centre · z radius ·
 *  w intensity, see applyLamps). */
export interface LampApplyArgs {
  vec: THREE.Vector4;
}
/** What a scene-scoped applier writes into: the post + shared-lamp uniforms, plus a small
 *  out-param the renderer seeds each frame and reads back (time-offset delta + zoom multiplier). */
export interface SceneApplyArgs {
  post: Record<string, THREE.IUniform>;
  lamps: Record<string, THREE.IUniform>;
  /** Values the renderer reads back after the appliers run, for the targets that cannot be
   *  expressed as a uniform write. */
  out: {
    timeOffset: number;
    zoom: number;
    beamIncidence: number;
    beamEntry: number;
    /** Degrees, added to the drag-orbit angles. */
    orbitYaw: number;
    orbitPitch: number;
  };
}

interface ItemApplier {
  base(m: MaterialConfig, home: THREE.Vector3): number;
  apply(value: number, a: ItemApplyArgs): void;
}
interface LampApplier {
  base(lamp: LampConfig): number;
  apply(value: number, a: LampApplyArgs): void;
}
interface SceneApplier {
  base(c: SceneConfig): number;
  apply(value: number, a: SceneApplyArgs): void;
}

const uniform =
  (name: string) =>
  (value: number, a: ItemApplyArgs): void => {
    a.u[name].value = value;
  };

/**
 * Per-shape binding targets → (how to read the authored base value, how to write the modulated
 * one). This object is the runtime source of truth for {@link ItemInteractionTarget} (enforced by
 * `satisfies`). The uniform names mirror pushMaterialUniforms, the ONE list both draw from.
 */
export const ITEM_APPLIERS = {
  density: { base: (m) => m.density, apply: uniform("uSigma") },
  ior: { base: (m) => m.ior, apply: uniform("uIOR") },
  dispersion: { base: (m) => m.dispersion, apply: uniform("uDisp") },
  lens: { base: (m) => m.lens, apply: uniform("uLens") },
  rim: { base: (m) => m.rim, apply: uniform("uRim") },
  specular: { base: (m) => m.specular, apply: uniform("uSpec") },
  saturation: { base: (m) => m.saturation, apply: uniform("uSat") },
  hueShift: { base: (m) => m.hueShift, apply: uniform("uHue") },
  emission: { base: (m) => m.emission, apply: uniform("uEmis") },
  ripple: { base: (m) => m.ripple, apply: uniform("uRipple") },
  iridescence: { base: (m) => m.iridescence, apply: uniform("uIrid") },
  filmNm: { base: (m) => m.filmNm, apply: uniform("uFilm") },
  positionX: {
    base: (_m, home) => home.x,
    apply: (v, a) => {
      a.mesh.position.x = v;
    },
  },
  positionY: {
    base: (_m, home) => home.y,
    apply: (v, a) => {
      // Runs after applyMotions, so on the bound component the binding wins over a drift.
      a.mesh.position.y = v;
    },
  },
} satisfies Record<ItemInteractionTarget, ItemApplier>;

/** Per-lamp binding targets, writing the packed lamp vec4 the plate shader reads. */
export const LAMP_APPLIERS = {
  x: {
    base: (l) => l.x,
    apply: (v, a) => {
      a.vec.x = v;
    },
  },
  y: {
    base: (l) => l.y,
    apply: (v, a) => {
      a.vec.y = v;
    },
  },
  radius: {
    base: (l) => l.r,
    apply: (v, a) => {
      a.vec.z = Math.max(v, 0.001);
    },
  },
  intensity: {
    base: (l) => l.intensity,
    apply: (v, a) => {
      a.vec.w = Math.max(v, 0);
    },
  },
} satisfies Record<LampInteractionTarget, LampApplier>;

/** Scene-level binding targets. base() mirrors refresh() / applyPost() / the camera fallbacks. */
export const SCENE_APPLIERS = {
  timeOffset: {
    base: (c) => c.timeOffset,
    apply: (v, a) => {
      a.out.timeOffset = v;
    },
  },
  // No authored cameraZoom exists in this config, the binding is a MULTIPLIER over the authored
  // camera distance (2 = twice as close), so its rest value is simply 1.
  cameraZoom: {
    base: () => 1,
    apply: (v, a) => {
      a.out.zoom = v;
    },
  },
  /**
   * The two odd ones out: every other scene applier writes a uniform, and these ask for the beam
   * to be retraced.
   *
   * A beam's shape is decided on the CPU. Snell at each face, per wavelength, so there is no
   * uniform that can move it. They only record what is wanted; the renderer compares against what
   * the current mesh was built from and rebuilds when it differs, which is what keeps a pointer
   * that has stopped moving from retracing every frame for an identical answer.
   *
   * Two axes because incidence and impact point are independent: one swings the source around the
   * prism, the other slides where it lands along the face.
   */
  beamIncidence: {
    base: (c) => c.beam?.incidence ?? 0,
    apply: (v, a) => {
      a.out.beamIncidence = v;
    },
  },
  beamEntry: {
    base: (c) => c.beam?.entry ?? 0.5,
    apply: (v, a) => {
      a.out.beamEntry = v;
    },
  },
  /**
   * A few degrees of camera swing from the pointer.
   *
   * Additive over the drag-orbit rather than replacing it, so a scene can have both and they
   * compose instead of fighting for the same variable. Keep the range small: what this is for is
   * the parallax between the subject and whatever sits behind it, which reads at three or four
   * degrees and turns into a lurch by ten.
   */
  cameraYaw: {
    base: () => 0,
    apply: (v, a) => {
      a.out.orbitYaw = v;
    },
  },
  cameraPitch: {
    base: () => 0,
    apply: (v, a) => {
      a.out.orbitPitch = v;
    },
  },
  lampGain: {
    base: (c) => c.lampGain,
    apply: (v, a) => {
      a.lamps.uLampGain.value = v;
    },
  },
  aperture: {
    base: (c) => c.post.aperture,
    apply: (v, a) => {
      a.post.uAperture.value = v;
    },
  },
  bloom: {
    base: (c) => c.post.bloom,
    apply: (v, a) => {
      a.post.uBloom.value = v;
    },
  },
  haze: {
    base: (c) => c.post.haze,
    apply: (v, a) => {
      a.post.uHaze.value = v;
    },
  },
  vignette: {
    base: (c) => c.post.vignette,
    apply: (v, a) => {
      a.post.uVignette.value = v;
    },
  },
  grain: {
    base: (c) => c.post.grain,
    apply: (v, a) => {
      a.post.uGrain.value = v;
    },
  },
  caustics: {
    base: (c) => c.post.caustics,
    apply: (v, a) => {
      a.post.uCaustics.value = v;
    },
  },
} satisfies Record<SceneInteractionTarget, SceneApplier>;

// ---- Active-state predicate ------------------------------------------------------------------

/** Whether the interaction layer should run at all: not disabled, and SOME binding list exists,
 *  on the scene, a shape (authored or scatter-generated), or a lamp. Keyed off config only, so
 *  input can never trigger it. */
export function interactionActive(cfg: SceneConfig): boolean {
  if (cfg.interaction?.enabled === false) return false;
  if ((cfg.interaction?.bindings?.length ?? 0) > 0) return true;
  if (cfg.lamps.some((lamp) => (lamp.bindings?.length ?? 0) > 0)) return true;
  // Mirror resolveItems: a scatter REPLACES the item list, so its shared reaction list is what
  // the generated shapes will carry, and `items` is the authored fallback.
  if (cfg.scatter) return (cfg.scatter.interaction?.bindings?.length ?? 0) > 0;
  return cfg.items.some((item) => (item.interaction?.bindings?.length ?? 0) > 0);
}

// ---- The controller --------------------------------------------------------------------------

interface Vec2Like {
  x: number;
  y: number;
}

/**
 * Owns the one cursor's input + scroll + press/appear/custom and all smoothing. Constructed by
 * the renderer when {@link interactionActive} first turns true, disposed when it turns false.
 * All listeners are passive and container-scoped (the poster overlay passes events through),
 * except the release of a held press, which is watched at the window; see {@link watchRelease}.
 */
export class InteractionController {
  /** Studio-only scroll preview: when non-null, overrides the computed scroll progress. */
  scrollOverride: number | null = null;

  private readonly ndc: Vec2Like = { x: 0, y: 0 };
  private readonly ndcTarget: Vec2Like = { x: 0, y: 0 };
  private readonly ndcPrev: Vec2Like = { x: 0, y: 0 };
  private readonly velNdc: Vec2Like = { x: 0, y: 0 };
  private presence = 0;
  private presenceTarget = 0;
  private press = 0;
  private pressTarget = 0;
  // The pointer that began the current press, so another pointer's release cannot end it.
  private pressPointerId = -1;
  // Whether the window is being watched for that press's release; see watchRelease.
  private releaseWatched = false;
  private pointerSpeed = 0;
  private scroll = 0;
  private scrollPrev = 0;
  private scrollVel = 0;
  // Frame counter and its delta, and the frame the scroll signal was last sampled on; see
  // sampleScroll.
  private frame = 0;
  private frameDt = 0;
  private scrollFrame = -1;
  private appearLatched = false;
  // Which config item the pointer is over (renderer raycasts and feeds this each frame); -1 = none.
  private hoverItemIndex = -1;
  // Which config item the CURRENT press began on, latched at pointerdown, held until the next
  // down (the smoothed `press` going to 0 already zeroes every pressSelf raw value on release).
  private pressItemIndex = -1;
  // A pointerdown whose hit test hasn't run yet: its NDC. The renderer consumes it (raycast) on
  // the next frame via pendingPress()/setPressItem().
  private pressPending: Vec2Like | null = null;
  private readonly pressNdc: Vec2Like = { x: 0, y: 0 };
  private readonly customInputs = new Map<string, number>();
  // Per-binding smoothing state, keyed by binding-object identity (covers scene + every item and
  // lamp list).
  private readonly bindingState = new Map<
    AnyBinding,
    { value: number; source: InteractionSource }
  >();
  // Scratch set reused by updateBindings every frame (cleared, never reallocated).
  private readonly seenBindings = new Set<AnyBinding>();

  // The item list the per-shape bindings live on. For a hand-authored scene that is cfg().items;
  // the renderer overrides it with its RESOLVED list so scatter-generated shapes (which never
  // appear in cfg().items) smooth and hit-test like authored ones. Indices into this list are the
  // shared currency with setHoverItem/setPressItem.
  private readonly itemList: () => readonly ItemConfig[];

  constructor(
    private readonly container: HTMLElement,
    private readonly cfg: () => SceneConfig | undefined,
    items?: () => readonly ItemConfig[],
  ) {
    this.itemList = items ?? ((): readonly ItemConfig[] => this.cfg()?.items ?? []);
    container.addEventListener("pointerenter", this.onPointerEnter, PASSIVE);
    container.addEventListener("pointermove", this.onPointerMove, PASSIVE);
    container.addEventListener("pointerleave", this.onPointerLeave, PASSIVE);
    container.addEventListener("pointercancel", this.onPointerCancel, PASSIVE);
    container.addEventListener("pointerdown", this.onPointerDown, PASSIVE);
    container.addEventListener("pointerup", this.onPointerUp, PASSIVE);
  }

  /** Ignore coarse (touch) pointers unless the scene opts in with interaction.touch. */
  private ignore(e: PointerEvent): boolean {
    return e.pointerType === "touch" && this.cfg()?.interaction?.touch !== true;
  }

  private setNdcTarget(e: PointerEvent): void {
    const rect = this.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.ndcTarget.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndcTarget.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  }

  private onPointerEnter = (e: PointerEvent): void => {
    if (this.ignore(e)) return;
    this.presenceTarget = 1;
    this.setNdcTarget(e);
  };
  private onPointerMove = (e: PointerEvent): void => {
    if (this.ignore(e)) return;
    if (e.pointerType === "touch" && this.pressTarget < 0.5) return; // touch: only track while down
    this.presenceTarget = 1;
    this.setNdcTarget(e);
  };
  private onPointerLeave = (e: PointerEvent): void => {
    if (this.ignore(e)) return;
    this.presenceTarget = 0;
    this.ndcTarget.x = 0; // relax toward centre → pointerX/Y rest at 0.5
    this.ndcTarget.y = 0;
    // Leaving with no button held means the release itself went unseen, so the press ends here
    // rather than staying latched until the next click.
    if (e.buttons === 0) this.release(e);
  };
  private onPointerCancel = (e: PointerEvent): void => {
    if (this.ignore(e)) return;
    this.release(e);
    this.presenceTarget = 0;
    this.ndcTarget.x = 0;
    this.ndcTarget.y = 0;
  };
  private onPointerDown = (e: PointerEvent): void => {
    if (this.ignore(e)) return;
    this.pressTarget = 1;
    this.presenceTarget = 1;
    this.setNdcTarget(e);
    this.pressPointerId = e.pointerId;
    this.watchRelease();
    // Latch the down position for the per-shape press hit test (resolved by the renderer next
    // frame). A down on empty space resolves to no shape, replacing any previous latch.
    this.pressNdc.x = this.ndcTarget.x;
    this.pressNdc.y = this.ndcTarget.y;
    this.pressPending = this.pressNdc;
  };
  private onPointerUp = (e: PointerEvent): void => {
    if (this.ignore(e) || e.pointerId !== this.pressPointerId) return;
    this.release(e);
  };
  /** The window's view of the release, for a press that ended outside the container. */
  private onWindowRelease = (e: PointerEvent): void => {
    if (e.pointerId !== this.pressPointerId) return;
    this.release(e);
  };

  private release(e: PointerEvent): void {
    this.pressTarget = 0;
    this.pressPointerId = -1;
    this.unwatchRelease();
    if (e.pointerType === "touch") {
      this.presenceTarget = 0; // touch has no hover, so presence ends with the touch
      this.ndcTarget.x = 0;
      this.ndcTarget.y = 0;
    }
  }

  /**
   * Watch the window for the held press's release.
   *
   * The container's own listeners stop at its edge, so a press that starts inside and ends outside
   * never sees its `pointerup` and stays latched until the next click. The window sees every
   * release. Pointer capture would too, but the renderer's orbit captures on the canvas for a
   * secondary-button drag, and a second capture on the container would take that pointer's moves
   * away from it.
   */
  private watchRelease(): void {
    if (this.releaseWatched || typeof window === "undefined") return;
    window.addEventListener("pointerup", this.onWindowRelease, PASSIVE);
    window.addEventListener("pointercancel", this.onWindowRelease, PASSIVE);
    this.releaseWatched = true;
  }

  private unwatchRelease(): void {
    if (!this.releaseWatched) return;
    window.removeEventListener("pointerup", this.onWindowRelease);
    window.removeEventListener("pointercancel", this.onWindowRelease);
    this.releaseWatched = false;
  }

  /** Advance all smoothed state by `dt` seconds. Called from the render loop with the same delta. */
  update(dt: number): void {
    const cfg = this.cfg();
    if (!cfg) return;
    const d = Math.max(dt, 0);
    const kPointer = alpha(DEFAULT_POINTER_TAU, d);

    // Pointer position + presence + press.
    this.ndcPrev.x = this.ndc.x;
    this.ndcPrev.y = this.ndc.y;
    this.ndc.x += (this.ndcTarget.x - this.ndc.x) * kPointer;
    this.ndc.y += (this.ndcTarget.y - this.ndc.y) * kPointer;
    this.presence += (this.presenceTarget - this.presence) * kPointer;
    this.press += (this.pressTarget - this.press) * kPointer;

    // Velocity (own tau) from the smoothed-position delta.
    if (d > 1e-5) {
      const kv = alpha(VELOCITY_TAU, d);
      this.velNdc.x += ((this.ndc.x - this.ndcPrev.x) / d - this.velNdc.x) * kv;
      this.velNdc.y += ((this.ndc.y - this.ndcPrev.y) / d - this.velNdc.y) * kv;
    }
    this.pointerSpeed =
      this.presence * clamp01(Math.hypot(this.velNdc.x, this.velNdc.y) / POINTER_SPEED_REF);

    // Scroll is sampled by the bindings that read it, at most once a frame; see sampleScroll.
    this.frame++;
    this.frameDt = d;

    // Appear latch: the render loop is visibility-gated, so the first update() IS first-visible.
    this.appearLatched = true;

    this.updateBindings(cfg, d);
  }

  // Indexed loops + a reused scratch set (no per-frame closure/array/Set), this runs every frame.
  private updateBindings(cfg: SceneConfig, dt: number): void {
    const seen = this.seenBindings;
    seen.clear();
    const sceneBindings = cfg.interaction?.bindings;
    if (sceneBindings) {
      for (let i = 0; i < sceneBindings.length; i++) this.advanceBinding(sceneBindings[i], dt);
    }
    for (let l = 0; l < cfg.lamps.length; l++) {
      const bindings = cfg.lamps[l].bindings;
      if (!bindings) continue;
      for (let i = 0; i < bindings.length; i++) this.advanceBinding(bindings[i], dt);
    }
    const items = this.itemList();
    for (let s = 0; s < items.length; s++) {
      const bindings = items[s].interaction?.bindings;
      if (!bindings) continue;
      for (let i = 0; i < bindings.length; i++) this.advanceBinding(bindings[i], dt, s);
    }
    // Prune state for bindings that no longer exist (edited/removed slots). advanceBinding puts
    // every seen binding in the map, so map ⊇ seen, equal sizes means nothing is stale.
    if (this.bindingState.size > seen.size) {
      for (const key of this.bindingState.keys()) if (!seen.has(key)) this.bindingState.delete(key);
    }
  }

  /** Advance one binding's smoothed source value by `dt` and mark it live in `seenBindings`.
   *  `itemIndex` is the owning config item for item bindings (-1 for scene/lamp bindings), so
   *  the per-shape `hoverSelf` source can resolve against the raycast hit. */
  private advanceBinding(b: AnyBinding, dt: number, itemIndex = -1): void {
    this.seenBindings.add(b);
    const raw = this.rawSource(b.source, itemIndex);
    let st = this.bindingState.get(b);
    // (Re)initialise on first sight or when the slot's source changed (studio edit): `appear`
    // ramps from 0 (entrance), every other source snaps to its current value.
    if (!st || st.source !== b.source) {
      st = { value: b.source === "appear" ? 0 : raw, source: b.source };
      this.bindingState.set(b, st);
    }
    st.value += (raw - st.value) * alpha(b.smoothing ?? DEFAULT_BINDING_TAU, dt);
  }

  /** The current smoothed 0..1 value of a binding's source (0 if the binding is unknown). */
  bindingValue(b: AnyBinding): number {
    return this.bindingState.get(b)?.value ?? 0;
  }

  /** The current raw (un-per-binding-smoothed) 0..1 value of a source signal. */
  private rawSource(source: InteractionSource, itemIndex = -1): number {
    switch (source) {
      case "scroll":
        this.sampleScroll();
        return this.scroll;
      case "hover":
        return this.presence;
      case "hoverSelf":
        // Only meaningful on an item binding; the renderer raycasts the cursor into the scene
        // and reports the hit. Raw 0/1, the per-binding smoothing supplies the ease.
        return itemIndex >= 0 && itemIndex === this.hoverItemIndex ? 1 : 0;
      case "pointerX":
        return (this.ndc.x + 1) * 0.5;
      case "pointerY":
        return (this.ndc.y + 1) * 0.5;
      case "pointerSpeed":
        return this.pointerSpeed;
      case "press":
        return this.press;
      case "pressSelf":
        // The press that began on THIS shape, riding the shared smoothed press envelope, so a
        // release eases out exactly like the global `press` source does.
        return itemIndex >= 0 && itemIndex === this.pressItemIndex ? this.press : 0;
      case "scrollVelocity":
        this.sampleScroll();
        return clamp01(this.scrollVel / SCROLL_VELOCITY_REF);
      case "appear":
        return this.appearLatched ? 1 : 0;
      default:
        // custom:<name>, fed by setInput(name, value).
        return this.customInputs.get(source.slice("custom:".length)) ?? 0;
    }
  }

  /**
   * Scroll progress and velocity, sampled at most once per frame and only when a binding reads
   * them. The sample is a `getBoundingClientRect`, which forces layout, and most scenes bind
   * nothing to scroll: taking it every frame regardless was the one layout hit in the loop.
   */
  private sampleScroll(): void {
    if (this.scrollFrame === this.frame) return;
    const raw = this.scrollOverride ?? this.computeScroll();
    // Velocity only against the previous frame's sample. After a gap the signal was asleep, and
    // the jump from its stale value is a wake-up, not a movement.
    if (this.scrollFrame === this.frame - 1 && this.frameDt > 1e-5) {
      const sv = Math.abs(raw - this.scrollPrev) / this.frameDt;
      this.scrollVel += (sv - this.scrollVel) * alpha(SCROLL_VELOCITY_TAU, this.frameDt);
    }
    this.scrollPrev = raw;
    this.scroll = raw;
    this.scrollFrame = this.frame;
  }

  /** Container progress through the viewport: 0 as it enters from below, 1 once scrolled past. */
  private computeScroll(): number {
    if (typeof window === "undefined") return 0;
    const rect = this.container.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 1;
    return clamp01((vh - rect.top) / (vh + rect.height));
  }

  /** The raw (unsmoothed) cursor target in NDC, or null while the pointer is away, what the
   *  renderer raycasts to resolve `hoverSelf`. Live reference; read synchronously. */
  pointerTarget(): { x: number; y: number } | null {
    return this.presenceTarget > 0 ? this.ndcTarget : null;
  }

  /** Report which config item the cursor is over (-1 / null = none). Fed by the renderer's
   *  per-frame raycast; drives the `hoverSelf` source. */
  setHoverItem(index: number | null): void {
    this.hoverItemIndex = index ?? -1;
  }

  /** A pointerdown whose hit test hasn't run yet: its NDC, or null. The renderer raycasts it and
   *  answers via setPressItem, which also clears the pending state, so each down is tested once. */
  pendingPress(): { x: number; y: number } | null {
    return this.pressPending;
  }

  /** Resolve the latched press to a config item (-1 / null = the down was on empty space).
   *  Drives the `pressSelf` source until the next pointerdown replaces it. */
  setPressItem(index: number | null): void {
    this.pressItemIndex = index ?? -1;
    this.pressPending = null;
  }

  /** Feed a `custom:<name>` input (developer API; see MaterialRenderer.setInteractionInput). */
  setInput(name: string, value: number): void {
    if (typeof name !== "string" || !Number.isFinite(value)) return;
    this.customInputs.set(name, value);
  }

  /**
   * Collapse to the settled resting state for the single frame drawn when the loop stops (paused /
   * reduced-motion / offscreen): presence / velocity / press / pointerSpeed → 0, scroll → its
   * current raw value, pointer → centre, and `appear` → 1 (reduced-motion users must see the FINAL
   * entered state). Custom inputs KEEP their last explicit values. Each binding snaps to its
   * settled source so the one settled frame shows the final look.
   */
  settle(): void {
    this.presence = this.presenceTarget = 0;
    this.press = this.pressTarget = 0;
    this.pointerSpeed = 0;
    this.velNdc.x = this.velNdc.y = 0;
    this.ndc.x = this.ndc.y = 0;
    this.ndcTarget.x = this.ndcTarget.y = 0;
    this.ndcPrev.x = this.ndcPrev.y = 0;
    this.scrollFrame = -1; // a fresh sample, and still: the settled frame has no velocity
    this.sampleScroll();
    this.scrollVel = 0;
    this.appearLatched = true;
    this.hoverItemIndex = -1; // settled = no shape under the cursor
    this.pressItemIndex = -1;
    this.pressPending = null;
    const cfg = this.cfg();
    if (cfg) {
      this.bindingState.clear();
      const snap = (b: AnyBinding): void => {
        this.bindingState.set(b, { value: this.rawSource(b.source), source: b.source });
      };
      for (const b of cfg.interaction?.bindings ?? []) snap(b);
      for (const lamp of cfg.lamps) for (const b of lamp.bindings ?? []) snap(b);
      for (const item of this.itemList()) for (const b of item.interaction?.bindings ?? []) snap(b);
    }
  }

  /**
   * Snap scroll progress + the scroll-sourced bindings to the current override at once, leaving
   * every other input (pointer / press / appear / custom) advancing live. Used by the studio
   * scroll preview: the studio page never really scrolls, so dragging the preview slider is a
   * manual scrub that must reflect the instant you move it, not on the next animation frame,
   * which the browser suspends whenever the tab isn't foreground. Unlike settle() (which
   * collapses ALL input to rest for a paused still frame), this touches only the scroll signal.
   */
  snapScroll(): void {
    this.scrollFrame = -1;
    this.sampleScroll();
    this.scrollVel = 0; // a static scrub has no velocity
    const cfg = this.cfg();
    if (!cfg) return;
    const snap = (b: AnyBinding): void => {
      if (b.source === "scroll" || b.source === "scrollVelocity") {
        this.bindingState.set(b, { value: this.rawSource(b.source), source: b.source });
      }
    };
    for (const b of cfg.interaction?.bindings ?? []) snap(b);
    for (const lamp of cfg.lamps) for (const b of lamp.bindings ?? []) snap(b);
    for (const item of this.itemList()) for (const b of item.interaction?.bindings ?? []) snap(b);
  }

  dispose(): void {
    const c = this.container;
    c.removeEventListener("pointerenter", this.onPointerEnter);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("pointercancel", this.onPointerCancel);
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointerup", this.onPointerUp);
    this.unwatchRelease();
    this.customInputs.clear();
    this.bindingState.clear();
  }
}
