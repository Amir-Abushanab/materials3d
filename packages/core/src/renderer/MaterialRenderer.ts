/**
 * The four-pass refractive-glass renderer.
 *
 *   1. depth   → depthRT   linear depth, 2-channel packed, backdrop pinned to the focal plane
 *   2. plate   → bgRT      the whole frame, glass falling back to the lamp field
 *   3. main    → colorRT   the same frame again, glass now refracting pass 2
 *   4. post    → screen    DOF + saturation bloom + caustics + haze + vignette + grain
 *
 * Pass 3 is what makes glass refract other glass. Sharing one scene-wide plate pass is a trade,
 * not an improvement on per-mesh backside buffers: cheaper with many objects, less accurate per
 * object. Pass 1 exists mostly to keep the backdrop OUT of the depth of field — see resize().
 */

import * as THREE from "three";
import {
  ensureSceneConfig,
  FAR,
  FRAME_ASPECT,
  MAX_LAMPS,
  BACKGROUND_MODES,
  MATERIAL_KINDS,
  STUDIO_KINDS,
  TONE_MAPS,
  MAX_MESH_POINTS,
  MAX_STOPS,
  normalizeMotion,
  resolveMaterial,
  type CameraFit,
  type SceneConfig,
  type GradientType,
  type ItemConfig,
  type LampConfig,
  type MaterialConfig,
  type MotionConfig,
  type PostConfig,
  type ScatterConfig,
} from "../config/model";
import type { Engine } from "../engine";
import { parseHex } from "../util/color";
import { makeRng } from "../util/math";
import type { FrameCallback, MaterialItem } from "./item";
import {
  InteractionController,
  interactionActive,
  ITEM_APPLIERS,
  LAMP_APPLIERS,
  SCENE_APPLIERS,
} from "./interaction";
import { applyMotions, loopFrequency } from "./motions";
import {
  BACKDROP_FRAG,
  BACKDROP_VERT,
  DEPTH_FRAG,
  DEPTH_VERT,
  GLASS_FRAG,
  GLASS_VERT,
  FINISH_FRAG,
  FINISH_VERT,
  POST_FRAG,
  POST_VERT,
  BEAM_VERT,
  BEAM_FRAG,
  BLOOM_EXTRACT_FRAG,
  BLOOM_BLUR_FRAG,
  BACKGLASS_VERT,
  BACKGLASS_FRAG,
  BLOOM_COMPOSITE_FRAG,
  BLOOM_DOWN_FRAG,
  BLIT_FRAG,
  ENV_BAKE_FRAG,
  ENV_BLUR_FRAG,
  PARTICLE_DOWN_FRAG,
  CAUSTIC_FRAG,
  DUST_VERT,
  DUST_FRAG,
} from "./shaders";
import { buildShape, defaultPath } from "./shapes";
import {
  aimBeam,
  aimBeamAtAngle,
  buildLightSheet,
  crossSectionFor,
  prismCrossSection,
} from "./lightSheet";

export interface MaterialRendererOptions {
  /** Freeze to a single static frame when the user has asked for reduced motion. Default true. */
  respectReducedMotion?: boolean;
  /** Render into this canvas instead of creating one inside the container. */
  canvas?: HTMLCanvasElement;
  /** Keep the drawing buffer readable so `captureImage` works. Default true — poster capture is
   *  the whole point of the shell. Turn it off for a pure background that never exports. */
  preserveDrawingBuffer?: boolean;
}

/** Per-item overrides for the imperative {@link MaterialRenderer.add}. */
export interface AddOptions {
  position?: [number, number, number];
  rotation?: [number, number, number];
  rotationOrder?: THREE.EulerOrder;
  scale?: number | [number, number, number];
  material?: Partial<MaterialConfig>;
  /** This shape's motion. Omitted = static; drive it yourself with `onFrame` if you prefer. */
  motion?: Partial<MotionConfig>;
  phase?: number;
  data?: Record<string, unknown>;
}

/** Assign raw display-space components into a `Color` without three's sRGB→linear conversion.
 *  See util/color.ts — the whole pass chain is authored in display space. */
function setRaw(target: THREE.Color, hex: string): THREE.Color {
  const [r, g, b] = parseHex(hex);
  target.r = r;
  target.g = g;
  target.b = b;
  return target;
}

/**
 * Write a resolved material into its shader uniforms. The ONE list of per-material uniforms:
 * `makeMaterial` fills freshly-allocated uniforms through it and `refresh()` re-pushes edits
 * through it, so a new material field is added in exactly one place and creation and update
 * cannot drift apart.
 */
function pushMaterialUniforms(
  u: Record<string, THREE.IUniform>,
  m: ReturnType<typeof resolveMaterial>,
  loopSeconds: number,
): void {
  rawVec(m.tint || "#ffffff", u.uTint.value as THREE.Vector3);
  u.uUseTint.value = m.tint ? 1 : 0;
  u.uDisp.value = m.dispersion;
  u.uLens.value = m.lens;
  u.uSigma.value = m.density;
  u.uUseAbsorb.value = m.absorption ? 1 : 0;
  if (m.absorption) {
    (u.uAbsorb.value as THREE.Vector3).set(m.absorption.x, m.absorption.y, m.absorption.z);
  }
  u.uIOR.value = m.ior;
  u.uPath.value = m.path;
  u.uRim.value = m.rim;
  u.uSpec.value = m.specular;
  u.uSat.value = m.saturation;
  u.uHue.value = m.hueShift;
  u.uEmis.value = m.emission;
  u.uKind.value = MATERIAL_KINDS.indexOf(m.kind);
  u.uRough.value = m.roughness;
  u.uSparkle.value = m.sparkle;
  u.uSparkleScale.value = m.sparkleScale;
  u.uRipple.value = m.ripple;
  u.uRippleScale.value = m.rippleScale;
  // Snapped to whole cycles over the loop, exactly as motion rates are, so the water in a
  // recorded clip closes on itself along with the motion.
  u.uFlowRate.value = loopFrequency(m.flow, loopSeconds);
  u.uIrid.value = m.iridescence;
  u.uFilm.value = m.filmNm;
  rawVec(m.albedo, u.uAlbedo.value as THREE.Vector3);
  rawVec(m.edgeTint || "#ffffff", u.uEdge.value as THREE.Vector3);
  u.uUseEdge.value = m.edgeTint ? 1 : 0;
}

function rawVec(hex: string, target = new THREE.Vector3()): THREE.Vector3 {
  const [r, g, b] = parseHex(hex);
  return target.set(r, g, b);
}

/** Expand a {@link ScatterConfig} into concrete items — deterministically, so the same config
 *  produces the same scene in the browser, in an export, and in a captured poster. */
export function expandScatter(scatter: ScatterConfig): ItemConfig[] {
  const rng = makeRng(scatter.seed);
  const out: ItemConfig[] = [];
  const startX = scatter.position.x - scatter.spanX / 2;
  for (let index = 0; index < scatter.count; index++) {
    const u = scatter.count > 1 ? index / (scatter.count - 1) : 0.5;
    const len = scatter.shape.len * (1 - rng() * scatter.lengthVariance);
    const r = scatter.shape.r + rng() * scatter.radiusVariance;
    const z = scatter.position.z + (rng() - 0.5) * scatter.spread;
    const jitter = (rng() - 0.5) * scatter.phaseJitter;
    out.push({
      shape: { ...scatter.shape, r, len },
      position: { x: startX + u * scatter.spanX, y: scatter.position.y, z },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      // Cloned, not shared. Every other field here is already copied; leaving this one as a
      // reference meant a BAKED scatter handed all of its items the same material object, so
      // editing one shape's IOR in the panel silently edited all of them.
      material: { ...scatter.material },
      motion: { ...scatter.motion },
      // The arrangement's stagger is baked into each shape's own phase here, rather than being
      // re-derived from the index at render time — so a baked scene animates identically to the
      // generated one it came from.
      phase: index * scatter.stagger + jitter,
      // Cloned per shape for the same reason as the material — and because binding smoothing is
      // keyed by binding-object identity, so shared binding objects would make all the generated
      // shapes ease as one instead of the hovered rod answering alone.
      ...(scatter.interaction ? { interaction: structuredClone(scatter.interaction) } : {}),
    });
  }
  return out;
}

/** The items a config describes: scatter when present, the explicit list otherwise. */
export function resolveItems(config: SceneConfig): ItemConfig[] {
  return config.scatter ? expandScatter(config.scatter) : config.items;
}

/**
 * Turn a generated scene into an authored one: expand `scatter` into a concrete `items` list and
 * drop the scatter block. The frame is pixel-identical afterwards — the same generator produced
 * the list — but every shape now has a config of its own to select, move and edit.
 *
 * Mutates in place and returns whether anything changed, so an editor can call it unconditionally
 * before a per-shape edit. A no-op on a scene that is already authored.
 */
export function bakeScatter(config: SceneConfig): boolean {
  if (!config.scatter) return false;
  config.items = expandScatter(config.scatter);
  config.scatter = undefined;
  return true;
}

/**
 * The effective vertical FOV for a canvas of aspect `aspect`, given the fov authored at
 * {@link FRAME_ASPECT}.
 *
 * Wave3D solves the same problem with a zoom multiplier because its camera is orthographic. A
 * perspective camera has no `zoom` that means "show more world" without also moving the lens, so
 * the policy is expressed as a FOV instead: scale the visible HEIGHT at the focal plane by `k`,
 * and since height = 2·d·tan(fov/2), that is `fovEff = 2·atan(k·tan(fov/2))` — exact at every
 * depth, so nothing about the perspective or the depth of field shifts.
 *
 * `k` is the visible height relative to the authored frame:
 *   cover   k = min(1, A₀/A)   crop the overflow — never reveal world beyond the frame
 *   contain k = max(1, A₀/A)   reveal beyond the frame — never crop it
 *   width   k = A₀/A           hold the horizontal composition
 *   height  k = 1              hold the vertical composition (three's own behaviour)
 *
 * At `aspect === FRAME_ASPECT` every branch gives k = 1, which is what makes this inert for the
 * 16:9 framing every preset is authored against.
 */
/** Clear colour for the back-face pass — see the note at its call site. */
const BLACK = new THREE.Color(0, 0, 0);

export function frameFov(
  fov: number,
  aspect: number,
  fit: CameraFit = "cover",
  minVisibleWidth = 0,
): number {
  const byFrame = FRAME_ASPECT / aspect;
  let k: number;
  switch (fit) {
    case "contain":
      k = Math.max(1, byFrame);
      break;
    case "width":
      k = byFrame;
      break;
    case "height":
      k = 1;
      break;
    default:
      k = Math.min(1, byFrame);
  }
  // A floor on k only ever widens the view, so it cannot tighten a fit that already shows enough.
  if (minVisibleWidth > 0) k = Math.max(k, byFrame * minVisibleWidth);
  return THREE.MathUtils.radToDeg(2 * Math.atan(k * Math.tan(THREE.MathUtils.degToRad(fov) / 2)));
}

export class MaterialRenderer implements Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly container: HTMLElement;
  private readonly ownsCanvas: boolean;
  private config: SceneConfig;
  private readonly respectReducedMotion: boolean;

  private readonly colorRT: THREE.WebGLRenderTarget;
  private readonly bgRT: THREE.WebGLRenderTarget;
  private readonly depthRT: THREE.WebGLRenderTarget;

  private readonly backdrop: THREE.Mesh;
  private readonly backdropMaterial: THREE.ShaderMaterial;
  private mediaTexture?: THREE.Texture;
  private mediaVideo?: HTMLVideoElement;
  /** URL currently loaded, so refresh() doesn't re-request the same file every frame. */
  private mediaUrl?: string;
  private readonly depthMaterial: THREE.ShaderMaterial;
  /** Same depth encoding as depthRT, but of BACK faces — the exit surface of each shape. */
  private readonly backRT: THREE.WebGLRenderTarget;
  private readonly backMaterial: THREE.ShaderMaterial;
  private readonly postMaterial: THREE.ShaderMaterial;
  private readonly postScene = new THREE.Scene();
  /** Target for the post pass when the finish pass is going to run over it. */
  private readonly postRT: THREE.WebGLRenderTarget;
  private readonly finishMaterial: THREE.ShaderMaterial;
  private readonly finishScene = new THREE.Scene();
  private readonly postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /**
   * The multi-scale bloom pyramid: four half-resolution steps, each with a ping-pong pair so the
   * separable blur can go horizontal then vertical. Allocated only when a scene asks for it —
   * eight extra targets is not a cost to impose on presets using the post pass's own gather.
   */
  private bloomLevels?: { a: THREE.WebGLRenderTarget; b: THREE.WebGLRenderTarget }[];
  private bloomExtract?: THREE.ShaderMaterial;
  private bloomBlur?: THREE.ShaderMaterial;
  private bloomComposite?: THREE.ShaderMaterial;
  private bloomDown?: THREE.ShaderMaterial;
  private particleDown?: THREE.ShaderMaterial;
  private envBake?: THREE.ShaderMaterial;
  private envBlur?: THREE.ShaderMaterial;
  private envCopy?: THREE.ShaderMaterial;
  /** The prefiltered room, mip 0 sharp and each level a wider cone. Absent while analytic. */
  private envRT?: THREE.WebGLRenderTarget;
  private envKey = "";
  private readonly bloomScene = new THREE.Scene();
  private bloomQuad?: THREE.Mesh;

  /** Airborne dust, drawn after the beam and lit by the pyramid's widest level. */
  private dustMesh?: THREE.Mesh;
  private dustMaterial?: THREE.ShaderMaterial;
  private dustKey = "";
  /** Its own scene, because dust is drawn AFTER the bloom pyramid it reads from — it cannot be
   *  part of the main pass without the pyramid depending on its own output. */
  private readonly dustScene = new THREE.Scene();

  /** The traced light beam, or undefined when the scene has no `beam`. Its geometry is rebuilt
   *  whenever the beam config changes — see {@link applyBeam}. */
  private beamMesh?: THREE.Mesh;
  private beamMaterial?: THREE.ShaderMaterial;
  /** The caustic draws the SAME geometry a second time — see CAUSTIC_FRAG. */
  private causticMesh?: THREE.Mesh;
  private causticMaterial?: THREE.ShaderMaterial;
  /** The prism's inner interface — see BACKGLASS_FRAG. */
  private backGlass?: THREE.ShaderMaterial;
  private readonly backGlassScene = new THREE.Scene();
  /** Serialized beam config the current geometry was traced from, so a refresh() that changes
   *  something else does not pay for a retrace. */
  private beamKey = "";

  /** One set of uniform holders shared by every glass material AND the backdrop, so the colour a
   *  shape refracts and the colour showing faintly around it can never drift apart. */
  private readonly lampUniforms: Record<string, THREE.IUniform>;
  private readonly lampPositions: THREE.Vector4[] = [];
  private readonly lampColors: THREE.Vector3[] = [];

  private readonly items: MaterialItem[] = [];
  /** The ItemConfig list the meshes were built from — config.items, or the ONE scatter expansion
   *  this build used (expanding again would make fresh objects and break identity). Indices into
   *  it are the interaction layer's currency for hoverSelf/pressSelf. */
  private resolvedItems: ItemConfig[] = [];
  private frameCallback: FrameCallback | null = null;

  private readonly clearColor = new THREE.Color();
  private readonly depthClearColor = new THREE.Color();
  private readonly normalScratch = new THREE.Matrix3();

  // Picking / direct manipulation scratch. Allocated once: these run on every pointer move.
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly dragPlane = new THREE.Plane();
  private readonly planeNormal = new THREE.Vector3();
  private readonly projectScratch = new THREE.Vector3();

  // Orbit state: `target*` is where the pointer put it, the unprefixed pair eases toward it.
  private yaw = 0;
  private pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private distance: number;
  private readonly listeners = new AbortController();

  private time = 0;
  private lastFrame = 0;
  private rafId = 0;
  private resizeRaf = 0;
  private running = false;
  private started = false;
  private visible = true;
  // Read, not assumed: a scene built in a background tab gets no visibilitychange for the state
  // it is already in, so an optimistic `true` here makes it believe it is animating while its
  // rAF never fires — and it then never schedules another one either.
  private pageVisible = typeof document === "undefined" || document.visibilityState === "visible";
  /** Intro ease-in: scales animation accumulation 0→1 over ~1s on load. See `step`. */
  private introRamp = 0;
  /** One full-screen quad shared by the post and finish passes; owned here so dispose() frees it. */
  private readonly screenQuad = new THREE.PlaneGeometry(2, 2);
  /** Straight copy of the colour target to the screen, for `probeActive()`. Built on first use. */
  private probeBlit?: THREE.ShaderMaterial;
  private probeScene?: THREE.Scene;
  private reducedMotion = false;
  private capturing = false;
  private disposed = false;

  // ---- Interaction layer (optional; created only when some binding list exists) ----
  /** Created by syncInteraction() when interaction turns on, disposed when it turns off. */
  private interaction?: InteractionController;
  /** Delta a `timeOffset` binding adds on top of the clock (0 at rest). */
  private interactionTime = 0;
  /** Multiplier a `cameraZoom` binding applies to the camera distance (1 at rest). */
  private interactionZoom = 1;
  /** Out-params the scene appliers write into; seeded at base each frame. */
  private readonly interactionSceneOut = {
    timeOffset: 0,
    zoom: 1,
    beamIncidence: 0,
    beamEntry: 0.5,
    orbitYaw: 0,
    orbitPitch: 0,
  };
  /** The studio's scroll scrub (null = live container progress). Kept OUTSIDE the controller so a
   *  config edit that rebuilds the controller doesn't silently drop an active scrub. */
  private scrollPreview: number | null = null;
  /** Each item's resolved material — the authored base a binding at rest restores. Refilled by
   *  refresh()/buildItems()/add() from the same resolveMaterial call that fills the uniforms. */
  private readonly baseMaterials = new WeakMap<MaterialItem, MaterialConfig>();

  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private readonly motionQuery: MediaQueryList;
  private dprQuery?: MediaQueryList;
  private lastMetrics?: { w: number; h: number; dpr: number; quality: number };
  private outputSize?: { width: number; height: number };

  constructor(
    container: HTMLElement,
    config: Partial<SceneConfig>,
    options: MaterialRendererOptions = {},
  ) {
    this.container = container;
    this.config = ensureSceneConfig(config);
    this.respectReducedMotion = options.respectReducedMotion ?? true;
    this.distance = this.config.camera.distance;

    this.ownsCanvas = !options.canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      // Requested explicitly rather than relying on the default: without it `transparentBackground`
      // has nothing to composite into and the canvas stays opaque black behind the scene.
      alpha: true,
      // Keeps the drawing buffer readable so captureImage() can produce a poster.
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
      powerPreference: "high-performance",
    });
    // The post pass writes display-referred values straight to a drawing buffer already tagged
    // sRGB; nothing in the chain is linear, so there is no output conversion to configure. This
    // is set only so a host app reading it back sees the truth.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;

    if (this.ownsCanvas) {
      const canvas = this.renderer.domElement;
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.touchAction = "none";
      container.appendChild(canvas);
    }

    const cam = this.config.camera;
    this.camera = new THREE.PerspectiveCamera(cam.fov, 1, 1, FAR);

    const rtOptions: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      // NoColorSpace: sampling these returns exactly what the previous pass stored. Anything else
      // would decode the display-space values as if they were linear.
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
    };
    // The two colour targets carry HDR when the scene tone maps.
    //
    // Without this the tone map is applied too late to matter: the main pass writes into an 8-bit
    // target, so a value above 1 is clamped PER CHANNEL before the post pass ever samples it, and
    // an over-range spectrum arrives already destroyed — magenta where red and blue both pinned,
    // cyan where green and blue did. Half-float keeps the beam's real radiance alive until there
    // is a curve to compress it with. Byte targets stay the default because every preset built
    // before tone mapping existed was calibrated against them.
    //
    // The same switch turns on MULTISAMPLING, for a related reason. `antialias: true` on the
    // renderer applies to the DEFAULT framebuffer only; a render target gets none unless it asks.
    // That is invisible for glass, whose silhouettes are large and smooth, and ruinous for a beam:
    // near the exit face adjacent wavelengths are a fraction of a unit apart, so every quad in the
    // fan is a long sub-pixel wedge, and two dozen staggered slice-fans alias against each other
    // into a comb of streaks. Four samples resolves them into one continuous sheet.
    const hdr = this.config.post.toneMap !== "none";
    const colorOptions: THREE.RenderTargetOptions = hdr
      ? { ...rtOptions, type: THREE.HalfFloatType, samples: 4 }
      : rtOptions;
    this.colorRT = new THREE.WebGLRenderTarget(1, 1, colorOptions);
    this.bgRT = new THREE.WebGLRenderTarget(1, 1, colorOptions);
    this.depthRT = new THREE.WebGLRenderTarget(1, 1, {
      ...rtOptions,
      // Nearest: the packed two-channel depth must not be interpolated — a blend of the low byte
      // of two different depths decodes to a distance that is in neither.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });

    for (let i = 0; i < MAX_LAMPS; i++) {
      this.lampPositions.push(new THREE.Vector4(0, 0, 1, 0));
      this.lampColors.push(new THREE.Vector3(1, 1, 1));
    }
    this.lampUniforms = {
      uLamp: { value: this.lampPositions },
      uLampCol: { value: this.lampColors },
      uLampCount: { value: 0 },
      uLampGain: { value: this.config.lampGain },
      // Scene-level, so they live with the lamps rather than on each item: what a reflection sees
      // where the plate does not reach is a property of the room, not of the shape.
      uStudio: { value: 0 },
      uStudioGain: { value: 1 },
      // The prefiltered room. Scene-level for the same reason the studio is: every surface in a
      // frame reflects the same room, and only the cone width differs between them.
      tEnv: { value: null },
      uEnvSize: { value: new THREE.Vector2(1, 1) },
      uEnvTexel: { value: 1 },
      uEnvLevels: { value: 1 },
      uEnvOn: { value: 0 },
      uLampLo: { value: this.config.lampGate.lo },
      uLampHi: { value: this.config.lampGate.hi },
    };
    this.applyLamps(this.config.lamps);

    this.backdropMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...this.lampUniforms,
        uTop: { value: new THREE.Vector3() },
        uBot: { value: new THREE.Vector3() },
        uShow: { value: this.config.backdropLamps },
        uSize: { value: new THREE.Vector2(160, 110) },
        uPlateScale: { value: new THREE.Vector2() },
        uPlateOffset: { value: new THREE.Vector2() },
        uMode: { value: 0 },
        // Wall mode. Defaults are DEFAULT_LIGHT_MODE_CONTROLS.wall from the reference.
        uWallExtent: { value: new THREE.Vector2(1, 1) },
        uWallLightUv: { value: new THREE.Vector2(0.62, 0.34) },
        uWallPrism: { value: new THREE.Vector2(0, 0) },
        uWallLightDir: { value: new THREE.Vector3(-0.45, 0.5, 0.74) },
        uWallScale: { value: 1 / 2.4 },
        uWallNormal: { value: 0.22 },
        // Their wall tuning: the micro field runs seven times faster than the large one and is
        // nearly five times stronger, because it is the surface and the large scale is only the
        // wall not being flat.
        uWallMicroFreq: { value: 7 },
        uWallMicroNormal: { value: 1.05 },
        uWallGamma: { value: 0.65 },
        uWallContrast: { value: 6.85 },
        uWallPivot: { value: 0.9 },
        uWallFloor: { value: 0.87 },
        uWallHighlight: { value: 3.31 },
        uWallAmbient: { value: 0.42 },
        uWallAmbientLight: { value: 0.1 },
        uWallShadow: { value: 0.55 },
        // Up to four footprints, which is what a wall scene reasonably stands in front of.
        uGround: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
        uGroundPhase: { value: [0, 0, 0, 0] },
        uGroundCount: { value: 0 },
        uWallGrounding: { value: 0.85 },
        uStop: {
          value: Array.from({ length: MAX_STOPS }, () => new THREE.Vector4()),
        },
        uStopCount: { value: 0 },
        uGradType: { value: 0 },
        uAngle: { value: 0 },
        uMesh: {
          value: Array.from({ length: MAX_MESH_POINTS }, () => new THREE.Vector4()),
        },
        uMeshCol: {
          value: Array.from({ length: MAX_MESH_POINTS }, () => new THREE.Vector3()),
        },
        uMeshCount: { value: 0 },
        uMeshSoft: { value: 0.55 },
        tImage: { value: null },
        uHasImage: { value: 0 },
        uImageFit: { value: 0 },
        uImageZoom: { value: 1 },
        uImageAspect: { value: 1 },
        uImageOffset: { value: new THREE.Vector2(0.5, 0.5) },
        uFrame: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
      // Compile-time bounds: GLSL ES 1.00 wants constant loop limits, and a wall scene has no
      // reason to stand in front of more than a handful of solids.
      defines: { GROUND_SLOTS: "4", GROUND_MAX_SIDES: "8" },
      depthWrite: true,
    });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.backdropMaterial);
    this.scene.add(this.backdrop);

    this.depthMaterial = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
    });

    this.backRT = new THREE.WebGLRenderTarget(1, 1, rtOptions);
    this.backMaterial = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      side: THREE.BackSide,
    });

    this.postMaterial = new THREE.ShaderMaterial({
      defines: this.postDefines(),
      uniforms: {
        tColor: { value: this.colorRT.texture },
        tDepth: { value: this.depthRT.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uHazeCol: { value: new THREE.Vector3() },
        uFocus: { value: 0 },
        uRange: { value: 1 },
        uAperture: { value: 0 },
        uBloom: { value: 0 },
        uCaustics: { value: 0 },
        uHaze: { value: 0 },
        uHazeTop: { value: 0 },
        uVignette: { value: 0 },
        uGrain: { value: 0 },
        uTime: { value: 0 },
        uScale: { value: 1 },
        uTransparent: { value: 0 },
        uBloomRadius: { value: 9 },
        uBloomThresh: { value: 0 },
        uToneMap: { value: 0 },
        tBloom: { value: null },
        uBloomMode: { value: 0 },
        uMirror: { value: new THREE.Vector2() },
      },
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.postScene.add(new THREE.Mesh(this.screenQuad, this.postMaterial));

    this.postRT = new THREE.WebGLRenderTarget(1, 1, rtOptions);
    this.finishMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.postRT.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uInner: { value: 0 },
        uInnerDensity: { value: 0.5 },
        uInnerDecay: { value: 0.94 },
        uInnerCentre: { value: new THREE.Vector2(0.5, 0.15) },
        uDither: { value: 0 },
        uDitherScale: { value: 2 },
        uDitherSteps: { value: 4 },
        uHalftone: { value: 0 },
        uHalftoneCell: { value: 6 },
        uHalftoneAngle: { value: 0.4 },
        uCmyk: { value: 0 },
        uCmykCell: { value: 6 },
        uPaper: { value: 0 },
        uPaperScale: { value: 2 },
      },
      vertexShader: FINISH_VERT,
      fragmentShader: FINISH_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.finishScene.add(new THREE.Mesh(this.screenQuad, this.finishMaterial));

    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = this.respectReducedMotion && this.motionQuery.matches;
    this.motionQuery.addEventListener("change", this.onMotionChange, {
      signal: this.listeners.signal,
    });
    document.addEventListener("visibilitychange", this.onVisibilityChange, {
      signal: this.listeners.signal,
    });
    this.renderer.domElement.addEventListener("webglcontextlost", this.onContextLost, {
      signal: this.listeners.signal,
    });
    this.renderer.domElement.addEventListener("webglcontextrestored", this.onContextRestored, {
      signal: this.listeners.signal,
    });

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        this.visible = entries[0]?.isIntersecting ?? true;
        this.updateRunning();
      },
      { rootMargin: "100px" },
    );
    this.intersectionObserver.observe(container);

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(container);
    this.watchDpr(); // the CSS box can stay put while devicePixelRatio moves under it

    this.bindOrbit();
    this.buildItems();
    this.refresh();
    this.resize();
  }

  // ---------------------------------------------------------------- scene ---

  private postDefines(): Record<string, string> {
    // Fewer taps below full quality: at that point the frame is already soft, and 24 gathers ×
    // two textures is the most expensive thing in the pass.
    const taps = this.config.quality >= 0.85 ? 24 : this.config.quality >= 0.6 ? 16 : 10;
    return { DOF_TAPS: String(taps), CAUSTIC_TAPS: this.config.quality >= 0.6 ? "10" : "6" };
  }

  private makeMaterial(material: Partial<MaterialConfig>, shapePath: number): THREE.ShaderMaterial {
    const m = resolveMaterial({ path: shapePath, ...material });
    const shader = new THREE.ShaderMaterial({
      uniforms: {
        ...this.lampUniforms,
        tBg: { value: null },
        tBack: { value: this.backRT.texture },
        uThick: { value: this.config.measuredThickness ? 1 : 0 },
        uPass: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uNormalMat: { value: new THREE.Matrix3() },
        uClearCol: { value: rawVec(this.config.clearGlass) },
        uPlateScale: { value: new THREE.Vector2() },
        uPlateOffset: { value: new THREE.Vector2() },
        uPlaneZ: { value: this.config.plate.z },
        // The per-material uniforms: allocated empty here, filled by pushMaterialUniforms —
        // the same single list `refresh()` uses, so creation and update can never drift.
        uTint: { value: new THREE.Vector3() },
        uUseTint: { value: 0 },
        uDisp: { value: 0 },
        uLens: { value: 0 },
        uSigma: { value: 0 },
        uAbsorb: { value: new THREE.Vector3() },
        uUseAbsorb: { value: 0 },
        uIOR: { value: 0 },
        uPath: { value: 0 },
        uPrism: { value: 0 },
        uPrismPlanes: {
          value: Array.from({ length: 6 }, () => new THREE.Vector4()),
        },
        uPrismPlaneCount: { value: 0 },
        uViewProj: { value: new THREE.Matrix4() },
        uRim: { value: 0 },
        uSpec: { value: 0 },
        uSat: { value: 0 },
        uHue: { value: 0 },
        uEmis: { value: 0 },
        uKind: { value: 0 },
        uRough: { value: 0 },
        uSparkle: { value: 0 },
        uSparkleScale: { value: 0 },
        uRipple: { value: 0 },
        uRippleScale: { value: 0 },
        uFlowRate: { value: 0 },
        uTime: { value: 0 },
        uIrid: { value: 0 },
        uFilm: { value: 0 },
        uAlbedo: { value: new THREE.Vector3() },
        uEdge: { value: new THREE.Vector3() },
        uUseEdge: { value: 0 },
        uAspect: { value: 1 },
        uConeTransmission: { value: this.config.transmission === "cone" ? 1 : 0 },
        uProbe: { value: 0 },
      },
      // Eleven, the reference's count. It is a compile-time constant rather than a uniform because
      // GLSL ES 1.00 wants a constant loop bound, and because a scene has no reason to change it
      // per material — the cone's WIDTH is what varies, and that comes from roughness.
      defines: { CONE_SAMPLES: "11" },
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    pushMaterialUniforms(shader.uniforms, m, this.config.loopSeconds);
    return shader;
  }

  /**
   * Add a shape built elsewhere — the escape hatch for scenes that are easier to write as code
   * than as config. `material.path` defaults to the item's own radius, which is right for a rod
   * and wrong for anything squat, so pass it for discs and rings (see the shapes module).
   */
  add(geometry: THREE.BufferGeometry, options: AddOptions = {}): MaterialItem {
    const fallbackPath = options.material?.path ?? 0.4;
    const material = this.makeMaterial(options.material ?? {}, fallbackPath);
    const mesh = new THREE.Mesh(geometry, material);
    if (options.position) mesh.position.set(...options.position);
    if (options.rotationOrder) mesh.rotation.order = options.rotationOrder;
    if (options.rotation) mesh.rotation.set(...options.rotation);
    if (options.scale !== undefined) {
      const s = options.scale;
      if (typeof s === "number") mesh.scale.set(s, s, s);
      else mesh.scale.set(...s);
    }
    this.scene.add(mesh);
    const item: MaterialItem = {
      mesh,
      material,
      config: null,
      motion: normalizeMotion(options.motion),
      phase: options.phase ?? 0,
      home: mesh.position.clone(),
      homeRotation: mesh.rotation.clone(),
      homeScale: mesh.scale.clone(),
      data: options.data ?? {},
    };
    this.items.push(item);
    this.baseMaterials.set(item, resolveMaterial({ path: fallbackPath, ...options.material }));
    this.applyPlateUniforms(material);
    return item;
  }

  /** Remove one item and release its GPU resources. */
  remove(item: MaterialItem): void {
    const index = this.items.indexOf(item);
    if (index < 0) return;
    this.items.splice(index, 1);
    this.scene.remove(item.mesh);
    item.mesh.geometry.dispose();
    item.material.dispose();
  }

  /** Remove every item. The backdrop, camera and post stack stay. */
  clear(): void {
    while (this.items.length > 0) this.remove(this.items[this.items.length - 1]);
  }

  private buildItems(): void {
    this.clear();
    // NOT normalized per item here. `ensureSceneConfig` already normalized `config.items` on the
    // way in, and normalizing again would return COPIES — which is fatal for direct manipulation:
    // an editor dragging a shape writes to `item.config`, and if that is a copy the move survives
    // in the viewport but is lost on save, undo and reload. Identity is the contract.
    //
    // The resolved list is RETAINED, not just iterated: a scatter expands to fresh ItemConfig
    // objects on every call, and the interaction layer trades in indices into this exact list
    // (hoverSelf/pressSelf hit → binding smoothing), so hit test and controller must read the
    // one expansion the meshes were built from.
    this.resolvedItems = resolveItems(this.config);
    for (const item of this.resolvedItems) {
      const geometry = buildShape(item.shape);
      const material = this.makeMaterial(item.material, defaultPath(item.shape));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(item.position.x, item.position.y, item.position.z);
      mesh.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
      mesh.scale.set(item.scale.x, item.scale.y, item.scale.z);
      this.scene.add(mesh);
      const built: MaterialItem = {
        mesh,
        material,
        config: item,
        motion: item.motion,
        phase: item.phase,
        home: mesh.position.clone(),
        homeRotation: mesh.rotation.clone(),
        homeScale: mesh.scale.clone(),
        data: {},
      };
      this.items.push(built);
      this.baseMaterials.set(
        built,
        resolveMaterial({ path: defaultPath(item.shape), ...item.material }),
      );
    }
  }

  // ----------------------------------------------------------- uniform push ---

  private applyLamps(lamps: LampConfig[]): void {
    const count = Math.min(lamps.length, MAX_LAMPS);
    for (let i = 0; i < MAX_LAMPS; i++) {
      const lamp = lamps[i];
      if (!lamp || i >= count) {
        this.lampPositions[i].set(0, 0, 1, 0);
        continue;
      }
      this.lampPositions[i].set(lamp.x, lamp.y, lamp.r, lamp.intensity);
      rawVec(lamp.color, this.lampColors[i]);
    }
    this.lampUniforms.uLampCount.value = count;
  }

  /** Replace the lamp field. Every material shares these uniforms, so one call updates the
   *  glass and the backdrop together. */
  setLamps(lamps: LampConfig[]): this {
    this.config.lamps = lamps.slice(0, MAX_LAMPS);
    this.applyLamps(this.config.lamps);
    this.renderIfIdle();
    return this;
  }

  /** Merge post-processing settings. */
  setPost(post: Partial<PostConfig>): this {
    this.config.post = { ...this.config.post, ...post };
    this.applyPost();
    this.renderIfIdle();
    return this;
  }

  // ------------------------------------------------------------- interaction ---

  /** Create/dispose the interaction controller as config toggles it on/off. Called from
   *  refresh(), so editing bindings in and out needs no separate wiring. */
  private syncInteraction(): void {
    const active = interactionActive(this.config);
    if (active && !this.interaction) {
      // The resolved-list accessor keeps the controller iterating the SAME ItemConfig objects the
      // meshes were built from, so scatter-generated shapes smooth and hit-test like authored ones.
      this.interaction = new InteractionController(
        this.container,
        () => this.config,
        () => this.resolvedItems,
      );
      // Re-apply an active studio scrub, so adding the FIRST scroll binding responds to the
      // preview slider immediately instead of waiting for the next drag.
      this.interaction.scrollOverride = this.scrollPreview;
    } else if (!active && this.interaction) {
      this.interaction.dispose();
      this.interaction = undefined;
      this.interactionTime = 0;
      this.interactionZoom = 1;
    }
  }

  /** Per-frame binding write. No-op without a controller. While capturing it writes the REST
   *  state instead (every bound param at its authored base) — merely skipping the write would
   *  freeze whatever live hover/scroll state the previous frame left in the uniforms, so exports
   *  wouldn't be deterministic. */
  private applyInteraction(): void {
    // Seed the out-params from config BEFORE any early return. They are read unconditionally after
    // this — the beam retrace reads beamIncidence/beamEntry every frame — so a scene with no
    // interaction layer at all would otherwise be driven by their initial zeroes, silently
    // overriding whatever the config authored.
    const c = this.config;
    this.interactionSceneOut.timeOffset = c.timeOffset;
    this.interactionSceneOut.zoom = 1;
    this.interactionSceneOut.beamIncidence = c.beam?.incidence ?? 0;
    this.interactionSceneOut.beamEntry = c.beam?.entry ?? 0.5;
    this.interactionSceneOut.orbitYaw = 0;
    this.interactionSceneOut.orbitPitch = 0;
    if (!this.interaction) return;
    if (this.capturing) {
      this.applyInteractionRest();
      return;
    }
    this.applyBindings(this.interaction);
  }

  /** Evaluate bindings via the applier tables: value = mix(from ?? base, to, smoothedSource).
   *  Scene bindings drive shared params; each shape's and lamp's bindings drive their own. */
  private applyBindings(ic: InteractionController): void {
    const c = this.config;
    // Seed the out-params at base; appliers overwrite only what they drive, so with no scene
    // binding these stay at rest → interactionTime 0 / interactionZoom 1.
    this.interactionSceneOut.timeOffset = c.timeOffset;
    this.interactionSceneOut.zoom = 1;
    this.interactionSceneOut.beamIncidence = c.beam?.incidence ?? 0;
    this.interactionSceneOut.beamEntry = c.beam?.entry ?? 0.5;
    this.interactionSceneOut.orbitYaw = 0;
    this.interactionSceneOut.orbitPitch = 0;
    const sceneArgs = {
      post: this.postMaterial.uniforms,
      lamps: this.lampUniforms,
      out: this.interactionSceneOut,
    };
    for (const b of c.interaction?.bindings ?? []) {
      const applier = SCENE_APPLIERS[b.target];
      const value = THREE.MathUtils.lerp(b.from ?? applier.base(c), b.to, ic.bindingValue(b));
      applier.apply(value, sceneArgs);
    }
    const lampCount = Math.min(c.lamps.length, MAX_LAMPS);
    for (let i = 0; i < lampCount; i++) {
      const bindings = c.lamps[i].bindings;
      if (!bindings || bindings.length === 0) continue;
      const args = { vec: this.lampPositions[i] };
      for (const b of bindings) {
        const applier = LAMP_APPLIERS[b.target];
        const value = THREE.MathUtils.lerp(
          b.from ?? applier.base(c.lamps[i]),
          b.to,
          ic.bindingValue(b),
        );
        applier.apply(value, args);
      }
    }
    for (const item of this.items) {
      const bindings = item.config?.interaction?.bindings;
      if (!bindings || bindings.length === 0) continue;
      const base = this.baseMaterials.get(item);
      if (!base) continue;
      const args = { u: item.material.uniforms, mesh: item.mesh, home: item.home };
      for (const b of bindings) {
        const applier = ITEM_APPLIERS[b.target];
        const value = THREE.MathUtils.lerp(
          b.from ?? applier.base(base, item.home),
          b.to,
          ic.bindingValue(b),
        );
        applier.apply(value, args);
      }
    }
    // The time offset is a DELTA over the authored one; the zoom is a plain multiplier.
    this.interactionTime = this.interactionSceneOut.timeOffset - c.timeOffset;
    this.interactionZoom = this.interactionSceneOut.zoom;
  }

  /** Write the capture-frame interaction state: exactly what this config renders with no input —
   *  every bound param at its authored base. Live controller state is left untouched, so the
   *  frame after a capture resumes mid-gesture. */
  private applyInteractionRest(): void {
    const c = this.config;
    this.interactionTime = 0;
    this.interactionZoom = 1;
    this.interactionSceneOut.timeOffset = c.timeOffset;
    this.interactionSceneOut.zoom = 1;
    this.interactionSceneOut.beamIncidence = c.beam?.incidence ?? 0;
    this.interactionSceneOut.beamEntry = c.beam?.entry ?? 0.5;
    const sceneArgs = {
      post: this.postMaterial.uniforms,
      lamps: this.lampUniforms,
      out: this.interactionSceneOut,
    };
    for (const b of c.interaction?.bindings ?? []) {
      const applier = SCENE_APPLIERS[b.target];
      applier.apply(applier.base(c), sceneArgs);
    }
    const lampCount = Math.min(c.lamps.length, MAX_LAMPS);
    for (let i = 0; i < lampCount; i++) {
      const bindings = c.lamps[i].bindings;
      if (!bindings || bindings.length === 0) continue;
      const args = { vec: this.lampPositions[i] };
      for (const b of bindings) {
        const applier = LAMP_APPLIERS[b.target];
        applier.apply(applier.base(c.lamps[i]), args);
      }
    }
    for (const item of this.items) {
      const bindings = item.config?.interaction?.bindings;
      if (!bindings || bindings.length === 0) continue;
      const base = this.baseMaterials.get(item);
      if (!base) continue;
      const args = { u: item.material.uniforms, mesh: item.mesh, home: item.home };
      for (const b of bindings) {
        const applier = ITEM_APPLIERS[b.target];
        applier.apply(applier.base(base, item.home), args);
      }
    }
  }

  /** Scratch state for updateItemHover — reused every frame, never reallocated. */
  private readonly hoverCandidates: THREE.Object3D[] = [];
  private readonly hoverNdc = new THREE.Vector2();

  /** Resolve the `hoverSelf` source: raycast the cursor against the shapes that bind it and
   *  report the nearest hit's CONFIG index to the controller. Skipped entirely (no raycast)
   *  when nothing binds hoverSelf. */
  private updateItemHover(ic: InteractionController): void {
    // hoverSelf tracks the live cursor; skipped (no raycast) when nothing binds it.
    if (this.collectHitCandidates("hoverSelf")) {
      ic.setHoverItem(this.resolveItemHit(ic.pointerTarget()));
    }
    // pressSelf resolves the latched pointerdown position, once per down. A pending press must
    // always be consumed — even when nothing binds pressSelf — or it would wait forever.
    const pressNdc = ic.pendingPress();
    if (pressNdc) {
      this.collectHitCandidates("pressSelf");
      ic.setPressItem(this.resolveItemHit(pressNdc));
    }
  }

  /** Fill the scratch candidate list with the meshes whose bindings use `source`. */
  private collectHitCandidates(source: "hoverSelf" | "pressSelf"): boolean {
    const candidates = this.hoverCandidates;
    candidates.length = 0;
    for (const item of this.items) {
      if (item.config?.interaction?.bindings?.some((b) => b.source === source)) {
        candidates.push(item.mesh);
      }
    }
    return candidates.length > 0;
  }

  /** Raycast `ndc` against the collected candidates; the nearest hit's index into the RESOLVED
   *  item list (the controller's index space — covers scatter-generated shapes), or null. */
  private resolveItemHit(ndc: { x: number; y: number } | null): number | null {
    if (!ndc || this.hoverCandidates.length === 0) return null;
    this.hoverNdc.set(ndc.x, ndc.y);
    this.raycaster.setFromCamera(this.hoverNdc, this.camera);
    const hit = this.raycaster.intersectObjects(this.hoverCandidates, false)[0];
    if (!hit) return null;
    const item = this.items.find((entry) => entry.mesh === hit.object);
    const index = item?.config ? this.resolvedItems.indexOf(item.config) : -1;
    return index >= 0 ? index : null;
  }

  /** Feed a `custom:<name>` interaction input (developer API — drive any binding from your own
   *  signal each frame). No-op while the interaction layer is off. */
  setInteractionInput(name: string, value: number): this {
    this.interaction?.setInput(name, value);
    return this;
  }

  /**
   * Studio scroll preview: override the scroll signal (0..1), or null to resume the real
   * container-progress read. NEVER touches config; survives the controller being rebuilt.
   *
   * The scrub applies immediately, whether or not the loop is "running": the browser fully
   * SUSPENDS requestAnimationFrame whenever the tab isn't foreground, so a "running" loop can be
   * frozen and a deferred scrub would look dead. snapScroll() resolves just the scroll bindings,
   * leaving live pointer/press state untouched.
   */
  setScrollPreview(value: number | null): this {
    this.scrollPreview = value === null ? null : THREE.MathUtils.clamp(value, 0, 1);
    if (this.interaction) {
      this.interaction.scrollOverride = this.scrollPreview;
      this.interaction.snapScroll();
      if (this.running) this.renderOnce();
      else this.seek(this.time);
    }
    return this;
  }

  /**
   * Feed a live scroll position (0..1) from a real scrollable surface (the studio's scroll-test
   * overlay). Unlike setScrollPreview's instant snap (built for a slider and a possibly-frozen
   * loop), this leaves the RUNNING render loop's update() to smooth the bindings and derive
   * `scrollVelocity` from the real scroll delta — the scene reacts exactly as it would on a
   * scrolling page, velocity included. Falls back to a snapped frame when the loop isn't running.
   */
  setScrollTestProgress(value: number): this {
    this.scrollPreview = THREE.MathUtils.clamp(value, 0, 1);
    if (!this.interaction) return this;
    this.interaction.scrollOverride = this.scrollPreview;
    if (!this.running) {
      this.interaction.snapScroll();
      this.seek(this.time);
    }
    return this;
  }

  private applyPlateUniforms(material: THREE.ShaderMaterial): void {
    const { plate } = this.config;
    (material.uniforms.uPlateScale.value as THREE.Vector2).set(plate.scale.x, plate.scale.y);
    (material.uniforms.uPlateOffset.value as THREE.Vector2).set(plate.offset.x, plate.offset.y);
    material.uniforms.uPlaneZ.value = plate.z;
    rawVec(this.config.clearGlass, material.uniforms.uClearCol.value as THREE.Vector3);
  }

  /**
   * Push the painted-backdrop config into the backdrop material.
   *
   * Colours go in raw, the same way every other Materials3D colour does — `parseHex` straight into a
   * Vector3, never through THREE.Color, which would linearize them and wash the gradient out.
   */
  /**
   * Where each solid meets the wall, for the contact shadow.
   *
   * The footprint is the shape's own cross-section — a regular polygon for a prism or hex, a
   * circle for every other lathe — placed at the item's world position. It was previously a single
   * disc pinned to the origin, which is wrong twice over in any scene with more than one solid or
   * with a solid that is not in the middle: `cascade` had one circular shadow under the gap
   * between its three shapes.
   */
  private applyGrounding(): void {
    const u = this.backdropMaterial.uniforms;
    if (!u.uGround) return;
    const slots = u.uGround.value as THREE.Vector4[];
    const phases = u.uGroundPhase.value as number[];
    let count = 0;
    for (const item of this.items) {
      if (count >= slots.length) break;
      const shape = item.config?.shape;
      if (!shape) continue;
      const faceted = shape.kind === "prism" || shape.kind === "hex";
      const sides = shape.kind === "hex" ? 6 : faceted ? Math.max(3, shape.sides) : 0;
      // The apothem, not the circumradius: the shadow's edge follows the FACES, and using the
      // corner distance inflates a triangle's footprint by a factor of two.
      const apothem = faceted ? shape.r * Math.cos(Math.PI / sides) : shape.r;
      slots[count].set(item.mesh.position.x, item.mesh.position.y, apothem, sides);
      phases[count] = Math.PI / 2 + item.mesh.rotation.z;
      count++;
    }
    u.uGroundCount.value = count;
  }

  private applyBackground(): void {
    const c = this.config;
    const bg = this.backdropMaterial.uniforms;
    bg.uMode.value = BACKGROUND_MODES.indexOf(c.backgroundMode);
    if (c.backgroundMode === "wall") {
      // The wall spans whatever the camera sees of it, same derivation the beam uses so the two
      // agree about where the light lands.
      const extent = this.beamWallExtent(this.config.beam?.z ?? 0);
      (bg.uWallExtent.value as THREE.Vector2).copy(extent);
    }

    const stops = bg.uStop.value as THREE.Vector4[];
    const count = Math.min(c.backgroundPalette.length, MAX_STOPS);
    for (let i = 0; i < count; i++) {
      const stop = c.backgroundPalette[i];
      const [sr, sg, sb] = parseHex(stop.color);
      stops[i].set(sr, sg, sb, stop.position);
    }
    bg.uStopCount.value = count;

    const types: GradientType[] = ["linear", "radial", "conic", "mesh"];
    bg.uGradType.value = Math.max(0, types.indexOf(c.backgroundGradientType));
    bg.uAngle.value = c.backgroundGradientAngle;

    const mesh = bg.uMesh.value as THREE.Vector4[];
    const meshCol = bg.uMeshCol.value as THREE.Vector3[];
    const meshCount = Math.min(c.backgroundMeshPoints.length, MAX_MESH_POINTS);
    for (let i = 0; i < meshCount; i++) {
      const point = c.backgroundMeshPoints[i];
      mesh[i].set(point.x, point.y, 0, 0);
      const [mr, mg, mb] = parseHex(point.color);
      meshCol[i].set(mr, mg, mb);
    }
    bg.uMeshCount.value = meshCount;
    bg.uMeshSoft.value = c.backgroundMeshSoftness;

    bg.uImageFit.value =
      c.backgroundImageFit === "contain" ? 1 : c.backgroundImageFit === "stretch" ? 2 : 0;
    bg.uImageZoom.value = c.backgroundImageZoom;
    (bg.uImageOffset.value as THREE.Vector2).set(
      c.backgroundImagePosition.x,
      c.backgroundImagePosition.y,
    );
    this.syncBackgroundMedia();
  }

  /**
   * Load (or drop) the backdrop image / video to match the config.
   *
   * A video takes precedence over a still when both are set. Loading is keyed on the URL so a
   * slider drag — which calls refresh() on every frame — doesn't re-request the same file.
   */
  private syncBackgroundMedia(): void {
    const c = this.config;
    const wanted =
      c.backgroundMode === "image" ? (c.backgroundVideoUrl ?? c.backgroundImageUrl) : undefined;
    if (wanted === this.mediaUrl) return;
    this.mediaUrl = wanted;
    this.disposeMedia();
    const bg = this.backdropMaterial.uniforms;
    if (!wanted) {
      bg.tImage.value = null;
      bg.uHasImage.value = 0;
      return;
    }

    if (c.backgroundVideoUrl && wanted === c.backgroundVideoUrl) {
      const video = document.createElement("video");
      video.src = wanted;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      const texture = new THREE.VideoTexture(video);
      // Display-space throughout, like every other colour source here.
      texture.colorSpace = THREE.NoColorSpace;
      this.mediaVideo = video;
      this.mediaTexture = texture;
      video.addEventListener("loadedmetadata", () => {
        bg.uImageAspect.value = video.videoWidth / Math.max(1, video.videoHeight);
        this.renderIfIdle();
      });
      void video.play().catch(() => {
        // Autoplay can be refused; the first frame still shows once metadata lands.
      });
      bg.tImage.value = texture;
      bg.uHasImage.value = 1;
      return;
    }

    new THREE.TextureLoader().load(wanted, (texture) => {
      // A late load must not overwrite a newer one.
      if (this.mediaUrl !== wanted) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      this.mediaTexture = texture;
      bg.tImage.value = texture;
      bg.uHasImage.value = 1;
      bg.uImageAspect.value = texture.image.width / Math.max(1, texture.image.height);
      this.renderIfIdle();
    });
  }

  private disposeMedia(): void {
    this.mediaTexture?.dispose();
    this.mediaTexture = undefined;
    if (this.mediaVideo) {
      this.mediaVideo.pause();
      this.mediaVideo.removeAttribute("src");
      this.mediaVideo.load();
      this.mediaVideo = undefined;
    }
  }

  private applyPost(): void {
    const p = this.config.post;
    const u = this.postMaterial.uniforms;
    u.uFocus.value = p.focus;
    u.uRange.value = p.range;
    u.uAperture.value = p.aperture;
    u.uBloom.value = p.bloom;
    u.uCaustics.value = p.caustics;
    u.uHaze.value = p.haze;
    u.uHazeTop.value = p.hazeTop;
    u.uVignette.value = p.vignette;
    u.uGrain.value = p.grain;
    u.uBloomRadius.value = p.bloomRadius;
    u.uBloomThresh.value = p.bloomThreshold;
    u.uToneMap.value = TONE_MAPS.indexOf(p.toneMap);
    (u.uMirror.value as THREE.Vector2).set(
      this.config.mirrorH ? 1 : 0,
      this.config.mirrorV ? 1 : 0,
    );
    rawVec(p.hazeColor, u.uHazeCol.value as THREE.Vector3);

    const f = this.finishMaterial.uniforms;
    f.uInner.value = p.innerLight;
    f.uInnerDensity.value = p.innerLightDensity;
    f.uInnerDecay.value = p.innerLightDecay;
    (f.uInnerCentre.value as THREE.Vector2).set(p.innerLightX, p.innerLightY);
    f.uDither.value = p.dither;
    f.uDitherScale.value = p.ditherScale;
    f.uDitherSteps.value = p.ditherSteps;
    f.uHalftone.value = p.halftone;
    f.uHalftoneCell.value = p.halftoneCell;
    f.uHalftoneAngle.value = p.halftoneAngle;
    f.uCmyk.value = p.halftoneCmyk;
    f.uCmykCell.value = p.halftoneCmykCell;
    f.uPaper.value = p.paperTexture;
    f.uPaperScale.value = p.paperTextureScale;
  }

  /**
   * Whether any finish-pass effect is actually on. When none is, the post pass draws straight to
   * the screen exactly as it did before the pass existed — no extra target, no extra draw.
   */
  private needsFinish(): boolean {
    const p = this.config.post;
    return (
      p.innerLight > 0.001 ||
      p.dither > 0.001 ||
      p.halftone > 0.001 ||
      p.halftoneCmyk > 0.001 ||
      p.paperTexture > 0.001
    );
  }

  /** Push every non-structural config value into the live uniforms. Cheap enough to call on each
   *  slider drag; structural changes (item list, quality) go through {@link setConfig}. */
  refresh(): void {
    const c = this.config;
    this.applyLamps(c.lamps);
    this.lampUniforms.uLampGain.value = c.lampGain;
    this.lampUniforms.uStudio.value = STUDIO_KINDS.indexOf(c.studio);
    this.lampUniforms.uStudioGain.value = c.studioGain;
    this.lampUniforms.uLampLo.value = c.lampGate.lo;
    this.lampUniforms.uLampHi.value = c.lampGate.hi;

    // The backdrop is the thing transparency removes: with it hidden, the gaps between shapes
    // clear to alpha 0 and the plate pass's own background samples read as invalid depth, so glass
    // over empty space correctly falls back to `clearGlass` rather than sampling a stale frame.
    this.backdrop.visible = !c.transparentBackground;
    this.postMaterial.uniforms.uTransparent.value = c.transparentBackground ? 1 : 0;

    const bg = this.backdropMaterial.uniforms;
    bg.uShow.value = c.backdropLamps;
    (bg.uPlateScale.value as THREE.Vector2).set(c.plate.scale.x, c.plate.scale.y);
    (bg.uPlateOffset.value as THREE.Vector2).set(c.plate.offset.x, c.plate.offset.y);
    // The backdrop is a gentle vertical gradient around the background colour: a touch darker at
    // the top, a touch warmer at the bottom. Deriving it keeps `background` a single knob.
    const [r, g, b] = parseHex(c.background);
    (bg.uTop.value as THREE.Vector3).set(r * 0.958, g * 0.958, b * 0.96);
    (bg.uBot.value as THREE.Vector3).set(
      Math.min(1, r * 1.005),
      Math.min(1, g * 1.002),
      Math.min(1, b * 0.995),
    );
    this.buildEnvironment();
    this.applyEnvironmentUniforms();
    this.applyBackground();
    this.applyBeam();
    this.applyBloom();
    this.applyDust();
    this.backdrop.position.z = c.plate.z - 14;

    for (const item of this.items) {
      this.applyPlateUniforms(item.material);
      if (!item.config) {
        this.applyPrismPlanes(item);
        continue;
      }
      // Re-apply the authored pose. Motions read from `home`/`homeRotation` rather than
      // accumulating, so moving a shape mid-animation lands exactly where the config says.
      const { position, rotation, scale } = item.config;
      item.home.set(position.x, position.y, position.z);
      item.homeRotation.set(rotation.x, rotation.y, rotation.z);
      item.mesh.position.copy(item.home);
      item.mesh.rotation.copy(item.homeRotation);
      item.homeScale.set(scale.x, scale.y, scale.z);
      item.mesh.scale.copy(item.homeScale);
      // AFTER the pose, not before it. The planes are world-space and derived from the mesh's
      // matrix, so computing them first hands the tracer the shape's PREVIOUS position: a solid
      // moved away from the origin gets planes still sitting at it, every refracted ray misses the
      // interior, and the glass renders as a blown-out white silhouette.
      this.applyPrismPlanes(item);
      item.phase = item.config.phase;
      item.motion = item.config.motion;
      const m = resolveMaterial({ path: defaultPath(item.config.shape), ...item.config.material });
      const u = item.material.uniforms;
      pushMaterialUniforms(u, m, c.loopSeconds);
      u.uThick.value = c.measuredThickness ? 1 : 0;
      if (u.uConeTransmission) u.uConeTransmission.value = c.transmission === "cone" ? 1 : 0;
      // Dev only; see the probe in GLASS_FRAG. Never set outside a harness.
      if (u.uProbe)
        u.uProbe.value = Number((globalThis as Record<string, unknown>)["__glslProbe"] ?? 0);
      this.baseMaterials.set(item, m);
    }
    // AFTER the loop: footprints are read off the meshes, which only carry the authored pose once
    // the loop above has copied it onto them.
    this.applyGrounding();

    this.applyPost();
    this.applyFov();
    this.syncInteraction();
  }

  // ---------------------------------------------------------------- sizing ---

  /** Push the authored fov through the framing policy for the camera's current aspect. */
  private applyFov(): void {
    const cam = this.config.camera;
    this.camera.fov = frameFov(cam.fov, this.camera.aspect, cam.fit, cam.minVisibleWidth);
    this.camera.updateProjectionMatrix();
  }

  private metrics(): { w: number; h: number; dpr: number; quality: number } {
    return {
      w: this.outputSize?.width ?? Math.max(1, this.container.clientWidth || 1),
      h: this.outputSize?.height ?? Math.max(1, this.container.clientHeight || 1),
      dpr: this.outputSize ? 1 : Math.min(window.devicePixelRatio || 1, this.config.dprMax),
      quality: this.config.quality,
    };
  }

  resize(): void {
    const { w, h, dpr, quality } = this.metrics();
    this.lastMetrics = { w, h, dpr, quality };

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, this.ownsCanvas);
    this.camera.aspect = w / h;
    this.applyFov();

    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    const rw = Math.max(1, Math.round(pw * quality));
    const rh = Math.max(1, Math.round(ph * quality));
    this.colorRT.setSize(rw, rh);
    this.backRT.setSize(rw, rh);
    this.bgRT.setSize(rw, rh);
    if (this.bloomLevels) {
      for (const [i, level] of this.bloomLevels.entries()) {
        const d = MaterialRenderer.BLOOM_DIVISORS[i];
        const lw = Math.max(1, Math.round(rw / d));
        const lh = Math.max(1, Math.round(rh / d));
        level.a.setSize(lw, lh);
        level.b.setSize(lw, lh);
      }
    }
    this.depthRT.setSize(rw, rh);
    (this.postMaterial.uniforms.uRes.value as THREE.Vector2).set(rw, rh);
    // The finish pass runs at full drawing-buffer resolution — its dot screens and dither blocks
    // are authored in device pixels, so they must not be scaled by `quality`.
    this.postRT.setSize(pw, ph);
    (this.finishMaterial.uniforms.uRes.value as THREE.Vector2).set(pw, ph);
    // Blur radii are authored in full-resolution pixels; scaling by `quality` keeps them the same
    // fraction of the frame when the scene passes render smaller than the canvas.
    this.postMaterial.uniforms.uScale.value = quality;

    // Size the backdrop to cover the frustum at its distance, never shrinking below the authored
    // 160×110 — the vertical gradient is calibrated against that span, so a smaller plane would
    // pull the whole ramp into view and read as a much stronger gradient.
    const backdropZ = this.config.plate.z - 14;
    const dist = Math.abs(this.distance) + Math.abs(this.config.camera.lookAt.z - backdropZ);
    const need = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.35;
    const bh = Math.max(110, need);
    const bw = Math.max(160, need * this.camera.aspect);
    this.backdrop.scale.set(bw, bh, 1);
    (this.backdropMaterial.uniforms.uSize.value as THREE.Vector2).set(bw, bh);
    // What fraction of that oversized plane the camera actually sees. Gradients and images are
    // authored against the VISIBLE rectangle, so they need this to know where its edges are.
    const visibleH = need / 1.35;
    (this.backdropMaterial.uniforms.uFrame.value as THREE.Vector2).set(
      Math.min(1, (visibleH * this.camera.aspect) / bw),
      Math.min(1, visibleH / bh),
    );

    this.renderOnce();
  }

  private onResize = (): void => {
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      const next = this.metrics();
      const last = this.lastMetrics;
      if (last && next.w === last.w && next.h === last.h && next.dpr === last.dpr) return;
      this.resize();
    });
  };

  /** A `(resolution: Xdppx)` query only fires when we LEAVE the current ratio, so it is re-armed
   *  at the new one on every change. ResizeObserver watches the CSS box only, so browser zoom or
   *  a drag to a different-DPR monitor would otherwise leave the buffer at the old resolution. */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener("change", this.onDprChange);
  }

  private onDprChange = (): void => {
    this.watchDpr();
    this.resize();
  };

  /** Pin the backing buffer to an exact pixel size (studio exports); `undefined` restores the
   *  container-driven size. */
  setOutputSize(size?: { width: number; height: number }): void {
    this.outputSize = size;
    this.resize();
  }

  // ----------------------------------------------------------------- orbit ---

  private bindOrbit(): void {
    const canvas = this.renderer.domElement;
    const { signal } = this.listeners;
    let dragging = false;
    let px = 0;
    let py = 0;
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        // SECONDARY button (right, or middle as the 3D-app convention). The primary button now
        // belongs to whatever is layered on top: the studio marquee-selects with it, and a
        // left-drag that orbited underneath a rubber band would make selection impossible.
        // A layer above can still claim a right-drag for itself by stopping the event in capture
        // — the studio does exactly that to rotate a selected shape.
        if (!this.config.orbit || (e.button !== 2 && e.button !== 1)) return;
        dragging = true;
        px = e.clientX;
        py = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      },
      { signal },
    );
    const end = (): void => {
      dragging = false;
    };
    canvas.addEventListener("pointerup", end, { signal });
    canvas.addEventListener("pointercancel", end, { signal });
    canvas.addEventListener(
      "pointermove",
      (e) => {
        if (!dragging || !this.config.orbit) return;
        // Clamped hard: this is a hero composition, not a model viewer. Past these angles the
        // lamp field slides out from behind the glass and the illusion goes with it.
        this.targetYaw = THREE.MathUtils.clamp(
          this.targetYaw + (e.clientX - px) * 0.002,
          -0.42,
          0.42,
        );
        this.targetPitch = THREE.MathUtils.clamp(
          this.targetPitch - (e.clientY - py) * 0.0014,
          -0.16,
          0.26,
        );
        px = e.clientX;
        py = e.clientY;
        this.renderIfIdle();
      },
      { signal },
    );
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.config.orbit) return;
        e.preventDefault();
        const base = this.config.camera.distance;
        this.distance = THREE.MathUtils.clamp(
          this.distance + e.deltaY * 0.03,
          base * 0.6,
          base * 1.6,
        );
        this.renderIfIdle();
      },
      { signal, passive: false },
    );
  }

  /** Return the camera to the authored pose. */
  resetCamera(): void {
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.distance = this.config.camera.distance;
    // Snap rather than ease: this is a "put it back" control, and easing toward a target the
    // loop may not be running to advance would leave it half-way.
    this.updateCamera(false);
    this.renderIfIdle();
  }

  // -------------------------------------------------------------- rendering ---

  private updateCamera(ease: boolean): void {
    const k = ease ? 0.07 : 1;
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    const cam = this.config.camera;
    // A cameraZoom binding is a dolly multiplier over the authored/orbit distance (2 = twice as
    // close); 1 at rest, so a scene without the binding is untouched.
    const d = this.distance / Math.max(this.interactionZoom, 0.05);
    // A cameraYaw / cameraPitch binding swings the view a few degrees from the pointer. Added to
    // the drag-orbit angles rather than replacing them, so the two compose.
    //
    // `pitch` is a height FACTOR here, not an angle: the position below reads it as
    // `pitch * d * 0.5`, so a tilt of θ degrees — which puts the camera d·tan(θ) above the subject
    // — is 2·tan(θ) in these units. Converting keeps the binding in degrees, which is the only
    // unit anyone can reason about when choosing a range.
    const yaw = this.yaw + THREE.MathUtils.degToRad(this.interactionSceneOut.orbitYaw);
    const pitch =
      this.pitch + 2 * Math.tan(THREE.MathUtils.degToRad(this.interactionSceneOut.orbitPitch));
    this.camera.position.set(Math.sin(yaw) * d, cam.height + pitch * d * 0.5, Math.cos(yaw) * d);
    this.camera.lookAt(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z);
    // Roll AFTER aiming: lookAt() rebuilds the whole orientation from `up`, so anything applied
    // before it is discarded. Rotating about the camera's own Z is the axis it is already looking
    // down, which is what makes this a tilt of the body rather than a change of subject.
    if (cam.roll) this.camera.rotateZ(THREE.MathUtils.degToRad(cam.roll));
  }

  /**
   * Build, update or tear down the traced beam to match `config.beam`.
   *
   * The retrace is guarded by a key rather than run every frame: tracing 96 wavelengths through a
   * polygon and writing ~14k vertices is cheap enough to do on a config change and far too
   * expensive to do at 60Hz. A beam bound to an interaction input will need this called from the
   * frame loop, and the key is what keeps that honest — identical config, no work.
   */

  /**
   * Half-extents of the wall the beam lands on, at the sheet's depth.
   *
   * Walked from the frustum so it always covers the frame, with a little margin: a wall that fell
   * short would end in a hard edge partway across the picture, and the rays that reach past it
   * would simply stop in mid-air.
   */
  private beamWallExtent(z: number): THREE.Vector2 {
    const cam = this.config.camera;
    const dist = Math.abs(this.distance) + Math.abs(cam.lookAt.z - z);
    const halfHeight = dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    // The reference's WALL_SAFETY, plus room for the orbit to swing the frustum a few degrees.
    const safety = 1.08;
    return new THREE.Vector2(
      halfHeight * Math.max(this.camera.aspect, 1) * safety,
      halfHeight * safety,
    );
  }

  /**
   * How far the beam has opened, on the SCENE clock.
   *
   * Set per frame rather than with the rest of the beam, because the beam is only re-applied when
   * something about its geometry changes and this changes on every frame of the reveal. Scene time
   * rather than wall-clock keeps a still export reproducible — `captureImage` seeks to a fixed time
   * and gets the same frame every run — at the cost that a scene which opts in renders empty at
   * t=0, which is what asking for a reveal means.
   */
  private applyBeamReveal(): void {
    const seconds = this.config.beam?.revealSeconds ?? 0;
    if (!this.beamMaterial) return;
    const open = seconds > 0 ? Math.min(1, Math.max(0, this.time) / seconds) : 1;
    this.beamMaterial.uniforms.uReveal.value = open;
    if (this.causticMaterial?.uniforms.uReveal) this.causticMaterial.uniforms.uReveal.value = open;
  }

  private applyBeam(incidenceOverride?: number, entryOverride?: number): void {
    const beam = this.config.beam;
    if (!beam) {
      if (this.beamMesh) {
        this.scene.remove(this.beamMesh);
        this.beamMesh.geometry.dispose();
        this.beamMesh = undefined;
      }
      this.beamKey = "";
      return;
    }

    if (!this.beamMaterial) {
      this.beamMaterial = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: {
          uIntensity: { value: 1 },
          uEdgeFalloff: { value: 16 },
          uFalloffRate: { value: 3.8 },
          uFalloffPower: { value: 3.7 },
          uReveal: { value: 1 },
        },
        transparent: true,
        // Additive in COLOUR only. Plain AdditiveBlending is (SrcAlpha, One) on both channels,
        // which accumulates alpha as well — and the post pass divides by that alpha, so the layer
        // darkens what it should brighten. One/One on colour, Zero/One on alpha, leaves coverage
        // exactly as the scene passes left it.
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        // A ribbon has no meaningful front. Its winding flips with the beam direction — the fan
        // sweeps through segments heading down and left — so half of it culls under FrontSide and
        // the effect renders as nothing at all.
        side: THREE.DoubleSide,
        // Neither tested nor written. The beam is light, not a surface: it has no business
        // occluding the glass, and letting it write depth would give it a circle of confusion in
        // the post pass and blur the one element that has to stay a crisp filament.
        depthTest: false,
        depthWrite: false,
      });
    }
    this.causticMaterial ??= new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: CAUSTIC_FRAG,
      uniforms: {
        uEdgeFalloff: { value: 16 },
        uFalloffRate: { value: 3.8 },
        uFalloffPower: { value: 3.7 },
        uStrength: { value: 1.9 },
        uCoverage: { value: 0.86 },
        uFarDesat: { value: 0.04 },
        uFarBright: { value: 0.02 },
        uTravelScale: { value: 1 },
        uRateScale: { value: 0.12 },
        uPowerScale: { value: 0.5 },
        uNormalInfluence: { value: 1 },
        uNormalElevation: { value: 35 },
        uWallScale: { value: 1 / 2.4 },
        uWallNormal: { value: 0.22 },
        // Their wall tuning: the micro field runs seven times faster than the large one and is
        // nearly five times stronger, because it is the surface and the large scale is only the
        // wall not being flat.
        uWallMicroFreq: { value: 7 },
        uWallMicroNormal: { value: 1.05 },
        uBeamDir: { value: new THREE.Vector2(1, 0) },
      },
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const cu = this.causticMaterial.uniforms;
    cu.uEdgeFalloff.value = beam.edgeFalloff;
    cu.uFalloffRate.value = beam.falloffRate;
    cu.uFalloffPower.value = beam.falloffPower;
    cu.uStrength.value = beam.causticStrength;
    cu.uCoverage.value = beam.causticCoverage;
    cu.uFarDesat.value = beam.causticFarDesaturation;
    cu.uFarBright.value = beam.causticFarBrightness;
    cu.uRateScale.value = beam.causticRateScale;
    cu.uPowerScale.value = beam.causticPowerScale;
    cu.uNormalInfluence.value = beam.causticNormalInfluence;
    cu.uNormalElevation.value = beam.causticNormalElevation;

    this.beamMaterial.uniforms.uIntensity.value = beam.intensity;
    this.beamMaterial.uniforms.uEdgeFalloff.value = beam.edgeFalloff;
    this.beamMaterial.uniforms.uFalloffRate.value = beam.falloffRate;
    this.beamMaterial.uniforms.uFalloffPower.value = beam.falloffPower;
    this.applyBeamReveal();

    // The values a binding may be driving. Folded into the key rather than compared separately, so
    // a pointer resting between frames costs one string compare and no retrace.
    const incidence = incidenceOverride ?? beam.incidence;
    const entry = entryOverride ?? beam.entry;
    // The solid the beam refracts through, which is the ITEM's when one is named. Folded into the
    // key so a shape edit retraces: the beam is solved on the CPU against this outline, and
    // nothing else in the frame would notice that it had gone stale.
    const targets = (beam.targets ?? [])
      .map((name) => this.items.find((i) => i.config?.name === name)?.config)
      .filter((c): c is ItemConfig => c !== undefined);
    const key =
      `${JSON.stringify(beam)}|${JSON.stringify(targets.map((c) => [c.shape, c.position, c.rotation, c.material.ior]))}` +
      `|${incidence.toFixed(4)}|${entry.toFixed(4)}`;
    if (key === this.beamKey && this.beamMesh) return;
    this.beamKey = key;

    // A named item whose shape has no convex slice is dropped here rather than approximated, so a
    // `ring` in the list simply is not in the light's way.
    const sections = targets
      .map((c) => ({
        polygon: crossSectionFor(
          c.shape.kind,
          c.shape.r,
          c.shape.sides,
          beam.rotation + c.rotation.z,
          {
            x: c.position.x,
            y: c.position.y,
          },
        ),
        ior: c.material.ior,
      }))
      .filter((s): s is { polygon: THREE.Vector2[]; ior: number } => s.polygon !== undefined);
    const polygon =
      sections[0]?.polygon ?? prismCrossSection(beam.radius, beam.sides, beam.rotation);
    // An angle is the round-safe handle and a face index the faceted one — see BeamConfig. The
    // pointer drives `entry` on both: as a position along the chosen face, or as a sweep of a
    // quarter turn around the outline either side of the authored angle.
    const aim =
      beam.entryAngle === undefined
        ? aimBeam(polygon, beam.face, incidence, entry, beam.width, beam.distance)
        : aimBeamAtAngle(
            polygon,
            beam.entryAngle + (entry - 0.5) * (beam.entrySweep ?? 90),
            incidence,
            beam.width,
            beam.distance,
          );
    (this.causticMaterial.uniforms.uBeamDir.value as THREE.Vector2).copy(aim.direction);

    const { geometry } = buildLightSheet({
      polygon,
      // The first solid is `polygon`; the rest carry their own index of refraction, so a scene can
      // stand flint next to crown and see the difference in how far each one bends the spectrum.
      extraSolids: sections.slice(1),
      origin: aim.origin,
      direction: aim.direction,
      halfWidth: beam.width,
      z: beam.z,
      ior: beam.ior,
      dispersion: beam.dispersion,
      samples: beam.samples,
      slices: beam.slices,
      // Derived from the frustum at the sheet's depth rather than authored, exactly as the
      // reference derives it: the wall has to cover whatever the camera can see of it, so a scene
      // that changes fov or distance must not also have to remember to resize the wall.
      wallHalfExtent: this.beamWallExtent(beam.z),
      exposure: beam.exposure,
      edgeFalloff: beam.edgeFalloff,
    });

    if (this.beamMesh) {
      // Copy into the EXISTING buffers when the vertex count is unchanged, which it is on every
      // frame of a pointer sweep. Swapping in a fresh BufferGeometry instead makes three drop the
      // GPU buffers and allocate new ones every frame — on a retracing beam that costs more than
      // the trace itself.
      const old = this.beamMesh.geometry;
      const oldPos = old.getAttribute("position") as THREE.BufferAttribute;
      const newPos = geometry.getAttribute("position") as THREE.BufferAttribute;
      if (oldPos && newPos && oldPos.count === newPos.count) {
        for (const name of ["position", "aColor"]) {
          const target = old.getAttribute(name) as THREE.BufferAttribute;
          const source = geometry.getAttribute(name) as THREE.BufferAttribute;
          (target.array as Float32Array).set(source.array as Float32Array);
          target.needsUpdate = true;
        }
        geometry.dispose();
        return;
      }
      old.dispose();
      this.beamMesh.geometry = geometry;
      if (this.causticMesh) this.causticMesh.geometry = geometry;
    } else {
      this.beamMesh = new THREE.Mesh(geometry, this.beamMaterial);
      // After everything else in the scene, which with depthTest off is what decides that the
      // beam composites over the glass rather than under it.
      this.beamMesh.renderOrder = 10;
      this.beamMesh.frustumCulled = false;
      this.scene.add(this.beamMesh);
      // Same geometry, second material. Drawn FIRST so the beam's own core lands on top of the
      // wash it casts, which is the order the two actually happen in.
      this.causticMesh = new THREE.Mesh(geometry, this.causticMaterial);
      this.causticMesh.renderOrder = 9;
      this.causticMesh.frustumCulled = false;
      this.scene.add(this.causticMesh);
    }
  }

  /** Half-resolution divisors for the pyramid, and the tap count each level's blur uses. Wider
   *  kernels cost almost nothing once the target is small, which is where the broad wash comes
   *  from. The fourth level is built but not composited — it exists to light dust. */
  private static readonly BLOOM_DIVISORS = [2, 4, 8, 16] as const;
  private static readonly BLOOM_TAPS = [6, 10, 14, 18] as const;

  /** Allocate (or tear down) the bloom pyramid to match the config. */
  private applyBloom(): void {
    // Dust needs the pyramid too, and not for its bloom: each grain samples the BROADEST level as
    // its light field, which is what makes the field light up along a beam and stay invisible in
    // the dark. Allocating it on demand is what lets any scene carry particles, rather than only
    // the ones that happen to want multi-scale bloom. `uBloomMode` still follows the config, so a
    // scene using the gather keeps the gather's look and just gains a light field.
    const wanted = this.config.post.bloomMode === "pyramid" || (this.config.dust?.count ?? 0) > 0;
    if (!wanted) {
      if (this.bloomLevels) {
        for (const level of this.bloomLevels) {
          level.a.dispose();
          level.b.dispose();
        }
        this.bloomLevels = undefined;
      }
      this.postMaterial.uniforms.tBloom.value = null;
      this.postMaterial.uniforms.uBloomMode.value = 0;
      return;
    }
    this.postMaterial.uniforms.uBloomMode.value = this.config.post.bloomMode === "pyramid" ? 1 : 0;
    if (this.bloomLevels) return;

    // Half-float throughout: the whole point is to carry highlights above 1 from the main pass to
    // the composite, and a byte target would clamp them at the first step.
    const options: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
    };
    this.bloomLevels = MaterialRenderer.BLOOM_DIVISORS.map(() => ({
      a: new THREE.WebGLRenderTarget(1, 1, options),
      b: new THREE.WebGLRenderTarget(1, 1, options),
    }));

    this.bloomExtract ??= new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: BLOOM_EXTRACT_FRAG,
      uniforms: {
        tSrc: { value: null },
        uThreshold: { value: 1 },
        uTexel: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.bloomBlur ??= new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: BLOOM_BLUR_FRAG,
      defines: { BLOOM_TAPS: "18" },
      uniforms: {
        tSrc: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2() },
        uSigma: { value: 6 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.bloomDown ??= new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: BLOOM_DOWN_FRAG,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    this.bloomComposite ??= new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: BLOOM_COMPOSITE_FRAG,
      uniforms: {
        tL0: { value: null },
        tL1: { value: null },
        tL2: { value: null },
        uRadius: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    if (!this.bloomQuad) {
      this.bloomQuad = new THREE.Mesh(this.screenQuad, this.bloomExtract);
      this.bloomScene.add(this.bloomQuad);
    }
    this.resize();
  }

  /** Draw one fullscreen pass of `material` into `target`. */
  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    if (!this.bloomQuad) return;
    this.bloomQuad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.bloomScene, this.postCamera);
  }

  /**
   * Extract → downsample → separable blur per level → composite.
   *
   * Runs between the main pass and post, so it sees the frame with the beam already in it and
   * still in HDR. The blur is two passes per level because a separable Gaussian is O(2n) taps
   * instead of O(n²) — the only reason an 18-tap kernel is affordable at all.
   */
  /** Point every material at the baked chain, or at nothing when the room stays analytic. */
  private applyEnvironmentUniforms(): void {
    const width = MaterialRenderer.ENV_WIDTH;
    const on = this.config.environment === "baked" && this.envRT !== undefined;
    const write = (u: Record<string, THREE.IUniform> | undefined) => {
      if (!u?.uEnvOn) return;
      u.uEnvOn.value = on ? 1 : 0;
      u.tEnv.value = on ? this.envRT!.texture : null;
      (u.uEnvSize.value as THREE.Vector2).set(width, width / 2);
      // Radians per texel across the equator, which is what a cone width is compared against.
      u.uEnvTexel.value = (Math.PI * 2) / width;
      u.uEnvLevels.value = MaterialRenderer.ENV_LEVELS;
    };
    write(this.lampUniforms as unknown as Record<string, THREE.IUniform>);
    for (const item of this.items) write(item.material.uniforms);
    write(this.backGlass?.uniforms);
  }

  /** Level 0 is 512 wide; eight levels take the widest cone to a whole hemisphere. */
  private static readonly ENV_WIDTH = 512;
  private static readonly ENV_LEVELS = 8;

  /**
   * Bake the room into an equirectangular mip chain, once per configuration.
   *
   * Rendered into the mip levels of ONE texture rather than kept as eight separate targets, so a
   * shader picks a cone width with a single `lod` argument instead of the eight samplers and a
   * manual blend that the alternative would need.
   *
   * The chain is built through scratch targets rather than by blurring level N-1 in place: a
   * texture cannot be sampled and written in the same draw, and reading the level above while
   * writing the one below is exactly that.
   */
  private buildEnvironment(): void {
    const c = this.config;
    if (c.environment !== "baked") {
      if (this.envRT) {
        this.envRT.dispose();
        this.envRT = undefined;
      }
      this.envKey = "";
      return;
    }
    // The room is a pure function of these, so a scene that never touches them bakes once.
    const key = `${c.studio}|${c.studioGain}`;
    if (key === this.envKey && this.envRT) return;
    this.envKey = key;

    const width = MaterialRenderer.ENV_WIDTH;
    const levels = MaterialRenderer.ENV_LEVELS;
    if (!this.envRT) {
      this.envRT = new THREE.WebGLRenderTarget(width, width / 2, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        generateMipmaps: false,
      });
      // Storage for every level has to exist before anything can be rendered into one.
      this.envRT.texture.mipmaps = Array.from({ length: levels }, (_, i) => ({
        width: Math.max(1, width >> i),
        height: Math.max(1, (width / 2) >> i),
      })) as THREE.Texture["mipmaps"];
    }

    this.envBake ??= new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: ENV_BAKE_FRAG,
      uniforms: {
        uStudio: { value: 0 },
        uStudioGain: { value: 1 },
        uPrism: { value: 0 },
        uPrismPlanes: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
        uPrismPlaneCount: { value: 0 },
        tEnv: { value: null },
        uEnvSize: { value: new THREE.Vector2() },
        uEnvTexel: { value: 0 },
        uEnvLevels: { value: levels },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.envBlur ??= new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: ENV_BLUR_FRAG,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uDir: { value: new THREE.Vector2() },
        uRadius: { value: 1.15 },
        uCompensate: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.envBake.uniforms.uStudio.value = c.studio === "softbox" ? 1 : 0;
    this.envBake.uniforms.uStudioGain.value = c.studioGain;

    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    let source = new THREE.WebGLRenderTarget(width, width / 2, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
    });
    this.blit(this.envBake, source);
    this.copyIntoLevel(source, 0);

    for (let level = 1; level < levels; level++) {
      const w = Math.max(1, width >> level);
      const h = Math.max(1, (width / 2) >> level);
      const horizontal = source.clone();
      horizontal.setSize(w, h);
      const vertical = source.clone();
      vertical.setSize(w, h);
      const blur = this.envBlur.uniforms;
      blur.tSrc.value = source.texture;
      (blur.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
      (blur.uDir.value as THREE.Vector2).set(1, 0);
      blur.uCompensate.value = 1;
      this.blit(this.envBlur, horizontal);
      blur.tSrc.value = horizontal.texture;
      (blur.uDir.value as THREE.Vector2).set(0, 1);
      // The vertical pass runs UNCOMPENSATED: the correction is for rows covering different solid
      // angles, and applying it down the columns pulls the poles apart instead of tightening them.
      blur.uCompensate.value = 0;
      this.blit(this.envBlur, vertical);
      this.copyIntoLevel(vertical, level);
      horizontal.dispose();
      source.dispose();
      source = vertical;
    }
    source.dispose();
    renderer.setRenderTarget(previous);
  }

  /** Whether a dev harness has asked for a material intermediate instead of the composed frame.
   *  Never set in production, where this is false and post runs normally. */
  private probeActive(): boolean {
    return Number((globalThis as Record<string, unknown>)["__glslProbe"] ?? 0) > 0;
  }

  /** Copy a scratch target into one mip of the environment texture. */
  private copyIntoLevel(source: THREE.WebGLRenderTarget, level: number): void {
    if (!this.envRT) return;
    this.envCopy ??= new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: BLIT_FRAG,
      uniforms: { tSrc: { value: null } },
      depthTest: false,
      depthWrite: false,
    });
    this.envCopy.uniforms.tSrc.value = source.texture;
    if (!this.bloomQuad) return;
    this.bloomQuad.material = this.envCopy;
    this.renderer.setRenderTarget(this.envRT, 0, level);
    this.renderer.clear();
    this.renderer.render(this.bloomScene, this.postCamera);
  }

  private renderBloomPyramid(): void {
    const levels = this.bloomLevels;
    const extract = this.bloomExtract;
    const blur = this.bloomBlur;
    const composite = this.bloomComposite;
    const down = this.bloomDown;
    if (!levels || !extract || !blur || !composite || !down) return;

    extract.uniforms.tSrc.value = this.colorRT.texture;
    extract.uniforms.uThreshold.value = this.config.post.bloomThreshold;
    (extract.uniforms.uTexel.value as THREE.Vector2).set(
      1 / this.colorRT.width,
      1 / this.colorRT.height,
    );
    this.blit(extract, levels[0].a);

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      // Levels below the first downsample from the level above rather than from the source, which
      // is what makes the pyramid cheap: each step works on a quarter of the pixels.
      if (i > 0 && this.bloomDown) {
        const src = levels[i - 1].a;
        this.bloomDown.uniforms.tSrc.value = src.texture;
        (this.bloomDown.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        this.blit(this.bloomDown, level.a);
      }
      const taps = MaterialRenderer.BLOOM_TAPS[i];
      blur.defines.BLOOM_TAPS = String(taps);
      blur.needsUpdate = true;
      blur.uniforms.uSigma.value = taps / 3;
      (blur.uniforms.uTexel.value as THREE.Vector2).set(1 / level.a.width, 1 / level.a.height);

      blur.uniforms.tSrc.value = level.a.texture;
      (blur.uniforms.uDir.value as THREE.Vector2).set(1, 0);
      this.blit(blur, level.b);

      blur.uniforms.tSrc.value = level.b.texture;
      (blur.uniforms.uDir.value as THREE.Vector2).set(0, 1);
      this.blit(blur, level.a);
    }

    composite.uniforms.tL0.value = levels[0].a.texture;
    composite.uniforms.tL1.value = levels[1].a.texture;
    composite.uniforms.tL2.value = levels[2].a.texture;
    composite.uniforms.uRadius.value = this.config.post.bloomSpread;
    // Into the HALF-resolution level, not the sixteenth. Compositing at the bottom of the pyramid
    // and letting the post pass upscale it sixteen times is what put a staircase along every thin
    // diagonal highlight — the halo around the beam arrived as 16px blocks smeared back up. Half
    // resolution is the standard place to resolve a bloom: still cheap, and a 2x upscale of
    // already-blurred content is invisible.
    this.blit(composite, levels[0].b);
    this.postMaterial.uniforms.tBloom.value = levels[0].b.texture;

    // The particle light field, built AFTER the composite and deliberately UNTHRESHOLDED.
    //
    // Dust cannot read the bloom chain: everything there has been through the bright-pass, so the
    // field is sparse and dim, and a grain's response raises it to the 5.5th power — which takes a
    // diluted 0.2 down to 0.00007 and lights nothing. What a particle needs is a broad blur of the
    // WHOLE frame, so it glows wherever there is light rather than only where there is bloom.
    // Chained down through the level targets, which are free once the visible bloom is composited
    // into levels[0].b.
    const light = levels[levels.length - 1];
    this.particleDown ??= new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uScale: { value: new THREE.Vector2() },
      },
      vertexShader: POST_VERT,
      fragmentShader: PARTICLE_DOWN_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const pd = this.particleDown;
    pd.uniforms.tSrc.value = this.colorRT.texture;
    (pd.uniforms.uTexel.value as THREE.Vector2).set(
      1 / this.colorRT.width,
      1 / this.colorRT.height,
    );
    (pd.uniforms.uScale.value as THREE.Vector2).set(
      this.colorRT.width / light.a.width,
      this.colorRT.height / light.a.height,
    );
    this.blit(pd, light.a);
    blur.defines.BLOOM_TAPS = String(MaterialRenderer.BLOOM_TAPS.at(-1));
    blur.needsUpdate = true;
    blur.uniforms.uSigma.value = MaterialRenderer.BLOOM_TAPS.at(-1)! / 3;
    (blur.uniforms.uTexel.value as THREE.Vector2).set(1 / light.a.width, 1 / light.a.height);
    blur.uniforms.tSrc.value = light.a.texture;
    (blur.uniforms.uDir.value as THREE.Vector2).set(1, 0);
    this.blit(blur, light.b);
    blur.uniforms.tSrc.value = light.b.texture;
    (blur.uniforms.uDir.value as THREE.Vector2).set(0, 1);
    this.blit(blur, light.a);
  }

  /**
   * Build, update or tear down the dust field.
   *
   * The geometry is a plain soup of quads rather than instanced draws: two triangles per grain at
   * a few thousand grains is a rounding error next to the four scene passes, and it keeps the
   * whole thing to one draw call with no extension to feature-detect.
   */
  private applyDust(): void {
    const dust = this.config.dust;
    if (!dust || dust.count === 0) {
      if (this.dustMesh) {
        this.dustScene.remove(this.dustMesh);
        this.dustMesh.geometry.dispose();
        this.dustMesh = undefined;
      }
      this.dustKey = "";
      return;
    }

    this.dustMaterial ??= new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: {
        tLight: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uSize: { value: 1 },
        uDrift: { value: 0.25 },
        uIntensity: { value: 1 },
        uResponse: { value: 82 },
        uFalloffPower: { value: 5.5 },
        uExtent: { value: new THREE.Vector3() },
        uPlaneZ: { value: 0 },
        tColor: { value: null },
        uExposure: { value: 0.72 },
        uPrismA: { value: new THREE.Vector3() },
        uPrismB: { value: new THREE.Vector3() },
        uPrismC: { value: new THREE.Vector3() },
        uCamDist: { value: 1 },
      },
      transparent: true,
      // Additive in COLOUR only. Plain AdditiveBlending is (SrcAlpha, One) on both channels,
      // which accumulates alpha as well — and the post pass divides by that alpha, so the layer
      // darkens what it should brighten. One/One on colour, Zero/One on alpha, leaves coverage
      // exactly as the scene passes left it.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const u = this.dustMaterial.uniforms;
    u.uSize.value = dust.size;
    u.uDrift.value = dust.drift;
    u.uIntensity.value = dust.intensity;
    u.uResponse.value = dust.response;
    u.uFalloffPower.value = dust.falloffPower;
    (u.uExtent.value as THREE.Vector3).set(dust.extent.x, dust.extent.y, dust.extent.z);
    // Grains cluster on the light sheet's plane, so they need to know where it is.
    u.uPlaneZ.value = this.config.beam?.z ?? 0;
    // The cross-section the grains must not draw over, in the sheet's plane.
    const dustBeam = this.config.beam;
    const section = dustBeam
      ? prismCrossSection(dustBeam.radius, dustBeam.sides, dustBeam.rotation)
      : [];
    const planeZ = dustBeam?.z ?? 0;
    for (const [i, key] of (["uPrismA", "uPrismB", "uPrismC"] as const).entries()) {
      const c = section[i % Math.max(section.length, 1)];
      (u[key].value as THREE.Vector3).set(c?.x ?? 0, c?.y ?? 0, planeZ);
    }

    const key = `${dust.count}:${dust.seed}`;
    if (key === this.dustKey && this.dustMesh) return;
    this.dustKey = key;

    const corners: number[] = [];
    const ids: number[] = [];
    const QUAD: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, -1],
      [1, 1],
      [-1, 1],
    ];
    // Only an index per grain: position, size, class, shape, energy and lifetime are all hashed
    // from it in the vertex shader, exactly as the reference derives everything from its instance
    // index. Nothing about a grain needs to be uploaded, and a respawn costs no buffer write.
    for (let i = 0; i < dust.count; i++) {
      for (const [cx, cy] of QUAD) {
        corners.push(cx, cy);
        ids.push(i + dust.seed * 0.618);
      }
    }
    const geometry = new THREE.BufferGeometry();
    // Positions are unused — the vertex shader derives world position from `aSeed` — but three
    // needs the attribute present to know how many vertices to draw.
    const placeholder = Array.from({ length: (corners.length / 2) * 3 }, () => 0);
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(placeholder, 3));
    geometry.setAttribute("aCorner", new THREE.Float32BufferAttribute(corners, 2));
    geometry.setAttribute("aId", new THREE.Float32BufferAttribute(ids, 1));

    if (this.dustMesh) {
      this.dustMesh.geometry.dispose();
      this.dustMesh.geometry = geometry;
    } else {
      this.dustMesh = new THREE.Mesh(geometry, this.dustMaterial);
      this.dustMesh.frustumCulled = false;
      this.dustScene.add(this.dustMesh);
    }
  }

  /**
   * Hand a convex prism item its own bounding planes, in world space.
   *
   * Only a lathe of a few sides qualifies: the glass shader traces the refracted ray against these
   * to find where it really leaves, which is only meaningful for a solid whose faces ARE planes.
   *
   * The local frame has to match three's lathe exactly — it places a vertex at
   * `(r·sin(phi), y, r·cos(phi))`, so a face's outward normal is `(sin, 0, cos)` at the midpoint
   * angle between two vertices, at the apothem `r·cos(pi/sides)`. Note this is NOT the convention
   * `prismCrossSection` uses for the beam, which is `(cos, sin)`; they describe the same polygon
   * from different starting angles and only agree because the beam's is rotated to match.
   */
  private applyPrismPlanes(item: MaterialItem): void {
    const u = item.material.uniforms;
    // An item added through the imperative `add()` carries no config; it cannot be a prism.
    const shape = item.config?.shape;
    // The EFFECTIVE count, not the field: `hex` is six-sided by definition and its builder ignores
    // `shape.sides` entirely, so reading the field traces a solid the mesh is not — a hexagon with
    // a triangle refracting inside it.
    const sides = shape?.kind === "hex" ? 6 : (shape?.sides ?? 0);
    const eligible =
      this.config.tracedRefraction &&
      shape !== undefined &&
      (shape.kind === "prism" || shape.kind === "hex") &&
      sides >= 3 &&
      sides <= 8;
    if (!eligible) {
      u.uPrism.value = 0;
      u.uPrismPlaneCount.value = 0;
      return;
    }

    item.mesh.updateMatrixWorld(true);
    const planes = u.uPrismPlanes.value as THREE.Vector4[];
    const normalMatrix = this.normalScratch.getNormalMatrix(item.mesh.matrixWorld);
    const r = shape.r;
    const half = shape.len / 2;
    const apothem = r * Math.cos(Math.PI / sides);
    const normal = new THREE.Vector3();
    const point = new THREE.Vector3();
    let count = 0;

    for (let i = 0; i < sides && count < 6; i++) {
      const a = (Math.PI * 2 * (i + 0.5)) / sides;
      normal.set(Math.sin(a), 0, Math.cos(a));
      point.copy(normal).multiplyScalar(apothem);
      this.writePlane(planes[count++], normal, point, normalMatrix, item.mesh.matrixWorld);
    }
    for (const dir of [1, -1]) {
      if (count >= 6) break;
      normal.set(0, dir, 0);
      point.set(0, dir * half, 0);
      this.writePlane(planes[count++], normal, point, normalMatrix, item.mesh.matrixWorld);
    }
    u.uPrism.value = 1;
    u.uPrismPlaneCount.value = count;
  }

  /** World-space `(normal, offset)` for a plane given in an item's local frame. */
  private writePlane(
    out: THREE.Vector4,
    localNormal: THREE.Vector3,
    localPoint: THREE.Vector3,
    normalMatrix: THREE.Matrix3,
    world: THREE.Matrix4,
  ): void {
    const n = localNormal.clone().applyMatrix3(normalMatrix).normalize();
    const p = localPoint.clone().applyMatrix4(world);
    out.set(n.x, n.y, n.z, -n.dot(p));
  }

  /**
   * Draw the inner interface of every traced solid into the plate.
   *
   * Between the plate and the main pass: the plate is what the main pass's glass refracts, so this
   * is where a back interface has to land for the front face to show it.
   *
   * The mesh is moved into its own scene for the draw rather than swapping the material in place.
   * `renderer.render(mesh, camera)` on an object that still belongs to another scene picks up that
   * scene's state — and quietly renders nothing useful.
   */
  private renderBackGlass(): void {
    if (!this.config.tracedRefraction || this.config.backGlassStrength <= 0) return;
    this.backGlass ??= new THREE.ShaderMaterial({
      vertexShader: BACKGLASS_VERT,
      fragmentShader: BACKGLASS_FRAG,
      uniforms: {
        uPrism: { value: 1 },
        uPrismPlanes: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
        uPrismPlaneCount: { value: 0 },
        uStudio: { value: 0 },
        uStudioGain: { value: 1 },
        tEnv: { value: null },
        uEnvSize: { value: new THREE.Vector2(1, 1) },
        uEnvTexel: { value: 1 },
        uEnvLevels: { value: 1 },
        uEnvOn: { value: 0 },
        uIOR: { value: 1.5 },
        uBackStrength: { value: 1 },
        uPlateDepth: { value: 1 },
      },
      // Additive on COLOUR, alpha untouched — the plate's alpha is depth, not coverage.
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      side: THREE.BackSide,
      // The plate already holds the solid's FRONT faces, so a depth-tested back face is behind
      // them and rejected everywhere but a few silhouette pixels.
      depthTest: false,
      depthWrite: false,
    });

    const u = this.backGlass.uniforms;
    u.uStudio.value = this.lampUniforms.uStudio.value;
    u.uStudioGain.value = this.lampUniforms.uStudioGain.value;
    u.uBackStrength.value = this.config.backGlassStrength;

    this.renderer.setRenderTarget(this.bgRT);
    for (const item of this.items) {
      const iu = item.material.uniforms;
      if (iu.uPrism.value < 0.5) continue;
      u.uPrismPlaneCount.value = iu.uPrismPlaneCount.value;
      const src = iu.uPrismPlanes.value as THREE.Vector4[];
      const dst = u.uPrismPlanes.value as THREE.Vector4[];
      for (const [i, plane] of src.entries()) dst[i].copy(plane);
      u.uIOR.value = iu.uIOR.value;
      // Re-emit the depth the plate pass stored, so the main pass's validation still passes.
      u.uPlateDepth.value = Math.abs(item.mesh.position.z - this.camera.position.z) / FAR;

      const home = item.mesh.parent;
      const previous = item.mesh.material;
      item.mesh.material = this.backGlass;
      this.backGlassScene.add(item.mesh);
      this.renderer.render(this.backGlassScene, this.camera);
      this.backGlassScene.remove(item.mesh);
      item.mesh.material = previous;
      home?.add(item.mesh);
    }
  }

  private setPass(pass: 0 | 1): void {
    for (const item of this.items) {
      item.material.uniforms.uPass.value = pass;
      // The refraction texture MUST be unbound while pass 2 renders INTO it, or the driver
      // reports a framebuffer feedback loop and the frame is undefined.
      item.material.uniforms.tBg.value = pass === 1 ? this.bgRT.texture : null;
    }
  }

  renderOnce(): void {
    if (this.disposed) return;
    const renderer = this.renderer;

    this.scene.updateMatrixWorld(true);
    for (const item of this.items) {
      const u = item.material.uniforms;
      (u.uCam.value as THREE.Vector3).copy(this.camera.position);
      u.uAspect.value = this.camera.aspect;
      u.uTime.value = this.time + this.interactionTime;
      (u.uNormalMat.value as THREE.Matrix3).copy(
        this.normalScratch.getNormalMatrix(item.mesh.matrixWorld),
      );
    }
    this.postMaterial.uniforms.uTime.value = this.time;
    // The glass fragment needs it to project a traced exit point, and three does not supply the
    // projection to fragment shaders. Refreshed here because the camera moves.
    this.camera.updateMatrixWorld();
    for (const item of this.items) {
      (item.material.uniforms.uViewProj.value as THREE.Matrix4).multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      );
    }

    // Interaction bindings write LAST, over whatever refresh() and the loops above pushed, so a
    // bound param modulates and everything else stays authored.
    this.applyInteraction();
    // A `beamAngle` binding is the one target that cannot be a uniform write, so the retrace has
    // to happen here — after the bindings have resolved and before anything is drawn. Guarded by
    // the beam key, so a still pointer costs a string compare.
    if (this.config.beam) {
      this.applyBeam(this.interactionSceneOut.beamIncidence, this.interactionSceneOut.beamEntry);
    }

    // 1. Depth — with the backdrop HIDDEN and the buffer cleared to the encoded focal depth.
    //    A backdrop sitting far outside the focal range has a maximal circle of confusion, so
    //    every background pixel near a shape gathers ~14px of that shape's colour and the whole
    //    frame turns to smeared watercolour. Backgrounds are smooth gradients: they don't need
    //    blurring, and pinning them to the focal plane removes the bleed outright.
    const d = THREE.MathUtils.clamp(this.config.post.focus / FAR, 0, 1);
    const low = (d * 255) % 1;
    this.depthClearColor.r = d - low / 255;
    this.depthClearColor.g = low;
    this.depthClearColor.b = 0;

    this.scene.overrideMaterial = this.depthMaterial;
    this.backdrop.visible = false; // hidden here in every mode — see the note above
    // The beam contributes no depth and no thickness. Under `overrideMaterial` it would be drawn
    // with the depth material like any other mesh, and a sheet of quads lying across the frame at
    // the prism's Z would hand every pixel it covers a false near depth.
    if (this.beamMesh) this.beamMesh.visible = false;
    if (this.causticMesh) this.causticMesh.visible = false;
    renderer.setClearColor(this.depthClearColor, 1);
    renderer.setRenderTarget(this.depthRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // 1b. Back faces — the exit surface, encoded exactly like the depth pass. Subtracting this
    //     from the front depth gives each fragment its real optical path, which is what the glass
    //     shader needs in order to stop assuming every shape is a cylinder.
    //
    //     Cleared to ZERO, not to the focal depth: a pixel with no back face must come out with no
    //     thickness, and zero minus the front depth clamps to exactly that. The backdrop stays
    //     hidden — its back face is meaningless and would blanket the frame in false thickness.
    if (this.config.measuredThickness) {
      this.scene.overrideMaterial = this.backMaterial;
      renderer.setClearColor(BLACK, 1);
      renderer.setRenderTarget(this.backRT);
      renderer.clear();
      renderer.render(this.scene, this.camera);
    }

    this.scene.overrideMaterial = null;
    this.backdrop.visible = !this.config.transparentBackground;
    // Alpha 0 when transparent. The RGB is still the backdrop colour, but note that three
    // premultiplies the clear against a premultiplied drawing buffer, so at alpha 0 the buffer
    // really clears to black — the post pass un-premultiplies after its gather to compensate.
    renderer.setClearColor(
      setRaw(this.clearColor, this.config.background),
      this.config.transparentBackground ? 0 : 1,
    );

    // 2. Plate — the whole frame with glass falling back to the lamp field, linear depth in alpha.
    //    The beam stays hidden: the plate is what the glass REFRACTS, and the tracer has already
    //    computed the beam's true path through the glass. Letting the plate carry it too would
    //    refract it a second time and draw a bent ghost of the beam inside the prism.
    this.setPass(0);
    renderer.setRenderTarget(this.bgRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // 2b. Inner interface — into the PLATE, so the main pass's glass refracts it.
    this.renderBackGlass();

    // 3. Main — the same frame with glass refracting pass 2. Tubes refracting tubes.
    //    The beam appears here, additively, over the glass it has already been traced through.
    this.setPass(1);
    if (this.beamMesh) this.beamMesh.visible = true;
    if (this.causticMesh) this.causticMesh.visible = true;
    renderer.setRenderTarget(this.colorRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // 3b. Bloom pyramid — between main and post, so it sees the beam and still has HDR to work
    //     with. The post pass adds the result rather than gathering its own.
    this.applyBeamReveal();
    if (this.bloomLevels) this.renderBloomPyramid();

    // A DEV PROBE BYPASSES POST ENTIRELY.
    //
    // A probe substitutes one intermediate into the material's output, and the whole point is to
    // read the value the material computed. Post is not a window onto that: tone mapping, bloom,
    // haze, vignette and grain are all non-linear, and a probe pushed through them is a different
    // number — one that saturates, that shifts by a constant, and that answers identically for two
    // different probes wherever the shape covers little of the frame. Reading probes through post
    // is the single most effective way to misread this tool, and it has cost real time.
    //
    // The node engine does the same thing at the same point, so the two stay comparable.
    if (this.probeActive()) {
      this.probeBlit ??= new THREE.ShaderMaterial({
        vertexShader: POST_VERT,
        fragmentShader: BLIT_FRAG,
        uniforms: { tSrc: { value: null } },
        depthTest: false,
        depthWrite: false,
      });
      this.probeBlit.uniforms.tSrc.value = this.colorRT.texture;
      // Its OWN quad, not the bloom one. The bloom quad is set up for reduced-size mip passes, and
      // borrowing it put the probe image a pixel off from what post produces — which then reads as
      // a registration difference between the two engines that does not exist in the real frames.
      this.probeScene ??= (() => {
        const scene = new THREE.Scene();
        scene.add(new THREE.Mesh(this.screenQuad, this.probeBlit!));
        return scene;
      })();
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(this.probeScene, this.postCamera);
      return;
    }

    // 4. Post — to the screen, unless a finish effect needs the composited frame as a texture.
    if (this.needsFinish()) {
      renderer.setRenderTarget(this.postRT);
      renderer.clear();
      renderer.render(this.postScene, this.postCamera);
      // 5. Finish — light shafts and stylisation over the finished frame.
      renderer.setRenderTarget(null);
      renderer.render(this.finishScene, this.postCamera);
    } else {
      renderer.setRenderTarget(null);
      renderer.render(this.postScene, this.postCamera);
    }

    // 6. Dust — additively over the FINISHED frame, in display space.
    //
    // It has to come after the bloom, for the obvious reason that the bloom is what tells each
    // grain whether any light reaches it. It has to come after the TONE MAP for a less obvious
    // one: a mote is a point of light in its own right rather than part of the scene beneath it,
    // and drawing it into the HDR target means the tone map compresses the grain together with
    // whatever it lands on. That crushes every mote sitting on the beam — precisely where they are
    // brightest and most worth seeing — and passes them through the depth of field besides, which
    // smears specks that should be pixel-sharp. The shader therefore tone maps and encodes each
    // grain on its own; see DUST_FRAG.
    this.renderDust();
  }

  /** The dust field, over the finished frame. Nothing else may draw after it. */
  private renderDust(): void {
    if (!this.dustMesh || !this.dustMaterial || !this.bloomLevels) return;
    const u = this.dustMaterial.uniforms;
    // Brightness from the sixteenth-res UNTHRESHOLDED field, hue from a mid bloom level. Two
    // different textures on purpose: the field is broad enough to say whether light reaches a
    // grain at all, and far too broad to say what colour it is.
    u.tLight.value = this.bloomLevels[3].a.texture;
    u.tColor.value = this.bloomLevels[1].a.texture;
    u.uTime.value = this.time;
    u.uCamDist.value = Math.abs(this.camera.position.z);
    (u.uRes.value as THREE.Vector2).set(this.colorRT.width, this.colorRT.height);
    this.renderer.render(this.dustScene, this.camera);
  }

  /**
   * Re-render a single frame when the loop is not running, so edits made while paused, offscreen
   * or under reduced motion still show up.
   *
   * It goes through `seek`, not `renderOnce`: the camera is positioned in `step`/`seek`, so a
   * bare `renderOnce` would redraw with whatever pose the last frame left behind — which is why
   * orbiting or resetting the camera on a paused scene appeared to do nothing.
   */
  private renderIfIdle(): void {
    if (!this.running && !this.capturing) this.seek(this.time);
  }

  private step(now: number): void {
    const delta = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    // The intro ramp scales ACCUMULATION, not the clock: `seek()` still sets an absolute time, so
    // captures, posters and thumbnails are unaffected and stay reproducible.
    if (this.introRamp < 1) this.introRamp = Math.min(1, this.introRamp + delta); // ~1s ramp
    this.time += delta * (this.config.introRamp ? this.introRamp : 1);
    if (this.interaction) {
      this.updateItemHover(this.interaction); // resolve `hoverSelf` before the sources advance
      this.interaction.update(delta); // advance smoothed input by the SAME delta
    }
    // A timeOffset binding scrubs the clock the motions and the liquid ripple read — as a DELTA,
    // so the authored timeline is untouched and removing the binding restores it.
    const t = this.time + this.interactionTime;
    applyMotions(this.items, t, this.config.loopSeconds);
    this.frameCallback?.(t, delta, this.items);
    this.updateCamera(true);
    this.renderOnce();
  }

  private loop = (now: number): void => {
    this.rafId = 0;
    if (!this.running) return;
    this.step(now);
    this.rafId = requestAnimationFrame(this.loop);
  };

  /** Replace the per-frame callback. Runs after the configured motion, so it can override it. */
  onFrame(callback: FrameCallback | null): this {
    this.frameCallback = callback;
    return this;
  }

  start(): this {
    this.started = true;
    this.updateRunning();
    return this;
  }

  stop(): this {
    this.started = false;
    this.updateRunning();
    return this;
  }

  /** Re-evaluate whether the loop should be running (`paused`, visibility, reduced motion). */
  refreshPlayback(): void {
    this.updateRunning();
  }

  private updateRunning(): void {
    const shouldRun =
      this.started &&
      this.visible &&
      this.pageVisible &&
      !this.config.paused &&
      !this.reducedMotion &&
      !this.disposed;

    if (shouldRun && !this.running) {
      this.running = true;
      this.lastFrame = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
    } else if (shouldRun && this.running && this.rafId === 0) {
      // Belt and braces: a frame was cancelled (context loss) or never scheduled while we still
      // consider ourselves running. Without this the scene freezes with no way back.
      this.lastFrame = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
    } else if (!shouldRun && this.running) {
      this.running = false;
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (!this.running && !this.capturing && !this.disposed) {
      // An authored halt (never started, `stop()`, `paused`, reduced motion) settles the camera
      // and shows the frame the scene opens on — the poster contract. An ENVIRONMENTAL pause
      // (tab hidden, scrolled out of view) freezes at the current time instead, so scrolling a
      // hero away and back resumes the motion rather than restarting it; a hidden tab skips the
      // paint entirely — nobody can see it, and becoming visible re-enters here.
      // Collapse pointer/input to rest before the one settled frame — reduced-motion users must
      // see the final entered state, not a frozen mid-gesture.
      this.interaction?.settle();
      if (!this.started || this.config.paused || this.reducedMotion) {
        this.seek(this.config.timeOffset);
      } else if (this.pageVisible) {
        this.seek(this.time);
      }
    }
  }

  /** Jump to a fixed animation time and render that frame. This is what a poster capture uses:
   *  the same config plus the same `time` always produces the same pixels. */
  seek(time: number): void {
    this.time = time;
    applyMotions(this.items, this.time, this.config.loopSeconds);
    this.frameCallback?.(this.time, 0, this.items);
    this.updateCamera(false);
    this.renderOnce();
  }

  private onMotionChange = (e: MediaQueryListEvent): void => {
    this.reducedMotion = this.respectReducedMotion && e.matches;
    this.updateRunning();
  };

  private onVisibilityChange = (): void => {
    this.pageVisible = document.visibilityState === "visible";
    this.updateRunning();
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault(); // tell the browser we intend to recover → no "Aw, Snap"
    cancelAnimationFrame(this.rafId);
    this.running = false;
  };

  private onContextRestored = (): void => {
    // Every GPU resource from the old context is invalid; rebuild the items and re-push uniforms.
    this.buildItems();
    this.refresh();
    this.resize();
    this.updateRunning();
  };

  // ----------------------------------------------------------------- output ---

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  // ------------------------------------------------------- direct manipulation ---

  /** Normalized device coords for a client point, or null if it is outside the canvas. */
  private toNdc(clientX: number, clientY: number): THREE.Vector2 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return this.pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /**
   * The glass shape under a client point, nearest first, or null.
   *
   * Raycasts the geometry, not the picture: refraction displaces a shape's apparent silhouette by
   * a few pixels at the rim, so a pixel-accurate pick would disagree with where the shape actually
   * *is* — which is what a drag then moves.
   */
  pick(clientX: number, clientY: number): MaterialItem | null {
    const ndc = this.toNdc(clientX, clientY);
    if (!ndc) return null;
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = this.items.map((item) => item.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    return this.items.find((item) => item.mesh === hit.object) ?? null;
  }

  /**
   * The screen-space bounding box of an item, in CSS pixels relative to the canvas — what a DOM
   * selection overlay needs. Null when the item is entirely behind the camera.
   *
   * Every one of the box's eight corners is projected and re-bounded, rather than projecting the
   * box's own min/max: perspective means a rotated box's projected extent is not the projection of
   * its extent, and a long rod tilted toward the camera is exactly that case.
   */
  projectBounds(
    item: MaterialItem,
  ): { x: number; y: number; width: number; height: number } | null {
    const geometry = item.mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const local = geometry.boundingBox;
    if (!local) return null;
    this.scene.updateMatrixWorld(true);

    const rect = this.canvas.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      this.projectScratch
        .set(
          corner & 1 ? local.max.x : local.min.x,
          corner & 2 ? local.max.y : local.min.y,
          corner & 4 ? local.max.z : local.min.z,
        )
        .applyMatrix4(item.mesh.matrixWorld)
        .project(this.camera);
      if (this.projectScratch.z > 1) return null; // behind the camera
      const x = ((this.projectScratch.x + 1) / 2) * rect.width;
      const y = ((1 - this.projectScratch.y) / 2) * rect.height;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Where a client point lands on the plane that faces the camera and passes through `through`.
   *
   * This is the drag surface. A camera-facing plane is what makes a drag feel like "the shape
   * follows my cursor" — constraining to a world axis instead would send it sliding off in a
   * direction the pointer never moved.
   */
  pointOnDragPlane(
    clientX: number,
    clientY: number,
    through: THREE.Vector3,
    out = new THREE.Vector3(),
  ): THREE.Vector3 | null {
    const ndc = this.toNdc(clientX, clientY);
    if (!ndc) return null;
    this.camera.getWorldDirection(this.planeNormal);
    this.dragPlane.setFromNormalAndCoplanarPoint(this.planeNormal, through);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.intersectPlane(this.dragPlane, out);
  }

  /** The camera's view direction — the axis a depth-drag moves along. */
  viewDirection(out = new THREE.Vector3()): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }

  /** Every item currently in the scene, in config order. */
  getItems(): readonly MaterialItem[] {
    return this.items;
  }

  /** Whether the animation loop is currently advancing. Note this is not the same as "started":
   *  a started scene stops while it is offscreen, hidden, paused or under reduced motion. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * The renderer's own config object — the live one it reads every frame.
   *
   * This is NOT the object you passed in: the constructor and {@link setConfig} both run it
   * through `ensureSceneConfig`, which returns a normalized copy. An editor that wants to mutate
   * settings in place must adopt what this returns; holding on to the object it handed in means
   * mutating something nothing reads.
   */
  getConfig(): SceneConfig {
    return this.config;
  }

  /**
   * Swap in a whole config. Rebuilds geometry only when something structural changed — the item
   * list, the scatter, or the quality (which recompiles the post shader's tap count).
   */
  setConfig(config: Partial<SceneConfig>): void {
    const previous = this.config;
    const next = ensureSceneConfig(config);
    const structural =
      next.quality !== previous.quality ||
      // Changes the colour targets' pixel type — see the constructor.
      next.post.toneMap !== previous.post.toneMap ||
      JSON.stringify(next.scatter) !== JSON.stringify(previous.scatter) ||
      JSON.stringify(next.items) !== JSON.stringify(previous.items);

    this.config = next;
    if (next.camera.distance !== previous.camera.distance) this.distance = next.camera.distance;

    if (structural) this.rebuild();
    else {
      this.refresh();
      this.resize();
      this.updateRunning();
    }
  }

  /**
   * Rebuild geometry and the post shader from the current config, then re-push everything.
   *
   * An editor mutating the config in place has to call this rather than rely on {@link setConfig}:
   * that method decides "structural" by diffing the incoming config against the one it holds, and
   * when they are the same object — which is exactly what `getConfig()` hands an editor — the diff
   * is empty and the rebuild never happens. The caller knows what it changed; the renderer can't.
   */
  rebuild(): void {
    this.postMaterial.defines = this.postDefines();
    this.postMaterial.needsUpdate = true;
    this.buildItems();
    this.refresh();
    this.resize();
    this.updateRunning();
  }

  /**
   * Capture the current frame as an image Blob — the poster path.
   * Pass `time` for a reproducible frame (0 = the frame the scene opens on) so a poster
   * regenerated later is byte-comparable instead of whatever happened to be on screen.
   */
  async captureImage(mime = "image/webp", quality?: number, time?: number): Promise<Blob> {
    const previousTime = this.time;
    this.capturing = true;
    // Strip the live interaction state BEFORE the camera is posed for the capture frame;
    // applyInteractionRest handles the uniforms, but the camera is set in seek(), earlier.
    //
    // THE ORBIT PAIR BELONGS HERE TOO, and leaving it out was a real bug: `updateCamera` reads
    // `orbitYaw`/`orbitPitch` straight out of the out-params, so a capture was taken from wherever
    // the last live frame had swung the camera. On a scene that binds `cameraYaw` this is not a
    // small error and it is not zero at rest — before any pointer arrives the sources read 0, not
    // their midpoint, so `prism` captured from a camera swung to the binding's `from` end: -3.5
    // degrees of yaw and -3 of pitch. Every poster and every export of such a scene was framed
    // from a position the config never asked for.
    //
    // It stayed hidden because it moves the camera by about a degree of arc, which is invisible in
    // anything except a specular highlight — where `pow(dot(...), 40)` turns it into a factor of
    // three, and which is exactly how it was eventually found.
    this.interactionTime = 0;
    this.interactionZoom = 1;
    this.interactionSceneOut.orbitYaw = 0;
    this.interactionSceneOut.orbitPitch = 0;
    try {
      if (time === undefined) this.renderOnce();
      else this.seek(time);
      const blob = await new Promise<Blob | null>((resolve) =>
        this.canvas.toBlob(resolve, mime, quality),
      );
      if (!blob || blob.type !== mime) throw new Error(`Failed to capture ${mime}`);
      return blob;
    } finally {
      this.capturing = false;
      if (time !== undefined) this.seek(previousTime);
    }
  }

  captureStream(fps = 60): MediaStream {
    return this.canvas.captureStream(fps);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    cancelAnimationFrame(this.resizeRaf);
    this.interaction?.dispose();
    this.interaction = undefined;
    this.listeners.abort();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    this.clear();
    this.screenQuad.dispose();
    this.backdrop.geometry.dispose();
    this.backdropMaterial.dispose();
    for (const level of this.bloomLevels ?? []) {
      level.a.dispose();
      level.b.dispose();
    }
    this.dustMesh?.geometry.dispose();
    this.dustMaterial?.dispose();
    this.bloomExtract?.dispose();
    this.bloomBlur?.dispose();
    this.bloomDown?.dispose();
    this.particleDown?.dispose();
    this.bloomComposite?.dispose();
    this.backGlass?.dispose();
    this.causticMaterial?.dispose();
    this.beamMesh?.geometry.dispose();
    this.beamMaterial?.dispose();
    this.disposeMedia();
    this.depthMaterial.dispose();
    this.postMaterial.dispose();
    this.finishMaterial.dispose();
    this.postRT.dispose();
    this.backRT.dispose();
    this.backMaterial.dispose();
    this.colorRT.dispose();
    this.bgRT.dispose();
    this.depthRT.dispose();
    this.renderer.dispose();
    if (this.ownsCanvas) this.renderer.domElement.remove();
  }
}
