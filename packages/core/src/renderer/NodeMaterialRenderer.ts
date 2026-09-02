/**
 * The TSL engine: the same scenes, drawn through three's node renderer.
 *
 * Deliberately a SIBLING of {@link MaterialRenderer} rather than a replacement. The two are
 * separate three builds sharing only `three.core`, so a bundler can keep the node renderer out of
 * a default consumer's download entirely — which it cannot do if one engine imports the other.
 * `core-loader-webgpu` is the seam; see `MaterialOptions.renderer`.
 *
 * It runs on a WebGL backend unless the browser offers WebGPU, so opting in selects the ENGINE and
 * not the backend. That also means the visual target is exact parity with the GLSL renderer: every
 * pass here has a twin in `shaders.ts`, and the way to trust a port is to render both and diff.
 *
 * MIGRATION STATUS: the pass pipeline is being ported incrementally. Anything not yet ported falls
 * through to a documented gap rather than silently drawing nothing — see `renderPending`.
 */
import * as THREE from "three/webgpu";
import { TSL } from "three/webgpu";

import {
  ensureSceneConfig,
  type SceneConfig,
  type PostConfig,
  type LampConfig,
} from "../config/model";
import { parseHex } from "../util/color";
import type { Engine } from "../engine";
import {
  blitPass,
  particleDownPass,
  bloomBlurPass,
  bloomCompositePass,
  bloomDownPass,
  bloomExtractPass,
  envBakePass,
  envBlurPass,
} from "./nodes/passes";
import { postPass } from "./nodes/post";
import {
  BLOOM_DIVISORS,
  BLOOM_TAPS,
  createTargets,
  disposeTargets,
  FullScreenQuad,
  passMaterial,
  resizeTargets,
  type PassTargets,
} from "./nodes/pipeline";
import {
  BACKGROUND_MODES,
  FAR,
  MATERIAL_KINDS,
  MAX_LAMPS,
  MAX_MESH_POINTS,
  MAX_STOPS,
  normalizeMotion,
  normalizeShape,
  resolveMaterial,
} from "../config/model";
import type { ItemConfig } from "../config/model";
import type { MaterialItem } from "./item";
import { buildShape, defaultPath } from "./shapes";
import { frameFov, resolveItems, type AddOptions } from "./MaterialRenderer";
import {
  InteractionController,
  interactionActive,
  ITEM_APPLIERS,
  LAMP_APPLIERS,
  SCENE_APPLIERS,
  type ItemApplyArgs,
  type SceneApplyArgs,
} from "./interaction";
import { applyMotions, loopFrequency } from "./motions";
import {
  aimBeam,
  aimBeamAtAngle,
  buildLightSheet,
  crossSectionFor,
  prismCrossSection,
} from "./lightSheet";
import { backdropPass, GROUND_SLOTS } from "./nodes/backdrop";
import { finishPass } from "./nodes/finish";
import { beamPass, causticPass, dustPass, dustVertex, outsideSection } from "./nodes/beam";
import {
  backGlassPass,
  backplate,
  decodeDepth,
  depthPass,
  platePass,
  prismExit,
  rippleNormal,
} from "./nodes/glass";
import { glitter, thinFilm } from "./nodes/brdf";
import { shadeOpaque } from "./nodes/opaque";
import {
  bendDir,
  coneTransmission,
  rotateHue,
  simpleTransmission,
  transmittedHue,
} from "./nodes/transmissive";
import {
  linearToSrgb,
  srgbToLinear,
  studioCone,
  studioGradient,
  studioRoom,
  tonemapAces as tonemapAcesNode,
} from "./nodes/common";

/** Mirrors {@link MaterialRendererOptions}; the shell hands the same object to either engine. */
export interface NodeMaterialRendererOptions {
  respectReducedMotion?: boolean;
  canvas?: HTMLCanvasElement;
  preserveDrawingBuffer?: boolean;
}

const { Fn, vec3, vec4, uniform, uv } = TSL;

/**
 * Which intermediate a dev harness has asked to see instead of the composed frame.
 *
 * Read through one accessor rather than a global declaration so there is a single place to look for
 * it, and via a string key because the name is deliberately unlikely to collide — never set in
 * production, where this returns undefined and every probe compiles out.
 */
const devProbe = (): string | undefined =>
  (globalThis as Record<string, unknown>)["__tslDebug"] as string | undefined;

/** sRGB hex to the 0..1 triple the graphs want. */
const rgb = (hex: string): [number, number, number] => parseHex(hex) as [number, number, number];

/** One texel of a target, in uv — the step every separable blur walks by. */
const texel = (target: THREE.RenderTarget) =>
  TSL.vec2(1 / Math.max(target.width, 1), 1 / Math.max(target.height, 1));

/**
 * A settable uniform, structurally.
 *
 * `three/webgpu` does not re-export `IUniform`, and the appliers only ever assign `.value`, so the
 * shape is what matters rather than the nominal type from the other build.
 */
interface UniformCell {
  value: unknown;
}

/**
 * This engine's item uniforms under the GLSL engine's names.
 *
 * The interaction appliers in `./interaction` are shared by both renderers and address uniforms by
 * the GLSL engine's names. Reusing them is deliberate: binding semantics — which target reads which
 * authored base, how a value is clamped — are exactly the kind of thing that drifts if written
 * twice, and a scene whose reactions behave differently depending on the engine is worse than one
 * that has none. So the names are adapted here rather than the table being duplicated.
 */
const bindingUniforms = (
  u: Record<string, ReturnType<typeof uniform>>,
): Record<string, UniformCell> => ({
  uSigma: u.density,
  uIOR: u.ior,
  uDisp: u.dispersion,
  uLens: u.lens,
  uBend: u.bend,
  uRim: u.rim,
  uSpec: u.spec,
  uSat: u.saturation,
  uHue: u.hueShift,
  uEmis: u.emission,
  uIrid: u.iridescence,
  uFilm: u.filmNm,
  uRipple: u.ripple,
});

/** Plane slots per traced solid. Matches the GLSL `uPrismPlanes[6]` — see `buildItemMaterial`. */
const PRISM_PLANES = 6;

/** World-space `(normal, offset)` for a plane given in an item's local frame. */
function writePlane(
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
 * A scratch target for one step of the environment chain.
 *
 * Wraps horizontally and clamps vertically, which is what an equirect map needs: the seam at
 * phi = ±pi is continuous and has to blur across, while the poles are not and must not.
 */
const envScratch = (w: number, h: number) =>
  new THREE.RenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
  });

/**
 * The two studio key directions the transmissive specular lobe looks for.
 *
 * Constants, not uniforms — they are the studio's own geometry, shared by every material, and
 * GLASS_FRAG declares them the same way. Normalized here so the graph carries the same numbers the
 * GLSL does rather than re-deriving them per fragment.
 */
const KEY = TSL.vec3(...new THREE.Vector3(-0.3, 0.86, 0.42).normalize().toArray());
const KEY_FILL = TSL.vec3(...new THREE.Vector3(0.42, 0.16, 0.89).normalize().toArray());

/** Level 0 of the baked room, in texels. The height is half this — an equirect map is 2:1. */
const ENV_WIDTH = 512;
/** Mips in the chain; the widest cone a material can ask for is the last one. */
const ENV_LEVELS = 8;

/** How many total internal reflections the back-glass walk follows before giving up. */
const BACK_GLASS_BOUNCES = 4;

/** See `nodes/common` — three's TSL types resolve the wrong overload for a relaxed node. */
type Vec = any;
// CONDITION FIRST — see the note in `nodes/common`.
const select = (cond: Vec, ifTrue: Vec, ifFalse: Vec): Vec => TSL.select(cond, ifTrue, ifFalse);
const blend = (a: Vec, b: Vec, t: Vec): Vec => TSL.mix(a, b, t);

/**
 * The node/TSL engine — EXPERIMENTAL.
 *
 * A second renderer built on three's `WebGPURenderer` and TSL, implementing the same {@link Engine}
 * surface as `MaterialRenderer` so a scene config can be handed to either. It runs every preset and
 * is close on most of them, but it is NOT pixel-equal to the WebGL engine, which is the reference.
 *
 * `WEBGPU.md` in the repo root is the place to look: it carries the per-preset numbers, what is
 * known to differ, what has already been ruled out, and how to use the dev probes below — they
 * bypass post, and there are two calibration probes whose job is to prove a crop is trustworthy
 * before anything measured on it is believed. On a validated interior crop every material
 * intermediate now matches exactly; what remains is sub-pixel geometry, the wall shader, and post.
 */
export class NodeMaterialRenderer implements Engine {
  readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly ownsCanvas: boolean;
  private config: SceneConfig;
  private frame = 0;
  private running = false;
  /**
   * The draw in flight, if any — this renderer's ONE piece of concurrency control.
   *
   * KEPT, though `draw()` no longer yields mid-frame. Every pass is now issued through the
   * synchronous `render()` rather than awaited through the deprecated `renderAsync`, so the
   * interleaving this guards against cannot currently happen — but `draw` is still an async
   * function, it still mutates shared state a partial run would corrupt (`passIndex`, the plate
   * binding, the clear colour, `scene.overrideMaterial`, and the visibility of the backdrop and
   * beam), and one `await` reintroduced anywhere inside it brings the hazard straight back.
   *
   * What that looked like: two draws interleaved, the second read the flags the first had already
   * cleared, saved `false` as "was visible" and restored that — so the backdrop and beam stayed
   * hidden for every frame afterwards. It never reproduced under a software adapter, where the
   * awaits resolved almost immediately, and showed up only on a real GPU.
   */
  private drawing: Promise<void> | null = null;
  private time = 0;
  /** `performance.now()` at the previous frame — the clock the scene actually advances on. */
  private lastFrame = 0;
  /** Eases accumulation in over the first second, so a scene does not snap into motion. */
  private introRamp = 0;
  private ready: Promise<void>;
  private targets?: PassTargets;
  private readonly quad = new FullScreenQuad();
  /** Built once the targets exist, because every one of them closes over a target's texture. */
  private passes?: {
    extract: THREE.NodeMaterial;
    down: THREE.NodeMaterial[];
    blur: { h: THREE.NodeMaterial; v: THREE.NodeMaterial }[];
    composite: THREE.NodeMaterial;
    post: THREE.NodeMaterial;
    /** The dust light field: an unthresholded downsample of the frame, blurred wide. */
    particle: { down: THREE.NodeMaterial; blurH: THREE.NodeMaterial; blurV: THREE.NodeMaterial };
  };

  /** Backdrop uniforms, held so a config change is a write rather than a rebuild. */
  private readonly top = uniform(vec3(0, 0, 0));
  private readonly bottom = uniform(vec3(0, 0, 0));
  private readonly toneMode = uniform(0);
  private readonly bloomThreshold = uniform(0.5);
  private readonly bloomRadius = uniform(0.5);
  private readonly bloomAmount = uniform(0);
  private readonly bloomMode = uniform(1);
  private readonly focus = uniform(10);
  private readonly range = uniform(6);
  private readonly aperture = uniform(0);
  private readonly caustics = uniform(0);
  private readonly haze = uniform(0);
  private readonly hazeTop = uniform(0);
  private readonly hazeColor = uniform(vec3(0, 0, 0));
  private readonly vignette = uniform(0);
  private readonly grain = uniform(0);
  private readonly timeUniform = uniform(0);
  private readonly resolution = uniform(TSL.vec2(1, 1));
  /**
   * The post pass's source flip, which is NOT the scene's `mirror` feature even though it shares
   * the uniform.
   *
   * The node renderer hands back a render-target texture with the opposite vertical orientation to
   * the one a full-screen quad's uv walks, so a frame composed through a target arrives upside
   * down. Correcting it here rather than inside `postPass` keeps the pass itself a faithful twin of
   * the GLSL original — the parity harness feeds it plain textures, where no such flip exists, and
   * a flip baked into the graph would make that comparison a lie.
   */
  private readonly sourceFlip = uniform(TSL.vec2(0, 1));
  /** 1: every blit-written target on this backend is stored row-inverted. Constant here and 0 in
   *  the parity harness, which feeds the same passes plain textures — see `blitUv` in ./nodes/passes. */
  private readonly blitFlip = uniform(1);
  /** `mirrorH`/`mirrorV` alone, for post's SCREEN coordinate — `sourceFlip` has the storage
   *  inversion folded in and cannot serve that role. */
  private readonly sceneMirror = uniform(TSL.vec2(0, 0));
  /** The full drawing buffer, for the finish pass — whose patterns are authored in DEVICE pixels
   *  and so must not shrink with `quality`. `resolution` is the quality-scaled scene size. */
  private readonly outputResolution = uniform(TSL.vec2(1, 1));
  /** `quality`, keeping post's gather radii the same fraction of a smaller frame. */
  private readonly postScale = uniform(1);
  /**
   * 0 while drawing the plate, 1 while drawing the main pass.
   *
   * One material serving both passes, toggled between them, rather than two materials per shape:
   * the plate is the same frame with refraction disabled, so duplicating the program to express
   * "the same thing minus one lookup" doubles the compile cost for nothing.
   */
  private readonly passIndex = uniform(0);
  private readonly clearGlass = uniform(vec3(1, 1, 1));
  private readonly aspect = uniform(1);
  private placeholder?: THREE.DataTexture;
  private readonly measuredThickness = uniform(0);
  /** Scratch for the front depth pass's clear colour, which encodes the focal distance. */
  private readonly depthClear = new THREE.Color();
  /** 1 for `transmission: "cone"`, 0 for the three-ray default. */
  private readonly coneMode = uniform(0);
  /**
   * Back-face linear depth, as an override material.
   *
   * BACK faces, not front: what the main pass wants is the far side of each solid, because the
   * distance between that and the fragment it is shading is the optical path light actually
   * travelled. Rendering front faces here would measure the distance to the surface you can
   * already see, which is zero.
   */
  private depthMaterial?: THREE.NodeMaterial;
  /** The same encoding, front faces — what the depth of field measures its blur against. */
  private frontDepthMaterial?: THREE.NodeMaterial;
  private plateSource?: Vec;
  private plainSource?: Vec;
  private plainPlaceholder?: THREE.DataTexture;
  private debugBlit?: THREE.NodeMaterial;
  private debugColor?: THREE.NodeMaterial;
  private debugEnv?: THREE.NodeMaterial;
  private debugAlpha?: THREE.NodeMaterial;
  private backdrop?: THREE.Mesh;
  /** Camera orbit, and the scratch the picking and projection helpers reuse. */
  private yaw = 0;
  private pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private distance = 0;
  /** One signal for every DOM listener this renderer owns, so `dispose` drops them together. */
  private readonly listeners = new AbortController();
  private outputSize?: { width: number; height: number };
  private frameCallback: ((time: number) => void) | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly dragPlane = new THREE.Plane();
  private readonly planeNormal = new THREE.Vector3();
  private readonly projectScratch = new THREE.Vector3();
  private interaction?: InteractionController;
  /**
   * Interaction state, mirroring the GLSL engine field for field.
   *
   * The controller was already being CREATED here, which is what made this look wired up: it
   * tracked the pointer, smoothed its sources and answered `bindingValue` correctly. Nothing ever
   * asked it. No `update`, no applier pass, no read-back — so every reaction in every scene was
   * inert on this engine while looking, from the config's side, entirely present.
   */
  /** Set around `captureImage`: exports render the interaction REST state, never live input. */
  private capturing = false;
  private interactionTime = 0;
  private interactionZoom = 1;
  private readonly interactionSceneOut = {
    timeOffset: 0,
    zoom: 1,
    beamIncidence: 0,
    beamEntry: 0.5,
    orbitYaw: 0,
    orbitPitch: 0,
  };
  /** The resolved item list the controller indexes into — scatter included. */
  private resolvedItems: ItemConfig[] = [];
  private readonly hoverNdc = new THREE.Vector2();
  private readonly hoverCandidates: THREE.Object3D[] = [];
  /** What the beam mesh was last traced from, so an unchanged pointer does not retrace it. */
  private beamTracedFrom: { incidence: number; entry: number } | null = null;
  private scrollPreview: number | null = null;
  /** Backdrop uniforms beyond the derived ramp — the palette, the image and the wall. */
  private readonly bgMode = uniform(0, "int");
  private readonly bgGradType = uniform(0, "int");
  private readonly bgAngle = uniform(0);
  private readonly bgShow = uniform(0);
  private readonly bgSize = uniform(TSL.vec2(160, 110));
  private readonly bgFrame = uniform(TSL.vec2(1, 1));
  private readonly bgStopData = Array.from({ length: MAX_STOPS }, () => new THREE.Vector4());
  private readonly bgStops = TSL.uniformArray(this.bgStopData);
  private readonly bgStopCount = uniform(0, "int");
  private readonly bgMeshData = Array.from({ length: MAX_MESH_POINTS }, () => new THREE.Vector4());
  private readonly bgMeshColorData = Array.from(
    { length: MAX_MESH_POINTS },
    () => new THREE.Vector3(),
  );
  private readonly bgMesh = TSL.uniformArray(this.bgMeshData);
  private readonly bgMeshColors = TSL.uniformArray(this.bgMeshColorData);
  private readonly bgMeshCount = uniform(0, "int");
  private readonly bgMeshSoft = uniform(0.55);
  private readonly bgHasImage = uniform(0, "int");
  private readonly bgImageFit = uniform(0, "int");
  private readonly bgImageZoom = uniform(1);
  private readonly bgImageAspect = uniform(1);
  private readonly bgImageOffset = uniform(TSL.vec2(0.5, 0.5));
  private bgImageTexture?: THREE.Texture;
  private bgVideo?: HTMLVideoElement;
  private bgMediaUrl?: string;
  private bgImageNode?: Vec;
  // The wall. Every one of these is authored, and the defaults are the reference's.
  private readonly wallExtent = uniform(TSL.vec2(1, 1));
  private readonly wallLightUv = uniform(TSL.vec2(0.62, 0.34));
  private readonly wallLightDir = uniform(vec3(-0.45, 0.5, 0.74));
  private readonly wallScale = uniform(1 / 2.4);
  private readonly wallNormal = uniform(0.22);
  private readonly wallMicroFreq = uniform(7);
  private readonly wallMicroNormal = uniform(1.05);
  private readonly wallGamma = uniform(0.65);
  private readonly wallContrast = uniform(6.85);
  private readonly wallPivot = uniform(0.9);
  private readonly wallFloor = uniform(0.87);
  private readonly wallHighlight = uniform(3.31);
  private readonly wallAmbient = uniform(0.42);
  private readonly wallAmbientLight = uniform(0.1);
  private readonly wallShadow = uniform(0.55);
  private readonly wallGrounding = uniform(0.85);
  private readonly groundData = Array.from({ length: GROUND_SLOTS }, () => new THREE.Vector4());
  private readonly groundPhaseData = Array.from({ length: GROUND_SLOTS }, () => 0);
  private readonly ground = TSL.uniformArray(this.groundData);
  private readonly groundPhase = TSL.uniformArray(this.groundPhaseData, "float");
  private readonly groundCount = uniform(0, "int");

  /**
   * The finish pass — print effects over the composed frame.
   *
   * Skipped entirely when none is on, which is the usual case: the post pass then draws straight
   * to the screen and the extra target is never allocated.
   */
  private finishMaterial?: THREE.NodeMaterial;
  private finishSource?: Vec;
  private readonly fnInner = uniform(0);
  private readonly fnInnerDensity = uniform(0.5);
  private readonly fnInnerDecay = uniform(0.94);
  private readonly fnInnerCentre = uniform(TSL.vec2(0.5, 0.15));
  private readonly fnDither = uniform(0);
  private readonly fnDitherScale = uniform(2);
  private readonly fnDitherSteps = uniform(4);
  private readonly fnHalftone = uniform(0);
  private readonly fnHalftoneCell = uniform(6);
  private readonly fnHalftoneAngle = uniform(0.4);
  private readonly fnCmyk = uniform(0);
  private readonly fnCmykCell = uniform(6);
  private readonly fnPaper = uniform(0);
  private readonly fnPaperScale = uniform(2);
  /**
   * The dust field, drawn additively over the FINISHED frame.
   *
   * Its own scene, because nothing else may draw after it and it must not be swept up by the
   * override material the depth passes install.
   */
  private dustMesh?: THREE.Mesh;
  private dustMaterial?: THREE.NodeMaterial;
  private readonly dustScene = new THREE.Scene();
  /** `count:seed`; the geometry is rebuilt only when one of those changes. */
  private dustKey = "";
  private readonly dustTime = uniform(0);
  private readonly dustSize = uniform(1);
  private readonly dustDrift = uniform(0.25);
  private readonly dustIntensity = uniform(1);
  private readonly dustResponse = uniform(82);
  private readonly dustFalloff = uniform(5.5);
  private readonly dustExtent = uniform(vec3(0, 0, 0));
  private readonly dustPlaneZ = uniform(0);
  private readonly dustCamDist = uniform(1);
  private readonly dustExposure = uniform(0.72);
  private readonly dustSectionA = uniform(TSL.vec2(0, 0));
  private readonly dustSectionB = uniform(TSL.vec2(0, 0));
  private readonly dustSectionC = uniform(TSL.vec2(0, 0));
  private beamMesh?: THREE.Mesh;
  /** The caustic draws the SAME traced geometry a second time, lying on the wall. */
  private causticMesh?: THREE.Mesh;
  private readonly causticEdge = uniform(16);
  private readonly causticStrength = uniform(1.9);
  private readonly causticCoverage = uniform(0.86);
  private readonly causticNormalInfluence = uniform(1);
  private readonly causticNormalElevation = uniform(35);
  private readonly causticBeamDir = uniform(TSL.vec2(1, 0));
  private readonly beamReveal = uniform(1);
  /** One entry per configured item; rebuilt when the shapes change, not per frame. */
  private items: {
    mesh: THREE.Mesh;
    uniforms: Record<string, ReturnType<typeof uniform>>;
    /** World-space `(normal, offset)` per bounding face; zeroed until `applyPrismPlanes` fills it. */
    planes: THREE.Vector4[];
    /** The resolved material and the GLSL-named uniform view — both only for the interaction
     *  appliers; see `bindingUniforms`. Absent on items added through `add()`, which carry no
     *  authored material config for a binding to read a base from. */
    base?: ReturnType<typeof resolveMaterial>;
    bound?: Record<string, UniformCell>;
    config?: ItemConfig;
    motion: ItemConfig["motion"];
    phase: number;
    /** The AUTHORED pose. Motions read from here rather than accumulating onto the live transform,
     *  so pausing, scrubbing and capturing a fixed frame all land in the same place. */
    home: THREE.Vector3;
    homeRotation: THREE.Euler;
    homeScale: THREE.Vector3;
  }[] = [];
  private readonly normalScratch = new THREE.Matrix3();
  /** The back-glass material and the scene it is drawn through; built on first use. */
  private backGlass?: {
    material: THREE.NodeMaterial;
    planes: THREE.Vector4[];
    count: ReturnType<typeof uniform>;
    ior: ReturnType<typeof uniform>;
    strength: ReturnType<typeof uniform>;
    depth: ReturnType<typeof uniform>;
  };
  private readonly backGlassScene = new THREE.Scene();
  /**
   * The lamp field, as uniform arrays.
   *
   * Fixed length rather than sized to the scene: a node graph is compiled per material, and a
   * changing array length would recompile every one of them whenever a lamp is added. The count
   * uniform is what actually bounds the walk.
   */
  private readonly lampData = Array.from(
    { length: MAX_LAMPS },
    () => new THREE.Vector4(0, 0, 1, 0),
  );
  private readonly lampColors = Array.from({ length: MAX_LAMPS }, () => new THREE.Vector3());
  private readonly lampArray = TSL.uniformArray(this.lampData);
  private readonly lampColorArray = TSL.uniformArray(this.lampColors);
  private readonly lampCount = uniform(0, "int");
  private readonly lampGain = uniform(1);
  private readonly lampLo = uniform(0);
  private readonly lampHi = uniform(1);
  /**
   * The room, as uniforms both engines' materials read through one lookup.
   *
   * Held here rather than rebuilt per material so a change of studio or a fresh bake is a uniform
   * write, and so the analytic fallback and the baked chain cannot drift apart: `studioCone`
   * switches between them on `envOn`, and every surface in the scene goes through it.
   */
  private readonly envOn = uniform(0);
  private readonly envSize = uniform(TSL.vec2(ENV_WIDTH, ENV_WIDTH / 2));
  private readonly envTexelAngle = uniform((Math.PI * 2) / ENV_WIDTH);
  private readonly envLevels = uniform(ENV_LEVELS);
  private readonly studioMode = uniform(0);
  private readonly studioGain = uniform(1);
  private envTarget?: THREE.RenderTarget;
  /** Guards the bake: the room is a pure function of these, so a scene that never changes them bakes once. */
  private envKey = "";
  private envPasses?: {
    bake: THREE.NodeMaterial;
    blur: THREE.NodeMaterial;
    copy: THREE.NodeMaterial;
    /** The blur's and the copy's sources, swapped per level rather than recompiled. */
    blurSource: Vec;
    copySource: Vec;
  };
  private readonly envBlurTexel = uniform(TSL.vec2(1, 1));
  private readonly envBlurDir = uniform(TSL.vec2(1, 0));
  private readonly envBlurCompensate = uniform(1);

  private readonly plateZ = uniform(-3);
  private readonly plateScale = uniform(TSL.vec2(1, 1));
  private readonly plateOffset = uniform(TSL.vec2(0.5, 0.5));

  constructor(
    container: HTMLElement,
    config: Partial<SceneConfig>,
    options: NodeMaterialRendererOptions = {},
  ) {
    this.container = container;
    this.config = ensureSceneConfig(config);
    this.ownsCanvas = !options.canvas;
    this.renderer = new THREE.WebGPURenderer({
      canvas: options.canvas,
      antialias: true,
      alpha: true,
    });
    // NO OUTPUT ENCODE. The post pass already ends in the display transfer function — it is a
    // faithful port of POST_FRAG, which does the same — so leaving three's output colour management
    // on encodes the frame a second time. That is not a subtle error: a mid grey leaves the shader
    // at 0.5 and reaches the canvas at 188 rather than 128, which lifts every dark value, compresses
    // every bright one, and reads as a washed-out picture with roughly half the chroma of the WebGL
    // engine's. The WebGL renderer never applied it here because a hand-written `gl_FragColor`
    // shader bypasses three's injected colorspace conversion.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    // `preserveDrawingBuffer` is a WebGL context attribute and the node renderer takes no such
    // option, so the shell's poster capture relies on `captureImage` drawing immediately before it
    // reads the canvas rather than on the buffer surviving a present.
    void options.preserveDrawingBuffer;
    this.canvas = this.renderer.domElement as HTMLCanvasElement;
    if (this.ownsCanvas) {
      this.canvas.style.display = "block";
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      container.appendChild(this.canvas);
    }

    const c = this.config.camera;
    // near 1 / far FAR, matching the WebGL engine exactly. This is not a detail: a 0.1 near plane
    // spends almost the whole depth buffer between 0.1 and 1, leaving the few units the scenes
    // actually occupy sharing what is left — so overlapping back faces stop resolving and the
    // measured optical path goes wrong over large contiguous regions.
    this.camera = new THREE.PerspectiveCamera(c.fov, 1, 1, FAR);
    this.camera.position.set(0, c.height, c.distance);
    this.camera.lookAt(c.lookAt.x, c.lookAt.y, c.lookAt.z);

    this.backdrop = this.buildBackdrop();
    this.scene.add(this.backdrop);
    // `init()` is async on this renderer — it negotiates a device before anything can draw — so
    // every entry point awaits this rather than assuming a ready renderer the way WebGL allows.
    // Seeded from the config, as the WebGL engine seeds it in its constructor. The `|| cam.distance`
    // fallbacks elsewhere hide a zero when nothing has written it, but the wheel handler ADDS to
    // this — from zero the first notch clamps straight to an end stop instead of nudging.
    this.distance = this.config.camera.distance;
    this.bindOrbit();
    this.ready = this.renderer.init().then(() => {
      this.applyConfig();
      // Targets FIRST: an item's graph captures the plate texture, and building before the target
      // exists captures a one-pixel placeholder instead — which renders as glass refracting solid
      // black and reads as the shapes being mysteriously dark.
      this.resize();
      this.buildItems();
      this.buildBeam();
    });
  }

  /**
   * The backdrop, as a node graph.
   *
   * The GLSL twin is BACKDROP_FRAG's gradient branch. It is the first pass ported because it is
   * the one that proves the whole seam end to end — engine selection, node material, tone map,
   * canvas capture — without depending on any of the render targets the later passes need.
   */
  /**
   * The room lookup every surface goes through.
   *
   * A method rather than a field because the graph closes over the environment TEXTURE, and the
   * target is reallocated whenever the chain is rebuilt — a captured reference would keep sampling
   * storage that no longer exists.
   */
  private room(): (dir: Vec, cone: Vec) => Vec {
    return studioCone({
      envOn: this.envOn,
      map: this.envTexture(),
      size: this.envSize,
      texelAngle: this.envTexelAngle,
      levels: this.envLevels,
      softbox: this.studioMode,
      gain: this.studioGain,
    });
  }

  private envTexture(): THREE.Texture {
    this.placeholder ??= new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.needsUpdate = true;
    return this.envTarget?.texture ?? this.placeholder;
  }

  /**
   * Bake the room into an equirectangular mip chain, once per configuration.
   *
   * Rendered into the mip levels of ONE texture rather than kept as eight separate targets, so a
   * shader picks its cone width with a single `lod` argument instead of eight samplers and a manual
   * blend between them.
   *
   * The chain is built through scratch targets rather than by blurring level N-1 in place: a
   * texture cannot be sampled and written by the same draw, and reading the level above while
   * writing the one below is exactly that.
   *
   * Returns whether the item materials have to be rebuilt — they capture the texture, so the first
   * bake and any reallocation invalidate their graphs.
   */
  private async buildEnvironment(): Promise<boolean> {
    const c = this.config;
    if (c.environment !== "baked") {
      const had = this.envTarget !== undefined;
      this.envTarget?.dispose();
      this.envTarget = undefined;
      this.envKey = "";
      this.envOn.value = 0;
      return had;
    }
    const key = `${c.studio}|${c.studioGain}`;
    if (key === this.envKey && this.envTarget) return false;
    this.envKey = key;

    const fresh = this.envTarget === undefined;
    const height = ENV_WIDTH / 2;
    this.envTarget ??= new THREE.RenderTarget(ENV_WIDTH, height, {
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
    this.envTarget.texture.mipmaps = Array.from({ length: ENV_LEVELS }, (_, i) => ({
      width: Math.max(1, ENV_WIDTH >> i),
      height: Math.max(1, height >> i),
    })) as THREE.Texture["mipmaps"];

    let source = envScratch(ENV_WIDTH, height);
    this.envPasses ??= this.buildEnvPasses();
    const previous = this.renderer.getRenderTarget();
    this.quad.blit(this.renderer, this.envPasses.bake, source);
    await this.copyIntoLevel(source, 0);

    for (let level = 1; level < ENV_LEVELS; level++) {
      const w = Math.max(1, ENV_WIDTH >> level);
      const h = Math.max(1, height >> level);
      const horizontal = envScratch(w, h);
      const vertical = envScratch(w, h);
      this.envPasses.blurSource.value = source.texture;
      (this.envBlurTexel.value as THREE.Vector2).set(1 / w, 1 / h);
      (this.envBlurDir.value as THREE.Vector2).set(1, 0);
      this.envBlurCompensate.value = 1;
      this.quad.blit(this.renderer, this.envPasses.blur, horizontal);
      this.envPasses.blurSource.value = horizontal.texture;
      (this.envBlurDir.value as THREE.Vector2).set(0, 1);
      this.envBlurCompensate.value = 0;
      this.quad.blit(this.renderer, this.envPasses.blur, vertical);
      await this.copyIntoLevel(vertical, level);
      horizontal.dispose();
      source.dispose();
      source = vertical;
    }
    source.dispose();
    this.renderer.setRenderTarget(previous);
    this.envOn.value = 1;
    return fresh;
  }

  /**
   * Build, update or tear down the dust field.
   *
   * The geometry is a plain soup of quads rather than instanced draws: two triangles per grain at
   * a few thousand grains is a rounding error next to the scene passes, and it keeps the whole
   * field to one draw call with no extension to feature-detect.
   *
   * Only an INDEX is uploaded per grain — position, size, class, shape, energy and lifetime are
   * hashed from it in the vertex stage — so a respawn costs no buffer write.
   */
  private applyDust(t: PassTargets): void {
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

    this.dustSize.value = dust.size;
    this.dustDrift.value = dust.drift;
    this.dustIntensity.value = dust.intensity;
    this.dustResponse.value = dust.response;
    this.dustFalloff.value = dust.falloffPower;
    (this.dustExtent.value as THREE.Vector3).set(dust.extent.x, dust.extent.y, dust.extent.z);
    // Grains cluster on the light sheet's plane, so they need to know where it is.
    this.dustPlaneZ.value = this.config.beam?.z ?? 0;
    this.dustCamDist.value = Math.abs(this.camera.position.z);
    this.dustTime.value = this.time;

    // The cross-section the grains must not draw over, projected into screen uv.
    const beam = this.config.beam;
    const section = beam ? prismCrossSection(beam.radius, beam.sides, beam.rotation) : [];
    const planeZ = beam?.z ?? 0;
    const slots = [this.dustSectionA, this.dustSectionB, this.dustSectionC];
    for (const [i, slot] of slots.entries()) {
      const c = section[i % Math.max(section.length, 1)];
      const world = new THREE.Vector3(c?.x ?? 0, c?.y ?? 0, planeZ).project(this.camera);
      (slot.value as THREE.Vector2).set(world.x * 0.5 + 0.5, 0.5 - world.y * 0.5);
    }

    this.dustMaterial ??= this.buildDustMaterial(t);

    const key = `${dust.count}:${dust.seed}`;
    if (key === this.dustKey && this.dustMesh) return;
    this.dustKey = key;

    const QUAD: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, -1],
      [1, 1],
      [-1, 1],
    ];
    const corners: number[] = [];
    const ids: number[] = [];
    for (let i = 0; i < dust.count; i++) {
      for (const [cx, cy] of QUAD) {
        corners.push(cx, cy);
        ids.push(i + dust.seed * 0.618);
      }
    }
    const geometry = new THREE.BufferGeometry();
    // Positions are unused — the vertex stage derives world position from the index — but three
    // needs the attribute present to know how many vertices to draw.
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array((corners.length / 2) * 3), 3),
    );
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

  private buildDustMaterial(t: PassTargets): THREE.NodeMaterial {
    const vertex = dustVertex({
      time: this.dustTime,
      size: this.dustSize,
      drift: this.dustDrift,
      planeZ: this.dustPlaneZ,
      camDist: this.dustCamDist,
      extent: this.dustExtent,
      res: this.resolution,
    });
    const material = new THREE.NodeMaterial();
    material.vertexNode = vertex.position as never;
    // Brightness from the sixteenth-res UNTHRESHOLDED field, hue from a mid bloom level. Two
    // different textures on purpose: the field is broad enough to say whether light reaches a
    // grain at all, and far too broad to say what colour it is.
    // NOT v-flipped, though both levels are blit-written and everything else that reads them is —
    // see `blitUv` in ./nodes/passes. A flip was added here by symmetry with those and it was
    // wrong: this pass is drawn with the SCENE, and the uv it is handed already runs in the same
    // direction as the stored rows, so flipping lit every grain from the mirror image of the frame.
    // Worth 1.4 of `prism` in a LIVE frame and invisible to every static comparison, which is how
    // it survived. Reported by a person looking at the studio.
    const shade = dustPass({
      light: (uvNode: Vec) => TSL.texture(t.bloom[3].a.texture, uvNode),
      color: (uvNode: Vec) => TSL.texture(t.bloom[1].a.texture, uvNode),
      response: this.dustResponse,
      falloffPower: this.dustFalloff,
      exposure: this.dustExposure,
      intensity: this.dustIntensity,
      srgbToLinear,
      linearToSrgb,
      tonemapAces: tonemapAcesNode,
    });
    const screen: Vec = TSL.vec2(TSL.screenUV.x, TSL.screenUV.y);
    const outside = outsideSection(screen, this.dustSectionA, this.dustSectionB, this.dustSectionC);
    material.fragmentNode = shade(
      vertex.corner,
      vertex.lightUv,
      vertex.softness,
      vertex.sparkle,
      vertex.opacity,
    ).mul(outside) as never;
    // Additive in COLOUR only. Plain additive blending accumulates alpha too, and the post pass
    // divides by that alpha — so the layer would darken what it is meant to brighten.
    material.transparent = true;
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
    material.depthTest = false;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    return material;
  }

  private buildEnvPasses(): NonNullable<NodeMaterialRenderer["envPasses"]> {
    const blurSource = TSL.texture(this.envTexture());
    const copySource = TSL.texture(this.envTexture());
    return {
      bake: passMaterial(envBakePass(this.studioMode, this.studioGain)),
      blur: passMaterial(
        envBlurPass(
          blurSource,
          this.envBlurTexel,
          this.envBlurDir,
          // The reference's radius, which is what sets how fast the chain widens per level.
          TSL.float(1.15),
          this.envBlurCompensate,
        ),
      ),
      copy: passMaterial(blitPass(copySource)),
      blurSource,
      copySource,
    };
  }

  /** Copy a scratch target into one mip of the environment texture. */
  private async copyIntoLevel(source: THREE.RenderTarget, level: number): Promise<void> {
    if (!this.envTarget || !this.envPasses) return;
    this.envPasses.copySource.value = source.texture;
    this.quad.blit(this.renderer, this.envPasses.copy, this.envTarget, level);
  }

  private buildBackdrop(): THREE.Mesh {
    const material = new THREE.NodeMaterial();
    material.fragmentNode = backdropPass({
      probe: devProbe(),
      mode: this.bgMode,
      gradType: this.bgGradType,
      top: this.top,
      bottom: this.bottom,
      stops: this.bgStops,
      stopCount: this.bgStopCount,
      maxStops: MAX_STOPS,
      angle: this.bgAngle,
      mesh: this.bgMesh,
      meshColors: this.bgMeshColors,
      meshCount: this.bgMeshCount,
      meshSoft: this.bgMeshSoft,
      maxMeshPoints: MAX_MESH_POINTS,
      frame: this.bgFrame,
      size: this.bgSize,
      hasImage: this.bgHasImage,
      image: (node: Vec) => this.backgroundImage().sample(node),
      imageFit: this.bgImageFit,
      imageZoom: this.bgImageZoom,
      imageAspect: this.bgImageAspect,
      imageOffset: this.bgImageOffset,
      wall: {
        extent: this.wallExtent,
        lightUv: this.wallLightUv,
        lightDir: this.wallLightDir,
        scale: this.wallScale,
        normal: this.wallNormal,
        microFreq: this.wallMicroFreq,
        microNormal: this.wallMicroNormal,
        gamma: this.wallGamma,
        contrast: this.wallContrast,
        pivot: this.wallPivot,
        floorLevel: this.wallFloor,
        highlight: this.wallHighlight,
        ambient: this.wallAmbient,
        ambientLight: this.wallAmbientLight,
        shadow: this.wallShadow,
        grounding: this.wallGrounding,
        ground: this.ground,
        groundPhase: this.groundPhase,
        groundCount: this.groundCount,
        probe: devProbe(),
      },
      lamps: platePass({
        lamps: this.lampArray,
        colors: this.lampColorArray,
        count: this.lampCount,
        gain: this.lampGain,
        lo: this.lampLo,
        hi: this.lampHi,
        maxLamps: MAX_LAMPS,
      }),
      plateScale: this.plateScale,
      plateOffset: this.plateOffset,
      show: this.bgShow,
    })(uv()) as never;
    // A REAL world-space plane, on the normal model-view-projection path, placed and scaled to
    // match the WebGL engine's backdrop exactly — see `resize`. It is deliberately not a
    // full-screen clip-space quad: everything authored against the plane (the ramp, the wall, the
    // lamp overlay) needs the plane's OWN uv, and that can only be reconstructed from a screen
    // quad by assuming the camera looks at the plane's centre, which it does not.
    material.depthWrite = false;
    material.depthTest = false;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    return mesh;
  }

  /**
   * The background image, as a swappable texture node.
   *
   * A node so the picture can change without recompiling the backdrop, and a 1x1 stand-in until
   * one is loaded — a null sampler is a validation error rather than a blank.
   */
  private backgroundImage(): Vec {
    this.placeholder ??= new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.needsUpdate = true;
    this.bgImageNode ??= TSL.texture(this.bgImageTexture ?? this.placeholder);
    return this.bgImageNode;
  }

  /**
   * Load (or drop) the backdrop image / video to match the config.
   *
   * A twin of the WebGL engine's `syncBackgroundMedia`, down to the URL key: a slider drag calls
   * the background apply on every frame, and re-requesting the same file each time would be a
   * request storm. A video takes precedence over a still when both are set.
   *
   * The texture is swapped INTO the existing node rather than rebuilt around it, so a picture
   * arriving does not recompile the backdrop.
   */
  private syncBackgroundMedia(): void {
    const c = this.config;
    const wanted =
      c.backgroundMode === "image" ? (c.backgroundVideoUrl ?? c.backgroundImageUrl) : undefined;
    if (wanted === this.bgMediaUrl) return;
    this.bgMediaUrl = wanted;
    this.disposeMedia();
    const node = this.backgroundImage() as unknown as { value: THREE.Texture };
    if (!wanted) {
      this.bgHasImage.value = 0;
      if (this.placeholder) node.value = this.placeholder;
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
      this.bgVideo = video;
      this.bgImageTexture = texture;
      video.addEventListener("loadedmetadata", () => {
        this.bgImageAspect.value = video.videoWidth / Math.max(1, video.videoHeight);
        void this.drawGuarded();
      });
      void video.play().catch(() => {
        // Autoplay can be refused; the first frame still shows once metadata lands.
      });
      node.value = texture;
      this.bgHasImage.value = 1;
      return;
    }

    new THREE.TextureLoader().load(wanted, (texture) => {
      // A late load must not overwrite a newer one.
      if (this.bgMediaUrl !== wanted) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      this.bgImageTexture = texture;
      node.value = texture;
      this.bgHasImage.value = 1;
      this.bgImageAspect.value = texture.image.width / Math.max(1, texture.image.height);
      void this.drawGuarded();
    });
  }

  private disposeMedia(): void {
    this.bgImageTexture?.dispose();
    this.bgImageTexture = undefined;
    if (this.bgVideo) {
      this.bgVideo.pause();
      this.bgVideo.removeAttribute("src");
      this.bgVideo.load();
      this.bgVideo = undefined;
    }
  }

  /**
   * Build a node material for one item.
   *
   * The material-kind branch is resolved in JAVASCRIPT rather than in the graph: the kind cannot
   * change without a rebuild anyway, and emitting only the branch a shape actually uses keeps each
   * compiled program to what it needs. The GLSL engine branches on a uniform instead because it
   * shares one program across every shape — a different trade, not a different intent.
   */
  private buildItemMaterial(item: ItemConfig): {
    material: THREE.NodeMaterial;
    uniforms: Record<string, ReturnType<typeof uniform>>;
    planes: THREE.Vector4[];
    /** The resolved material — every interaction applier reads its authored base from this. */
    base: ReturnType<typeof resolveMaterial>;
    /** The same uniforms under the GLSL engine's names; see `bindingUniforms`. */
    bound: Record<string, UniformCell>;
  } {
    const m = resolveMaterial({ path: defaultPath(item.shape), ...item.material });
    const kindIndex = MATERIAL_KINDS.indexOf(m.kind);
    const u = {
      albedo: uniform(vec3(...rgb(m.albedo))),
      edgeTint: uniform(vec3(...rgb(m.edgeTint || "#ffffff"))),
      useEdge: uniform(m.edgeTint ? 1 : 0),
      roughness: uniform(m.roughness),
      spec: uniform(m.specular),
      rim: uniform(m.rim),
      ior: uniform(Math.max(m.ior, 1)),
      path: uniform(m.path),
      density: uniform(m.density),
      lens: uniform(m.lens),
      bend: uniform(m.bend),
      dispersion: uniform(m.dispersion),
      emission: uniform(m.emission),
      saturation: uniform(m.saturation),
      iridescence: uniform(m.iridescence),
      filmNm: uniform(m.filmNm),
      sparkle: uniform(m.sparkle),
      sparkleScale: uniform(m.sparkleScale),
      ripple: uniform(m.ripple),
      rippleScale: uniform(m.rippleScale),
      // Snapped to whole cycles over the loop, exactly as motion rates are, so the water in a
      // recorded clip closes on itself along with everything else.
      flowRate: uniform(loopFrequency(m.flow, this.config.loopSeconds)),
      hueShift: uniform(m.hueShift),
      tint: uniform(vec3(...rgb(m.tint || "#ffffff"))),
      useTint: uniform(m.tint ? 1 : 0),
      absorb: uniform(
        m.absorption ? vec3(m.absorption.x, m.absorption.y, m.absorption.z) : vec3(0, 0, 0),
      ),
      useAbsorb: uniform(m.absorption ? 1 : 0),
      /** 1 when this item's interior is traced against real planes rather than offset in screen space. */
      prism: uniform(0),
      planeCount: uniform(0, "int"),
    };

    // The traced-interior plane set, filled by `applyPrismPlanes` once the item has a world pose.
    //
    // SIX slots, matching the GLSL uniform array exactly. That is enough for a square prism's four
    // sides and two caps, and not enough for a hexagon's eight — the hexagon gets its six side
    // planes and no caps, so a ray leaving through the top finds no exit and falls back to the
    // screen-space offset. Widening it here would be a divergence from the engine this one is
    // being diffed against, not a fix.
    const planes = Array.from({ length: PRISM_PLANES }, () => new THREE.Vector4(0, 0, 1, 0));
    const planeArray = TSL.uniformArray(planes);

    // The room, through the ONE lookup — sharp for a mirror, a wider cone as the surface roughens.
    // Reading the analytic room directly here is what made a metal's reflection alias into crawling
    // noise wherever a shape curved away and compressed the whole room into a few pixels.
    const room = this.room();
    // The real lamp field: a ray cast at the plate plane, sampled where it lands. This is what
    // gives a shape its colour — glass borrows chroma from whatever lamps sit behind it, and a
    // metal's form comes almost entirely from variation in what it reflects.
    const sampleField = platePass({
      lamps: this.lampArray,
      colors: this.lampColorArray,
      count: this.lampCount,
      gain: this.lampGain,
      lo: this.lampLo,
      hi: this.lampHi,
      maxLamps: MAX_LAMPS,
    });
    const cast = backplate(sampleField, this.plateZ, this.plateScale, this.plateOffset);
    const plate = (dir: Vec) => cast(TSL.positionWorld, dir);

    const material = new THREE.NodeMaterial();
    // The whole graph lives inside an `Fn`. TSL's `toVar`/`assign` need a stack to write into, and
    // outside one they warn per node and silently drop the assignment — which renders as a shape
    // that is mysteriously missing everything after its first mutable local.
    let probeLobe: Vec;
    material.fragmentNode = Fn(() => {
      // LIQUID perturbs the surface before anything reads it — Fresnel, refraction and the
      // reflection all have to see the same water. Branched in JavaScript rather than on a uniform
      // because a material's KIND cannot change without rebuilding this graph anyway, and the
      // ripple is four cosines every scene would otherwise pay for. No `> 0.001` gate: at zero
      // amplitude the expression returns the normal unchanged, so the gate would only buy speed on
      // a shape that already declared itself liquid.
      const normal: Vec =
        kindIndex === MATERIAL_KINDS.indexOf("liquid")
          ? rippleNormal(
              TSL.normalWorld,
              TSL.positionWorld,
              this.timeUniform.mul(u.flowRate),
              u.rippleScale,
              u.ripple,
            )
          : TSL.normalWorld;
      // `.toVar()` HERE IS LOAD-BEARING, not a readability choice.
      //
      // TSL emits a node's assignment wherever it is FIRST BUILT, and building is driven by walking
      // the returned graph — not by the order these statements appear. `view` is reached first
      // through the argument of the plane walk below, so without a var it lands INSIDE that `Loop`
      // body, and every later use in the shader reads whatever the last iteration left. On a shape
      // with no planes the loop never runs at all, so `view` stays zero: `ndv` collapses to zero,
      // every Fresnel term goes to grazing incidence, and the surface renders as a white shell.
      // Nothing about that is visible in this file — it only shows in the generated GLSL.
      const view = TSL.cameraPosition.sub(TSL.positionWorld).normalize().toVar();
      const ndv = normal.dot(view).clamp(0, 1).toVar();
      // ALPHA IS DEPTH on the plate pass, and coverage on the main one. The main pass validates its
      // refracted samples against this, so a plate that writes a flat 1 everywhere reports every
      // shape as sitting at the far plane and the guard passes on samples it should reject.
      const plateAlpha: Vec = select(
        this.passIndex.greaterThan(0.5),
        TSL.float(1),
        TSL.positionView.z.negate().div(FAR),
      );

      if (kindIndex > 3) {
        const shaded = shadeOpaque({
          kind: TSL.float(kindIndex),
          albedo: u.albedo,
          edgeTint: u.edgeTint,
          useEdge: u.useEdge,
          roughness: u.roughness,
          spec: u.spec,
          rim: u.rim,
          envOn: this.envOn,
          room,
          plate,
        })(normal, view, ndv);
        const grey: Vec = vec3(shaded.dot(vec3(1 / 3)));
        const desaturated = blend(grey, shaded, u.saturation);
        // The same contrast expansion the transmissive branch ends with. The two families have to
        // agree on it, or a scene reads as two renderers standing side by side.
        const shaped = desaturated.sub(0.5).mul(1.04).add(0.5);
        // The twin of GLASS_FRAG's opaque probe — same terms, same main-pass-only rule.
        const mirrorR = TSL.reflect(view.negate(), normal);
        const envR = plate(mirrorR);
        const behindN = plate(normal.negate());
        const opaqueProbe: Record<string, Vec> = {
          roomR: room(mirrorR, u.roughness),
          plateR: envR.rgb,
          plateCover: vec3(envR.a),
          fill: blend(vec3(0.92), behindN.rgb, behindN.a.mul(0.6)),
          gradR: studioGradient(mirrorR),
          opaqueGrey: vec3(0.5),
          grey: vec3(0.5),
        };
        const opaqueAsked = devProbe();
        const opaqueWanted = opaqueAsked ? opaqueProbe[opaqueAsked] : undefined;
        const opaqueOut = shaped.add(vec3(u.emission).mul(0.5));
        if (opaqueWanted !== undefined)
          return vec4(select(this.passIndex.greaterThan(0.5), opaqueWanted, opaqueOut), plateAlpha);
        return vec4(opaqueOut, plateAlpha);
      }
      // A REAL branch, not a `select`: a select is a ternary and evaluates both sides, which would
      // cost eleven plate lookups on every scene that asked for three. `transmission` is a scene
      // uniform, so the whole draw takes one side and the branch stays coherent — the same reason
      // GLASS_FRAG spells it as an `if`.
      const cone = TSL.vec4(0).toVar();
      TSL.If(this.coneMode.greaterThan(0.5), () => {
        cone.assign(
          coneTransmission({
            samples: 11,
            ior: u.ior,
            dispersion: u.dispersion,
            roughness: u.roughness,
            plate,
            // `gl_FragCoord`'s convention, not `screenCoordinate`'s: the cone's per-pixel rotation
            // is a hash of the FLOORED pixel, so counting rows from the top instead of the bottom
            // gives a different bearing at every pixel. It does not shift the frosting, it
            // reshuffles it — which is why it showed up as speckle over the frosted row of
            // `materials` and as nothing at all anywhere else.
          })(
            view,
            normal,
            TSL.vec2(TSL.screenCoordinate.x, this.resolution.y.sub(TSL.screenCoordinate.y)),
          ),
        );
      }).Else(() => {
        cone.assign(
          simpleTransmission({ ior: u.ior, dispersion: u.dispersion, plate })(view, normal),
        );
      });
      // The RAW field. `transmittedHue` is applied once, below — running it here as well
      // normalizes an already-normalized colour and drains the chroma the lamps provide.
      //
      // A shape can carry its own colour instead of borrowing the lamps behind it, and a tinted
      // one is fully covered by definition — otherwise the tint would fade wherever no lamp
      // reaches, which is the opposite of what authoring a colour means.
      const lit = blend(cone.rgb, u.tint, u.useTint).toVar();
      const amt = blend(cone.a, TSL.float(1), u.useTint).toVar();
      // Hue rotation moves ONLY the transmitted light, so everything derived from it — the
      // absorption hue, the emission glow — shifts together while reflections keep the true lamp
      // colours. A real branch: a resting shape should pay nothing for a knob it does not use.
      TSL.If(u.hueShift.abs().greaterThan(0.0005), () => {
        lit.assign(rotateHue(lit, u.hueShift));
      });

      // BASE: what is genuinely behind this fragment. On the main pass that is the plate pass's
      // own frame, displaced in screen space — which is what lets glass refract other glass. The
      // displacement is RIM-WEIGHTED: a near-flat window in the middle, hard bending at the edge.
      // Uniform displacement reads as frosted; edge-loaded displacement reads as cut.
      // NO VERTICAL FLIP ON THE UV. `screenUV` is top-down on both backends — three builds it from
      // a fragment coordinate it flips "to follow webgpu standards" — and that is already the
      // orientation a render target stores, so this samples the plate and the depth target
      // directly. The post pass DOES flip, and the two are not in conflict: it reads through a
      // full-screen quad's `uv()`, which runs bottom-up, so it needs the opposite correction.
      //
      // Flipping the UV here made every shape refract a vertically mirrored copy of the frame. On
      // a tall rod that is nearly invisible — the mirror of a vertical cylinder is a vertical
      // cylinder — which is why it survived: it only shows on a scene whose depth varies strongly
      // up the frame. On `staircase` it was worth 28 of the 42 levels of difference from WebGL.
      //
      // WHICH IS EXACTLY WHY THE OFFSET BELOW IS NEGATED IN Y, and that is not a second flip
      // undoing the first. The UV is top-down; a view-space normal and an `ndc * 0.5 + 0.5` hit
      // are both y-UP. Adding a y-up displacement to a top-down coordinate walks the sample the
      // wrong way up the frame. The GLSL engine never has to think about this because its `suv`
      // comes from `vProj * 0.5 + 0.5` and is y-up too, so both of its terms already agree.
      //
      // The symptom was not a mirrored image — it was CHEVRONS down every rod. A sample sent the
      // wrong way lands on nearer geometry, the depth guard below correctly rejects it, and the
      // fragment falls back to clear glass. So a coordinate-convention bug surfaced as bright
      // triangular banding, and looked for a long time like a tolerance being too tight.
      const screenUv: Vec = TSL.vec2(TSL.screenUV.x, TSL.screenUV.y);
      const viewNormal: Vec = TSL.normalView;
      const lensOffset = TSL.vec2(viewNormal.x.div(this.aspect), viewNormal.y.negate())
        .mul(u.lens)
        .mul(TSL.float(1).sub(ndv).pow(1.35))
        .mul(3.4);

      // TRACED refraction, for a solid whose faces really are planes.
      //
      // Refract the view into the glass, walk it to whichever face it actually leaves by, and
      // project THAT point. The screen-space offset above is a fair approximation for a rod, whose
      // surface curves smoothly and whose exit is roughly opposite its entry; on a faceted solid
      // it is not, because the refracted ray can leave through a different face entirely.
      //
      // The projected hit needs converting to `screenUv`'s convention first — see the note above.
      const inside = bendDir(view, normal, TSL.float(1).div(u.ior.max(1))).toVar();
      const hitT = prismExit(planeArray, u.planeCount)(TSL.positionWorld, inside).toVar();
      const hit = TSL.positionWorld.add(inside.mul(hitT));
      const clip = TSL.cameraProjectionMatrix.mul(TSL.cameraViewMatrix).mul(vec4(hit, 1));
      const hitUv = clip.xy.div(clip.w.max(1e-5)).mul(0.5).add(0.5);
      const traced: Vec = u.prism.greaterThan(0.5).and(hitT.greaterThan(0));
      // Into `screenUv`'s convention before the subtraction, for the reason above: `hitUv` is y-up
      // and the offset has to come out top-down. Subtracting the two straight would leave the
      // traced branch with the same wrong-way displacement the lens branch had.
      const hitUvTopDown = TSL.vec2(hitUv.x, TSL.float(1).sub(hitUv.y));

      // BENT: the same construction as the traced branch, but with the MEASURED thickness standing
      // in for an analytic exit — so it is available to any shape rather than to plane-bounded
      // solids. `lensOffset` is built from the view normal, which points at the camera in the
      // middle of any convex shape, so it is zero exactly where a ball bends hardest. See
      // `MaterialConfig.bend`.
      //
      // Top-down before the subtraction, for the same reason the traced branch converts: `bentUv`
      // is y-up and `screenUv` is not.
      const bentThick = decodeDepth(TSL.texture(this.depthTexture(), screenUv))
        .mul(FAR)
        .sub(TSL.positionView.z.negate())
        .max(0);
      const bentExit = TSL.positionWorld.add(inside.mul(bentThick));
      const bentClip = TSL.cameraProjectionMatrix.mul(TSL.cameraViewMatrix).mul(vec4(bentExit, 1));
      const bentUv = bentClip.xy.div(bentClip.w.max(1e-5)).mul(0.5).add(0.5);
      const bentTopDown = TSL.vec2(bentUv.x, TSL.float(1).sub(bentUv.y));
      const bentOffset = blend(lensOffset, bentTopDown.sub(screenUv), u.bend);

      const offset = select(traced, hitUvTopDown.sub(screenUv), bentOffset);

      const plateUv = screenUv.add(offset).clamp(0.002, 0.998);
      const smp: Vec = this.plateSampler().sample(plateUv);
      // DEPTH VALIDATION. The plate pass stored linear depth in alpha; reject any sample NEARER
      // than this fragment, or a shape picks up the silhouette of whatever stands in front of it
      // and the whole cluster gains a ghost outline. This is what buys the high blend weight.
      // 0.30 is safe against the 8-bit plate, which was worth checking: alpha holds linear depth,
      // one code is FAR/255 = 0.37 world units, and rounding can therefore be wrong by half of
      // that — 0.19, comfortably inside the tolerance. So a quantisation step cannot flip this.
      const behind = smp.a.mul(FAR).greaterThanEqual(TSL.positionView.z.negate().sub(0.3));
      const sampled: Vec = smp.rgb;
      const weight = this.passIndex.mul(0.94).mul(select(behind, TSL.float(1), TSL.float(0)));
      // A bending material reads the GLASS-FREE plate instead, and skips the depth guard with it:
      // that guard exists to stop a shape sampling what stands in front of it, and there is no
      // glass in this texture to stand anywhere. See the plain pass in `renderFrame`.
      const plain: Vec = this.plainSampler().sample(plateUv).rgb;
      // In the GLSL engine's order, which is not cosmetic: the bent plate goes in FIRST, over
      // clear glass, and the ordinary plate then blends on top with its weight scaled down by the
      // bend. Nesting the two the other way round leaves the un-bent branch contributing clear
      // glass at full strength through a term that should have been scaled away.
      // In the GLSL engine's order, and that is not cosmetic. There the bent plate goes in FIRST,
      // over clear glass, and the ordinary plate blends on top with its weight scaled down by the
      // bend. Nested the other way the un-bent branch is what the bent sample blends INTO, and the
      // engines part company at bend 1 — 12.3/255 whole-frame against 0.1 for this order.
      const base = blend(
        blend(this.clearGlass, sampled, weight.mul(TSL.float(1).sub(u.bend))),
        plain,
        this.passIndex.mul(0.94).mul(u.bend),
      );

      // Beer-Lambert, over a MEASURED path where the scene asks for one.
      //
      // 2R·(N·V) is exactly the chord through a cylinder, which is why the analytic fallback
      // survives: for a rod it is not an approximation at all. It is wrong for everything else — a
      // sphere gets one constant across its whole disc, a cone the same value at tip and base.
      //
      // The ndv^-0.6 is a deliberate cheat kept in BOTH branches. The true chord falls off so fast
      // at the silhouette that it leaves a wide white rim eating most of the shape's width; since
      // a cylinder's measured thickness is exactly 2·path·ndv, this reproduces the authored curve
      // for rods while being correct elsewhere.
      const backZ = decodeDepth(TSL.texture(this.depthTexture(), screenUv)).mul(FAR);
      const viewZ = TSL.positionView.z.negate();
      const measured = backZ.sub(viewZ).max(0).mul(ndv.max(0.02).pow(-0.6));
      const analytic = TSL.float(2).mul(u.path).mul(ndv.pow(0.4));
      // The trace already walked the real path, so where it hit there is nothing left to
      // approximate: `hitT` IS the distance through the glass for this fragment's refracted ray.
      const chord = select(traced, hitT, blend(analytic, measured, this.measuredThickness));
      const trans = TSL.float(1).sub(u.density.mul(chord).negate().exp()).mul(amt);
      const hue = transmittedHue(lit);
      const col = base.mul(blend(vec3(1), hue, trans)).toVar();
      // ABSORPTION overrides that where a material asks for one. The model above gives glass no
      // colour of its own — it borrows chroma from whatever lamps sit behind it — and an authored
      // absorption is the opposite: a per-channel Beer-Lambert over the path this fragment really
      // traversed, owing nothing to the lamp field.
      TSL.If(u.useAbsorb.greaterThan(0.5), () => {
        col.assign(base.mul(blend(vec3(1), u.absorb.mul(chord).negate().exp(), amt)));
      });
      col.addAssign(lit.mul(trans).mul(u.emission));

      // The reflection layer. Where the mirror ray misses the plate it lands on the ROOM rather
      // than a flat constant: a shape over a dark backdrop has nothing to reflect otherwise, and
      // comes out a silhouette with no faces.
      const f = TSL.float(0.04).add(TSL.float(0.96).mul(TSL.float(1).sub(ndv).pow(5)));
      const mirror = TSL.reflect(view.negate(), normal).toVar();
      const rf = plate(mirror);
      // The film tints what the surface REFLECTS — reflection, rim and specular — never what it
      // transmits: interference happens to the bounced wave, and colouring the transmission too
      // reads as dye rather than as a coating.
      const film = thinFilm(ndv, u.ior, u.filmNm, u.iridescence).toVar();
      // The ANALYTIC room here, not the cone — matching GLASS_FRAG, which reads `studio(R)` at this
      // one site. Glass takes a mirror reflection whatever its roughness, because the roughness of
      // a transmissive surface is already spent scattering the cone that goes THROUGH it.
      const rfCol = blend(studioRoom(mirror, this.studioMode, this.studioGain), rf.rgb, rf.a);
      // The reflection carries FAR more weight under a softbox. 0.16 is tuned for a bright plate
      // behind the glass, where the reflection garnishes an already-lit shape; in a dark room it is
      // the only thing describing the solid, and at 0.16 a prism stays a silhouette.
      const softbox = this.studioMode.greaterThan(0.5);
      const reflW = f.mul(
        select(softbox, u.iridescence.mul(0.38).add(0.62), u.iridescence.mul(0.9).add(0.16)),
      );
      const reflected = select(softbox, rfCol, blend(vec3(0.97), rf.rgb, rf.a));
      col.assign(blend(col, reflected.mul(film), reflW));

      // The RIM window. 0.62 means the last ~68 degrees before edge-on, which sounds generous and
      // is not: on a smooth convex surface N·V collapses fast, so even this only paints a band. At
      // the 0.90 it used to be, `rim` was measurably inert on eight of the eleven shape kinds.
      col.assign(
        blend(
          col,
          film,
          // `x.smoothstep(edge0, edge1)` — the VALUE is the receiver, not the edge. Written the
          // other way round it compiles and returns a plausible ramp of the wrong thing.
          TSL.float(1)
            .sub(ndv)
            .smoothstep(blend(TSL.float(0.62), TSL.float(0.42), u.iridescence), TSL.float(1))
            .mul(u.rim),
        ),
      );
      col.mulAssign(TSL.float(1).sub(TSL.float(1).sub(ndv).smoothstep(0.62, 0.86).mul(0.1)));

      // The specular lobe. 40 is tight enough to read as a hard studio highlight and wide enough to
      // FIND the key light — at the 140 it used to be, `specular` was dead on seven of eleven
      // kinds, because the term it multiplies was exactly zero.
      const lobe = mirror
        .dot(KEY)
        .max(0)
        .pow(40)
        .add(mirror.dot(KEY_FILL).max(0).pow(40).mul(0.55))
        .toVar();
      probeLobe = lobe;
      col.addAssign(lobe.mul(u.spec).mul(blend(vec3(1), film, u.iridescence)));

      // GLITTER, for the one kind that asks for it — a field of tiny mirrors, only the few facing
      // the key light firing at any moment. That flicker IS the effect.
      if (kindIndex === 2) {
        const footprint = TSL.fwidth(TSL.positionWorld.x).add(TSL.fwidth(TSL.positionWorld.y));
        col.addAssign(
          glitter(
            TSL.positionWorld,
            normal,
            view,
            KEY,
            footprint.max(1e-4),
            u.sparkleScale,
            u.sparkle,
          ),
        );
      }

      // Saturation and the contrast expansion, exactly as the opaque branch applies them — the two
      // families have to agree, or a scene reads as two different renderers side by side.
      col.assign(blend(vec3(col.dot(vec3(0.3333))), col, u.saturation));
      col.assign(col.sub(0.5).mul(1.04).add(0.5));
      // DEV PROBES, for the harnesses in `scripts/`. Two rules make them trustworthy, and both
      // were learnt by getting a dozen readings that described a frame which did not exist:
      //
      // They are substituted on the MAIN pass ONLY. The plate is drawn by this same material, so a
      // probe that returns unconditionally rewrites the plate the main pass then samples.
      //
      // And they carry `plateAlpha`, not 1. The plate stores linear depth there and the main pass
      // validates against it, so a probe returning 1 disables the very guard it is measuring.
      const probe: Record<string, Vec> = {
        // A flag colour, for answering `is this shape drawn into that target at all`.
        red: vec3(1, 0, 0),
        grey: vec3(0.5),
        // The plate's stored depth against this fragment's own, both scaled to the same range.
        plateDepth: vec3(smp.a.mul(FAR).div(4)),
        viewDepth: vec3(TSL.positionView.z.negate().div(4)),
        view: view.mul(0.5).add(0.5),
        ndv: vec3(ndv),
        normal: normal.mul(0.5).add(0.5),
        offset: vec3(offset.x.mul(5).add(0.5), offset.y.mul(5).add(0.5), 0.5),
        // See the GLSL twin: the sample position in one shared convention.
        plateUvTd: vec3(plateUv.x, plateUv.y, 0),
        // Divided, not multiplied — the GLSL twin scales it the same way so the two are comparable.
        chord: vec3(chord.div(3)),
        backZ: vec3(backZ.div(32)),
        viewZ: vec3(TSL.positionView.z.negate().div(32)),
        depthGuard: vec3(select(behind, TSL.float(1), TSL.float(0))),
        plateA: vec3(smp.a.mul(FAR).div(32)),
        guardMargin: vec3(smp.a.mul(FAR).sub(TSL.positionView.z.negate()).add(16).div(32)),
        alphaOut: vec3(plateAlpha.mul(5)),
        amt: vec3(amt),
        base,
        lit,
        trans: vec3(trans),
        lobe: vec3(probeLobe),
        mirrorV: mirror.mul(0.5).add(0.5),
        ndvP: vec3(ndv),
        viewV: view.mul(0.5).add(0.5),
        posW: TSL.positionWorld.mul(2).add(0.5),
        // CALIBRATION — see the GLSL twin. Both engines must return exactly this.
        calib: vec3(0.25, 0.5, 0.75),
        // See the GLSL twin: the lobe's argument, before the exponent.
        dotKey: vec3(mirror.dot(KEY).max(0)),
        // See the GLSL twin: a VARYING quantity that must be identical, so the difference it shows
        // is the instrument's floor. `calib` is constant and cannot expose interpolation, MSAA
        // resolve or target precision; this can. x only — y carries a flip between the two.
        rampX: vec3(TSL.screenCoordinate.x.div(1000)),
        // See the GLSL twins: V's two inputs, separately.
        camP: TSL.cameraPosition.div(4).add(0.5),
        viewLen: vec3(TSL.cameraPosition.sub(TSL.positionWorld).length().div(4)),
        // See the GLSL twin: the camera against the authored position, at 8x.
        camErr: TSL.cameraPosition
          .sub(vec3(0, 0, 1.25))
          .mul(8)
          .add(0.5),
        // See the GLSL twin: the measured thickness at a scale that can resolve it. backZ and viewZ
        // are each around 7 world units and their difference is under one, so a probe scaled for
        // the absolute depths quantises the interesting quantity away.
        thick: vec3(backZ.sub(viewZ).max(0).div(2)),
        // See the GLSL twin: the UV the back-depth fetch uses.
        duv: vec3(screenUv.x, screenUv.y, 0),
      };
      // `plate:<name>` substitutes on BOTH passes and pairs with the plate dump in `draw`, which is
      // how a plate-pass intermediate is inspected — the main pass would otherwise overwrite it.
      const asked = devProbe();
      const onPlate = asked?.startsWith("plate:") ?? false;
      const wanted = asked ? probe[onPlate ? asked.slice(6) : asked] : undefined;
      if (wanted !== undefined)
        return vec4(
          onPlate ? wanted : select(this.passIndex.greaterThan(0.5), wanted, col),
          plateAlpha,
        );
      return vec4(col, plateAlpha);
    })();
    return { material, uniforms: u, planes, base: m, bound: bindingUniforms(u) };
  }

  /**
   * Build the light sheet, if the scene has one.
   *
   * The tracer is CPU-side and renderer-agnostic, so the geometry is shared with the GLSL engine
   * verbatim — the optics were never the part that needed porting. What differs is only how the
   * per-vertex colour, profile and travel it emits reach the fragment stage.
   */
  private buildBeam(): void {
    if (this.beamMesh) {
      this.scene.remove(this.beamMesh);
      this.beamMesh.geometry.dispose();
      (this.beamMesh.material as THREE.Material).dispose();
      this.beamMesh = undefined;
    }
    if (this.causticMesh) {
      this.scene.remove(this.causticMesh);
      (this.causticMesh.material as THREE.Material).dispose();
      this.causticMesh = undefined;
    }
    const beam = this.config.beam;
    if (!beam) {
      this.beamTracedFrom = null;
      return;
    }
    // Recorded HERE rather than left for the first retrace to discover: starting from "unknown"
    // makes frame one look like a moved beam and rebuilds a mesh that was already correct, which
    // is not free and — because it lands after the targets and passes are built — does not come
    // back identical.
    // The SAME defaults `seedInteractionOut` applies. Recording the raw fields instead compares an
    // undefined `entry` against a seeded 0.5 and retraces the beam on every single frame.
    this.beamTracedFrom = { incidence: beam.incidence ?? 0, entry: beam.entry ?? 0.5 };

    const targets = (beam.targets ?? [])
      .map((name) => resolveItems(this.config).find((i) => i.name === name))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    const sections = targets
      .map((c) =>
        crossSectionFor(c.shape, beam.rotation, c.rotation.z, {
          x: c.position.x,
          y: c.position.y,
        }),
      )
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    const polygon = sections[0] ?? prismCrossSection(beam.radius, beam.sides, beam.rotation);
    const aim =
      beam.entryAngle === undefined
        ? aimBeam(polygon, beam.face, beam.incidence, beam.entry, beam.width, beam.distance)
        : aimBeamAtAngle(
            polygon,
            beam.entryAngle + (beam.entry - 0.5) * (beam.entrySweep ?? 90),
            beam.incidence,
            beam.width,
            beam.distance,
          );

    const { geometry } = buildLightSheet({
      polygon,
      extraSolids: sections
        .slice(1)
        .map((p, i) => ({ polygon: p, ior: targets[i + 1].material.ior ?? 1.5 })),
      origin: aim.origin,
      direction: aim.direction,
      halfWidth: beam.width,
      z: beam.z,
      ior: beam.ior,
      dispersion: beam.dispersion,
      samples: beam.samples,
      slices: beam.slices,
      wallHalfExtent: this.beamWallExtent(beam.z),
      exposure: beam.exposure,
      edgeFalloff: beam.edgeFalloff,
    });

    const material = new THREE.NodeMaterial();
    material.fragmentNode = beamPass({
      intensity: uniform(beam.intensity),
      edgeFalloff: uniform(beam.edgeFalloff),
      falloffRate: uniform(beam.falloffRate),
      falloffPower: uniform(beam.falloffPower),
      reveal: this.beamReveal,
    })(
      TSL.attribute("aColor", "vec3"),
      TSL.attribute("aProfile", "float"),
      TSL.attribute("aTravel", "float"),
    ) as never;
    material.transparent = true;
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
    // A ribbon has no meaningful front: its winding flips with the beam direction, so half of it
    // culls under FrontSide and the effect renders as nothing at all.
    material.side = THREE.DoubleSide;
    // Light, not a surface. It has no business occluding the glass, and writing depth would give
    // it a circle of confusion in the post pass and blur the one element that must stay a filament.
    material.depthTest = false;
    material.depthWrite = false;

    this.beamMesh = new THREE.Mesh(geometry, material);
    this.beamMesh.frustumCulled = false;
    // After everything else, which with depth testing off is what makes the beam composite OVER
    // the glass rather than under it.
    this.beamMesh.renderOrder = 10;
    this.scene.add(this.beamMesh);

    // The caustic: the SAME geometry again, lying on the wall — what the sheet deposits where it
    // lands, rather than the sheet itself. Just under the beam in render order.
    const caustic = new THREE.NodeMaterial();
    caustic.fragmentNode = causticPass({
      edgeFalloff: this.causticEdge,
      falloffRate: uniform(beam.falloffRate),
      falloffPower: uniform(beam.falloffPower),
      strength: this.causticStrength,
      coverage: this.causticCoverage,
      farDesat: uniform(0.04),
      farBright: uniform(0.02),
      travelScale: uniform(1),
      rateScale: uniform(0.12),
      powerScale: uniform(0.5),
      normalInfluence: this.causticNormalInfluence,
      normalElevation: this.causticNormalElevation,
      wallScale: this.wallScale,
      wallNormal: this.wallNormal,
      beamDir: this.causticBeamDir,
    })(
      TSL.attribute("aColor", "vec3"),
      TSL.attribute("aProfile", "float"),
      TSL.attribute("aTravel", "float"),
      TSL.attribute("aWavelength", "float"),
      TSL.positionGeometry.xy,
    ) as never;
    caustic.transparent = true;
    caustic.blending = THREE.CustomBlending;
    caustic.blendSrc = THREE.OneFactor;
    caustic.blendDst = THREE.OneFactor;
    caustic.blendSrcAlpha = THREE.ZeroFactor;
    caustic.blendDstAlpha = THREE.OneFactor;
    caustic.side = THREE.DoubleSide;
    caustic.depthTest = false;
    caustic.depthWrite = false;
    this.causticMesh = new THREE.Mesh(geometry, caustic);
    this.causticMesh.frustumCulled = false;
    this.causticMesh.renderOrder = 9;
    (this.causticBeamDir.value as THREE.Vector2).set(
      Math.cos(beam.rotation),
      Math.sin(beam.rotation),
    );
    this.scene.add(this.causticMesh);
  }

  /**
   * Half-extents of the wall the beam terminates on, walked from the frustum at the sheet's depth.
   *
   * Derived rather than authored, exactly as the reference derives it: the exposure that balances
   * the picture is a function of how far the light travels before it stops, so a scene that changes
   * its lens or its distance must not also have to remember to resize the wall.
   */
  /**
   * The wall's world extent — the twin of `MaterialRenderer.beamWallExtent`, and it has to stay
   * one derivation.
   *
   * Everything the wall shades from world position reads this: the relief at both scales, the
   * light falloff and the contact shadows. Two spellings of it put the two engines on differently
   * sized surfaces, which shows up as a faint diagonal weave over the whole backdrop rather than
   * as anything anyone would think to attribute to an extent.
   *
   * The distance walks from the ORBIT distance and the look-at, not from the camera's z, so a
   * scene that has been orbited still measures the wall it is actually looking at. `safety` is the
   * reference's WALL_SAFETY: the wall has to overshoot the frustum or it ends in a hard edge
   * partway across the picture.
   */
  private beamWallExtent(z: number): THREE.Vector2 {
    const cam = this.config.camera;
    const dist = Math.abs(this.distance || cam.distance) + Math.abs(cam.lookAt.z - z);
    const halfHeight = dist * Math.tan((this.camera.fov * Math.PI) / 360);
    const safety = 1.08;
    return new THREE.Vector2(
      halfHeight * Math.max(this.camera.aspect, 1) * safety,
      halfHeight * safety,
    );
  }

  /** Re-derive the wall extent. Must run after anything that changes the camera's aspect. */
  private refreshWallExtent(): void {
    if (this.config.backgroundMode !== "wall") return;
    (this.wallExtent.value as THREE.Vector2).copy(this.beamWallExtent(this.config.beam?.z ?? 0));
  }

  /** Rebuild the item meshes from the config. */
  private buildItems(): void {
    for (const entry of this.items) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
    }
    // `resolveItems` rather than `config.items`: a scatter scene describes its shapes generatively
    // and has an empty item list, so reading the list directly renders an empty frame.
    // Kept because the interaction controller's item indices are positions in THIS list, not in
    // `config.items` — which a scatter scene leaves empty.
    this.resolvedItems = resolveItems(this.config);
    this.items = this.resolvedItems.map((item) => {
      const { material, uniforms, planes, base, bound } = this.buildItemMaterial(item);
      const mesh = new THREE.Mesh(buildShape(item.shape), material);
      mesh.position.set(item.position.x, item.position.y, item.position.z);
      mesh.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
      mesh.scale.set(item.scale.x, item.scale.y, item.scale.z);
      this.scene.add(mesh);
      // AFTER the pose, not before: the planes are world-space and are read off the mesh's world
      // matrix, so computing them first traces a solid sitting at the origin while the mesh you
      // can see is somewhere else — which draws as refraction that lags the shape.
      const entry = {
        mesh,
        uniforms,
        planes,
        base,
        bound,
        config: item,
        motion: item.motion,
        phase: item.phase ?? 0,
        home: mesh.position.clone(),
        homeRotation: mesh.rotation.clone(),
        homeScale: mesh.scale.clone(),
      };
      this.applyPrismPlanes(entry);
      return entry;
    });
  }

  /**
   * Fill an item's world-space bounding planes, for the solids whose interior can be traced.
   *
   * Only a shape whose faces ARE planes qualifies, which is what limits this to prisms — the walk
   * finds the exit by intersecting a ray with each face, and that is meaningless for a lathe.
   *
   * The local frame has to match three's lathe exactly: it places a vertex at
   * `(r·sin(phi), y, r·cos(phi))`, so a face's outward normal is `(sin, 0, cos)` at the midpoint
   * angle between two vertices, at the apothem `r·cos(pi/sides)`. Note this is NOT the convention
   * `prismCrossSection` uses for the beam, which is `(cos, sin)`; they describe the same polygon
   * from different starting angles and agree only because the beam's is rotated to match.
   */
  private applyPrismPlanes(entry: {
    mesh: THREE.Mesh;
    uniforms: Record<string, ReturnType<typeof uniform>>;
    planes: THREE.Vector4[];
    config?: ItemConfig;
  }): void {
    const u = entry.uniforms;
    const shape = entry.config?.shape;
    // The EFFECTIVE side count, not the field: `hex` is six-sided by definition and its builder
    // ignores `shape.sides` entirely, so reading the field traces a solid the mesh is not — a
    // triangle refracting inside a hexagon.
    const sides = shape?.kind === "hex" ? 6 : (shape?.sides ?? 0);
    const eligible =
      this.config.tracedRefraction &&
      shape !== undefined &&
      (shape.kind === "prism" || shape.kind === "hex") &&
      sides >= 3 &&
      sides <= 8;
    if (!eligible) {
      u.prism.value = 0;
      u.planeCount.value = 0;
      return;
    }

    entry.mesh.updateMatrixWorld(true);
    const normalMatrix = this.normalScratch.getNormalMatrix(entry.mesh.matrixWorld);
    const apothem = shape.r * Math.cos(Math.PI / sides);
    const half = shape.len / 2;
    const normal = new THREE.Vector3();
    const point = new THREE.Vector3();
    let count = 0;

    for (let i = 0; i < sides && count < PRISM_PLANES; i++) {
      const a = (Math.PI * 2 * (i + 0.5)) / sides;
      normal.set(Math.sin(a), 0, Math.cos(a));
      point.copy(normal).multiplyScalar(apothem);
      writePlane(entry.planes[count++], normal, point, normalMatrix, entry.mesh.matrixWorld);
    }
    for (const dir of [1, -1]) {
      if (count >= PRISM_PLANES) break;
      normal.set(0, dir, 0);
      point.set(0, dir * half, 0);
      writePlane(entry.planes[count++], normal, point, normalMatrix, entry.mesh.matrixWorld);
    }
    u.prism.value = 1;
    u.planeCount.value = count;
  }

  /**
   * The plate texture the main pass refracts.
   *
   * A method rather than a captured reference because the target is reallocated on resize, and a
   * graph holding the old texture would sample storage that no longer exists.
   */
  private buildDepthMaterial(): THREE.NodeMaterial {
    const material = new THREE.NodeMaterial();
    // `positionView.z` is negative in front of the camera; the encoding wants a distance.
    material.fragmentNode = depthPass(TSL.positionView.z.negate(), FAR) as never;
    material.side = THREE.BackSide;
    return material;
  }

  private buildFrontDepthMaterial(): THREE.NodeMaterial {
    const material = new THREE.NodeMaterial();
    material.fragmentNode = depthPass(TSL.positionView.z.negate(), FAR) as never;
    return material;
  }

  /** Back-face linear depth, for the measured optical path. Same placeholder rule as the plate. */
  private depthTexture(): THREE.Texture {
    this.placeholder ??= new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.needsUpdate = true;
    return this.targets?.back.texture ?? this.placeholder;
  }

  /**
   * The plate, as ONE texture node every item material samples — and whose value is swapped
   * between passes.
   *
   * It has to be swapped because the plate pass renders INTO the plate while these materials are
   * bound to it, which is a feedback loop: the driver refuses the draw and the shapes are silently
   * missing from the plate the main pass then refracts. GLSL sidesteps it by guarding the fetch
   * behind `uPass`, but a node graph binds the texture whether the branch reads it or not, so the
   * binding itself is what has to go away.
   *
   * A node rather than a texture for the same reason the environment blur takes one: the value can
   * change without recompiling a single material.
   */
  private plateSampler(): Vec {
    this.placeholder ??= new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.placeholder.needsUpdate = true;
    this.plateSource ??= TSL.texture(this.placeholder);
    return this.plateSource;
  }

  /** Whether any material asks for a real path, so the extra draw costs nothing to a scene that
   *  does not use one. */
  private wantsPlainPlate(): boolean {
    return this.resolvedItems.some((item) => (item.material.bend ?? 0) > 0);
  }

  /** The glass-free plate, as one swappable texture node — same construction and same reason as
   *  {@link plateSampler}. */
  private plainSampler(): Vec {
    // ITS OWN placeholder, and that is the whole point rather than tidiness.
    //
    // Node uniforms are uniquified by the texture they reference, so two `TSL.texture()` calls made
    // against the SAME stand-in collapse into one sampler in the generated shader — one
    // `uniform sampler2D`, read at two different uvs, with `bindPlate` and `bindPlain` then
    // overwriting each other's value. Whichever bound last won, so the plate and the glass-free
    // plate silently swapped depending on which one the graph happened to reference first.
    //
    // It surfaced as an algebraically impossible result: reordering two `mix` calls that provably
    // reduce to the same expression at bend 0 moved the frame and turned 4% of pixels black.
    // Reading the emitted GLSL is what found it — one `nodeUniform26` where there should have been
    // two.
    this.plainPlaceholder ??= new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.plainPlaceholder.needsUpdate = true;
    this.plainSource ??= TSL.texture(this.plainPlaceholder);
    return this.plainSource;
  }

  /**
   * Point the bend fetch at the glass-free plate, or at a 1x1 stand-in.
   *
   * Gated on {@link wantsPlainPlate} and not just on the pass, because a scene where nothing bends
   * never RENDERS that target, and binding one that has been allocated and never drawn hands the
   * sampler undefined contents. Measured as making no difference to any shipped preset — every
   * such fragment multiplies the sample by a zero bend — so this is defensive rather than a fix
   * for anything observed. It is cheap, and undefined contents are not something to rely on
   * staying benign across drivers.
   */
  private bindPlain(live: boolean): void {
    if (!this.plainSource) return;
    const ready = live && this.targets && this.wantsPlainPlate();
    this.plainSource.value = ready ? this.targets!.plain.texture : this.plainPlaceholder;
  }

  /** Point every item's plate fetch at the real plate, or at a 1x1 stand-in during the plate pass. */
  private bindPlate(live: boolean): void {
    if (!this.plateSource) return;
    this.plateSource.value = live && this.targets ? this.targets.plate.texture : this.placeholder;
  }

  /**
   * Feed the backdrop's uniforms — everything beyond the derived ramp.
   *
   * All of it every frame rather than only the active branch: the mode is a uniform, so a scene
   * that switches from a gradient to a wall has to find the wall's numbers already there.
   */
  private applyBackground(): void {
    const c = this.config;
    this.bgMode.value = Math.max(0, BACKGROUND_MODES.indexOf(c.backgroundMode));
    this.bgShow.value = c.backdropLamps;
    this.refreshWallExtent();

    const stopCount = Math.min(c.backgroundPalette.length, MAX_STOPS);
    for (let i = 0; i < stopCount; i++) {
      const stop = c.backgroundPalette[i];
      const [sr, sg, sb] = parseHex(stop.color);
      this.bgStopData[i].set(sr, sg, sb, stop.position);
    }
    this.bgStopCount.value = stopCount;

    const types = ["linear", "radial", "conic", "mesh"];
    this.bgGradType.value = Math.max(0, types.indexOf(c.backgroundGradientType));
    this.bgAngle.value = c.backgroundGradientAngle;

    const meshCount = Math.min(c.backgroundMeshPoints.length, MAX_MESH_POINTS);
    for (let i = 0; i < meshCount; i++) {
      const point = c.backgroundMeshPoints[i];
      this.bgMeshData[i].set(point.x, point.y, 0, 0);
      const [mr, mg, mb] = parseHex(point.color);
      this.bgMeshColorData[i].set(mr, mg, mb);
    }
    this.bgMeshCount.value = meshCount;
    this.bgMeshSoft.value = c.backgroundMeshSoftness;

    this.bgImageFit.value =
      c.backgroundImageFit === "contain" ? 1 : c.backgroundImageFit === "stretch" ? 2 : 0;
    this.bgImageZoom.value = c.backgroundImageZoom;
    (this.bgImageOffset.value as THREE.Vector2).set(
      c.backgroundImagePosition.x,
      c.backgroundImagePosition.y,
    );
    this.syncBackgroundMedia();

    this.applyGrounding();
  }

  /**
   * Hand the wall the footprint of every shape standing on it.
   *
   * Position and apothem, not the circumradius: the shadow's edge follows the FACES, and using the
   * corner distance inflates a triangle's footprint by a factor of two.
   */
  private applyGrounding(): void {
    let count = 0;
    for (const item of this.items) {
      if (count >= GROUND_SLOTS) break;
      const shape = item.config?.shape;
      if (!shape) continue;
      const faceted = shape.kind === "prism" || shape.kind === "hex";
      const sides = shape.kind === "hex" ? 6 : faceted ? Math.max(3, shape.sides) : 0;
      const apothem = faceted ? shape.r * Math.cos(Math.PI / sides) : shape.r;
      this.groundData[count].set(item.mesh.position.x, item.mesh.position.y, apothem, sides);
      this.groundPhaseData[count] = Math.PI / 2 + item.mesh.rotation.z;
      count++;
    }
    this.groundCount.value = count;
  }

  /** Whether any finish-pass effect is on. When none is, the post pass draws straight out. */
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

  private buildFinishMaterial(source: THREE.Texture): THREE.NodeMaterial {
    this.finishSource ??= TSL.texture(source);
    return passMaterial(
      finishPass({
        source: this.finishSource,
        res: this.outputResolution,
        inner: this.fnInner,
        innerDensity: this.fnInnerDensity,
        innerDecay: this.fnInnerDecay,
        innerCentre: this.fnInnerCentre,
        dither: this.fnDither,
        ditherScale: this.fnDitherScale,
        ditherSteps: this.fnDitherSteps,
        halftone: this.fnHalftone,
        halftoneCell: this.fnHalftoneCell,
        halftoneAngle: this.fnHalftoneAngle,
        cmyk: this.fnCmyk,
        cmykCell: this.fnCmykCell,
        paper: this.fnPaper,
        paperScale: this.fnPaperScale,
      }),
    );
  }

  private applyConfig(): void {
    const c = this.config;
    const [r, g, b] = parseHex(c.background);
    (this.top.value as THREE.Vector3).set(r * 0.958, g * 0.958, b * 0.96);
    (this.bottom.value as THREE.Vector3).set(
      Math.min(1, r * 1.005),
      Math.min(1, g * 1.002),
      Math.min(1, b * 0.995),
    );
    this.toneMode.value = c.post.toneMap === "aces" ? 2 : c.post.toneMap === "neutral" ? 1 : 0;
    const p = c.post;
    this.bloomThreshold.value = p.bloomThreshold;
    this.bloomRadius.value = p.bloomSpread;
    this.bloomAmount.value = p.bloom;
    // The pyramid or the gather, never both — they are two answers to the same question, and
    // summing them doubles the halo.
    this.bloomMode.value = p.bloomMode === "pyramid" ? 1 : 0;
    this.focus.value = p.focus;
    this.range.value = Math.max(p.range, 1e-3);
    this.aperture.value = p.aperture;
    this.caustics.value = p.caustics;
    this.haze.value = p.haze;
    this.hazeTop.value = p.hazeTop;
    this.vignette.value = p.vignette;
    // The scene's own mirror composes with the target flip: mirroring vertically means NOT
    // flipping, because the source is already inverted.
    (this.sourceFlip.value as THREE.Vector2).set(c.mirrorH ? 1 : 0, c.mirrorV ? 0 : 1);
    (this.sceneMirror.value as THREE.Vector2).set(c.mirrorH ? 1 : 0, c.mirrorV ? 1 : 0);
    this.grain.value = p.grain;
    // `post.hazeColor`, NOT `background`. They are near-neighbours in most presets, so reading the
    // wrong one shows up as a faint gradient over the haze band rather than as a wrong colour.
    const [hr, hg, hb] = parseHex(p.hazeColor);
    (this.hazeColor.value as THREE.Vector3).set(hr, hg, hb);

    const lamps = c.lamps.slice(0, MAX_LAMPS);
    lamps.forEach((lamp, i) => {
      this.lampData[i].set(lamp.x, lamp.y, Math.max(lamp.r, 1e-4), lamp.intensity);
      const [lr, lg, lb] = parseHex(lamp.color);
      this.lampColors[i].set(lr, lg, lb);
    });
    this.lampCount.value = lamps.length;
    this.lampGain.value = c.lampGain;
    this.lampLo.value = c.lampGate.lo;
    this.lampHi.value = c.lampGate.hi;
    this.plateZ.value = c.plate.z;
    // The backdrop plane hangs off `plate.z` too, and a plate move does not force a resize.
    if (this.backdrop) this.backdrop.position.z = c.plate.z - 14;
    (this.plateScale.value as THREE.Vector2).set(c.plate.scale.x, c.plate.scale.y);
    (this.plateOffset.value as THREE.Vector2).set(c.plate.offset.x, c.plate.offset.y);
    (this.clearGlass.value as THREE.Vector3).set(...rgb(c.clearGlass));
    this.measuredThickness.value = c.measuredThickness ? 1 : 0;
    // The room's own uniforms, read by BOTH the analytic fallback and the bake — the two have to
    // describe the same room, or a scene shading one material through each disagrees about what is
    // reflected in it.
    const fp = c.post;
    this.fnInner.value = fp.innerLight;
    this.fnInnerDensity.value = fp.innerLightDensity;
    this.fnInnerDecay.value = fp.innerLightDecay;
    (this.fnInnerCentre.value as THREE.Vector2).set(fp.innerLightX, fp.innerLightY);
    this.fnDither.value = fp.dither;
    this.fnDitherScale.value = fp.ditherScale;
    this.fnDitherSteps.value = fp.ditherSteps;
    this.fnHalftone.value = fp.halftone;
    this.fnHalftoneCell.value = fp.halftoneCell;
    this.fnHalftoneAngle.value = fp.halftoneAngle;
    this.fnCmyk.value = fp.halftoneCmyk;
    this.fnCmykCell.value = fp.halftoneCmykCell;
    this.fnPaper.value = fp.paperTexture;
    this.fnPaperScale.value = fp.paperTextureScale;
    // The interaction controller, when the scene has bindings for it. Renderer-agnostic — it reads
    // the container and the config — so both engines drive the same one rather than two that agree
    // until they do not.
    if (interactionActive(c) && !this.interaction) {
      this.interaction = new InteractionController(
        this.container,
        () => this.config,
        () => resolveItems(this.config),
      );
      this.interaction.scrollOverride = this.scrollPreview;
    } else if (!interactionActive(c) && this.interaction) {
      this.interaction.dispose();
      this.interaction = undefined;
    }
    this.applyBackground();
    this.coneMode.value = c.transmission === "cone" ? 1 : 0;
    this.studioMode.value = c.studio === "softbox" ? 1 : 0;
    this.studioGain.value = c.studioGain;
  }

  /**
   * Build the pass chain, once the targets exist.
   *
   * Every graph here closes over a target's texture, so this cannot run before allocation and has
   * to run again after a resize replaces one. Node graphs are compiled per material, so rebuilding
   * is not free — but it happens on resize, not per frame.
   */
  /**
   * Gather counts for the post pass, from `quality` — the twin of the WebGL engine's
   * `postDefines`.
   *
   * Unrolled in JavaScript rather than looped in the graph, so these are build-time numbers and a
   * change has to rebuild the pass. `quality` is part of the structural test in `setConfig`, which
   * is what makes that safe. They used to be hard-coded at 12 and 6 against the reference's 24 and
   * 10, so every gather in the pass sampled a different set of points: worth about 1.0 of
   * `skewer`'s difference through the caustic pool and another 0.9 through depth of field.
   */
  private postTaps(): { dofTaps: number; causticTaps: number } {
    const q = this.config.quality;
    return {
      dofTaps: q >= 0.85 ? 24 : q >= 0.6 ? 16 : 10,
      causticTaps: q >= 0.6 ? 10 : 6,
    };
  }

  private buildPasses(t: PassTargets): void {
    this.passes = {
      extract: passMaterial(bloomExtractPass(t.color.texture, this.bloomThreshold, texel(t.color))),
      down: BLOOM_DIVISORS.slice(1).map((_, i) =>
        passMaterial(bloomDownPass(t.bloom[i].a.texture, texel(t.bloom[i].a), this.blitFlip)),
      ),
      blur: BLOOM_DIVISORS.map((_, i) => {
        const taps = BLOOM_TAPS[i];
        const sigma = TSL.float(taps / 3);
        return {
          h: passMaterial(
            bloomBlurPass(
              t.bloom[i].a.texture,
              taps,
              sigma,
              TSL.vec2(1, 0),
              texel(t.bloom[i].a),
              this.blitFlip,
            ),
          ),
          v: passMaterial(
            bloomBlurPass(
              t.bloom[i].b.texture,
              taps,
              sigma,
              TSL.vec2(0, 1),
              texel(t.bloom[i].a),
              this.blitFlip,
            ),
          ),
        };
      }),
      particle: {
        down: passMaterial(
          particleDownPass(
            t.color.texture,
            texel(t.color),
            TSL.vec2(t.color.width / t.bloom[3].a.width, t.color.height / t.bloom[3].a.height),
          ),
        ),
        blurH: passMaterial(
          bloomBlurPass(
            t.bloom[3].a.texture,
            BLOOM_TAPS.at(-1)!,
            TSL.float(BLOOM_TAPS.at(-1)! / 3),
            TSL.vec2(1, 0),
            texel(t.bloom[3].a),
            this.blitFlip,
          ),
        ),
        blurV: passMaterial(
          bloomBlurPass(
            t.bloom[3].b.texture,
            BLOOM_TAPS.at(-1)!,
            TSL.float(BLOOM_TAPS.at(-1)! / 3),
            TSL.vec2(0, 1),
            texel(t.bloom[3].a),
            this.blitFlip,
          ),
        ),
      },
      composite: passMaterial(
        bloomCompositePass(
          t.bloom[0].a.texture,
          t.bloom[1].a.texture,
          t.bloom[2].a.texture,
          this.bloomRadius,
          this.blitFlip,
        ),
      ),
      post: passMaterial(
        postPass({
          color: t.color.texture,
          depth: t.front.texture,
          bloom: t.bloom[0].b.texture,
          res: this.resolution,
          mirror: this.sourceFlip,
          focus: this.focus,
          range: this.range,
          aperture: this.aperture,
          scale: this.postScale,
          far: FAR,
          ...this.postTaps(),
          bloomAmount: this.bloomAmount,
          bloomMode: this.bloomMode,
          bloomRadius: this.bloomRadius,
          bloomThresh: this.bloomThreshold,
          sourceInverted: this.blitFlip,
          sceneMirror: this.sceneMirror,
          caustics: this.caustics,
          haze: this.haze,
          hazeTop: this.hazeTop,
          hazeColor: this.hazeColor,
          vignette: this.vignette,
          grain: this.grain,
          time: this.timeUniform,
          transparent: TSL.float(0),
          toneMap: this.toneMode,
        }),
      ),
    };
  }

  /**
   * Threshold, then blur a half-resolution pyramid separably, then recombine.
   *
   * Wider kernels are nearly free on the smaller levels, which is what buys the broad wash: a real
   * halo spans several octaves at once, and a single-radius gather has to pick one of them and lose
   * the rest. The composite resolves at HALF resolution rather than at the bottom of the pyramid —
   * compositing at a sixteenth and letting post upscale it puts a staircase along every thin
   * diagonal highlight.
   */
  private async renderBloom(t: PassTargets): Promise<void> {
    if (!this.passes) return;
    this.quad.blit(this.renderer, this.passes.extract, t.bloom[0].a);
    for (let i = 0; i < BLOOM_DIVISORS.length; i++) {
      if (i > 0) this.quad.blit(this.renderer, this.passes.down[i - 1], t.bloom[i].a);
      this.quad.blit(this.renderer, this.passes.blur[i].h, t.bloom[i].b);
      this.quad.blit(this.renderer, this.passes.blur[i].v, t.bloom[i].a);
    }
    this.quad.blit(this.renderer, this.passes.composite, t.bloom[0].b);
    if (this.config.dust && this.config.dust.count > 0) await this.renderParticleField(t);
  }

  /**
   * The dust light field: the last pyramid level, rebuilt UNTHRESHOLDED and blurred wide.
   *
   * It overwrites what the pyramid put there, and that is the point. The composite only reads the
   * top three levels, so the last one is free to answer a different question: not "what glows"
   * but "does any light reach this point at all". A thresholded level cannot answer it — a grain
   * sitting in dim light would be told there is none.
   */
  private async renderParticleField(t: PassTargets): Promise<void> {
    if (!this.passes?.particle) return;
    const light = t.bloom[3];
    this.quad.blit(this.renderer, this.passes.particle.down, light.a);
    this.quad.blit(this.renderer, this.passes.particle.blurH, light.b);
    this.quad.blit(this.renderer, this.passes.particle.blurV, light.a);
  }

  /**
   * Draw the inner interface of every traced solid into the plate.
   *
   * BETWEEN the plate and the main pass, because the plate is what the main pass refracts — this is
   * where a back interface has to land for the front face to be able to show it.
   *
   * One material for every item, its plane set rewritten per draw. The alternative is a material
   * per item, and since the graph is identical apart from uniform values that buys a compile each.
   *
   * The mesh moves into its own scene for the draw rather than having its material swapped in
   * place: rendering an object that still belongs to another scene picks up that scene's state.
   */
  private async renderBackGlass(t: PassTargets): Promise<void> {
    if (!this.config.tracedRefraction || this.config.backGlassStrength <= 0) return;
    const traced = this.items.filter((item) => (item.uniforms.prism.value as number) > 0.5);
    if (!traced.length) return;

    this.backGlass ??= this.buildBackGlass();
    const bg = this.backGlass;
    bg.strength.value = this.config.backGlassStrength;

    // AUTO-CLEAR OFF for the duration. Every `renderAsync` clears its target first, so a pass that
    // is supposed to ADD to the plate erases it instead and leaves only its own contribution —
    // additively blended over nothing. The symptom is a frame that gets darker when a light-adding
    // pass is switched on, which reads as the pass being wrong rather than as the clear.
    const previousAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(t.plate);
    for (const item of traced) {
      bg.count.value = item.uniforms.planeCount.value;
      for (const [i, plane] of item.planes.entries()) bg.planes[i].copy(plane);
      bg.ior.value = item.uniforms.ior.value;
      // Re-emit the depth the plate pass stored, so the main pass's validation still passes.
      bg.depth.value = Math.abs(item.mesh.position.z - this.camera.position.z) / FAR;

      const home = item.mesh.parent;
      const previous = item.mesh.material;
      item.mesh.material = bg.material;
      this.backGlassScene.add(item.mesh);
      this.renderer.render(this.backGlassScene, this.camera);
      this.backGlassScene.remove(item.mesh);
      item.mesh.material = previous;
      home?.add(item.mesh);
    }
    this.renderer.autoClear = previousAutoClear;
  }

  private buildBackGlass(): NonNullable<NodeMaterialRenderer["backGlass"]> {
    const planes = Array.from({ length: PRISM_PLANES }, () => new THREE.Vector4(0, 0, 1, 0));
    const planeArray = TSL.uniformArray(planes);
    const count = uniform(0, "int");
    const ior = uniform(1.5);
    const strength = uniform(1);
    const depth = uniform(1);

    const material = new THREE.NodeMaterial();
    material.fragmentNode = backGlassPass({
      planes: planeArray,
      planeCount: count,
      ior,
      strength,
      plateDepth: depth,
      // Mirror-smooth: the interior reflects the room sharply, and a cone here would blur away the
      // very structure that tells a viewer they are looking through a solid rather than a shell.
      room: (dir: Vec) => this.room()(dir, TSL.float(0)),
      bounces: BACK_GLASS_BOUNCES,
    })(
      TSL.positionWorld,
      // THE OBJECT'S OWN NORMAL, not `normalWorld`.
      //
      // This pass draws BACK faces, and three flips `normalWorld` to face the viewer on a
      // back-facing draw. BACKGLASS_VERT does no such thing — it carries `mat3(modelMatrix) *
      // normal` straight through — and this shader wants exactly that: the outward normal of the
      // face the ray is LEAVING through, which points away from the camera by definition here.
      //
      // Taking three's flipped one put the reflected ray on the wrong side of every back face, and
      // showed up as a bright ring on the bevel — the one place where which plane the ray exits by
      // is genuinely in question. Worth 2.40 to 0.18 on `prism` with post off.
      TSL.normalLocal.transformDirection(TSL.modelWorldMatrix).normalize(),
      TSL.cameraPosition,
    ) as never;
    // Additive on COLOUR, alpha untouched — the plate's alpha is depth, not coverage.
    material.transparent = true;
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
    material.side = THREE.BackSide;
    // The plate already holds the solid's FRONT faces, so a depth-tested back face is behind them
    // and rejected everywhere but a few silhouette pixels.
    material.depthTest = false;
    material.depthWrite = false;
    return { material, planes, count, ior, strength, depth };
  }

  /** What the GLSL engine draws and this one does not yet. Named so a gap is visible, not silent. */
  private renderPending(): void {
    // Items, the plate and depth passes, the beam, dust and the post chain are still to port.
  }

  // ------------------------------------------------------------- imperative API ---
  //
  // Everything below is renderer-agnostic — raycasting, projection, mesh bookkeeping — which is
  // why it can be a faithful twin of the WebGL engine's rather than a reinterpretation. It exists
  // so `core-loader-webgpu`'s type assertion stops hiding anything: a consumer reaching for `pick`
  // through `onReady` used to get a runtime error on this engine.

  /** Pixel size to render at, overriding the container. Used by the headless renderer. */
  setOutputSize(size?: { width: number; height: number }): void {
    this.outputSize = size;
    this.resize();
  }

  getItems(): readonly MaterialItem[] {
    return this.items as unknown as readonly MaterialItem[];
  }

  viewDirection(out = new THREE.Vector3()): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }

  /** Pointer position in normalized device coordinates, or null if the canvas has no area yet. */
  private toNdc(clientX: number, clientY: number): THREE.Vector2 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return this.pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  // ----------------------------------------------------------- interaction ---

  /** The shared post/lamp uniforms under the names the scene appliers use. */
  private sceneApplyArgs(): SceneApplyArgs {
    return {
      post: {
        uAperture: this.aperture,
        uBloom: this.bloomAmount,
        uHaze: this.haze,
        uVignette: this.vignette,
        uGrain: this.grain,
        uCaustics: this.caustics,
      } as unknown as SceneApplyArgs["post"],
      lamps: { uLampGain: this.lampGain } as unknown as SceneApplyArgs["lamps"],
      out: this.interactionSceneOut,
    };
  }

  /** Seed the out-params from config. Read unconditionally afterwards — the beam retrace consults
   *  them every frame — so a scene with no bindings must still find its authored values here. */
  private seedInteractionOut(): void {
    const c = this.config;
    this.interactionSceneOut.timeOffset = c.timeOffset;
    this.interactionSceneOut.zoom = 1;
    this.interactionSceneOut.beamIncidence = c.beam?.incidence ?? 0;
    this.interactionSceneOut.beamEntry = c.beam?.entry ?? 0.5;
    this.interactionSceneOut.orbitYaw = 0;
    this.interactionSceneOut.orbitPitch = 0;
  }

  /**
   * Per-frame binding write. No-op without a controller.
   *
   * While CAPTURING it writes the rest state — every bound parameter at its authored base — rather
   * than skipping the write. Skipping would leave whatever hover or scroll state the previous
   * frame put in the uniforms, so the same config would export a different image depending on
   * where the pointer happened to be.
   */
  private applyInteraction(): void {
    this.seedInteractionOut();
    if (!this.interaction) {
      this.interactionTime = 0;
      this.interactionZoom = 1;
      return;
    }
    this.applyBindings(this.capturing ? null : this.interaction);
  }

  /**
   * value = mix(from ?? authored base, to, smoothed source) — the same evaluation the GLSL engine
   * runs, through the same applier tables.
   *
   * A null controller is the REST state: every binding takes its AUTHORED base. Note that this is
   * NOT the same as evaluating the mix at zero — that yields `from`, which is the far end of the
   * reaction's travel and usually nowhere near what the scene was authored at. Prism's beam is
   * authored at -60 degrees and its incidence binding starts at -75, so the shortcut silently
   * exported every capture with the beam pointing somewhere the config never asked for.
   */
  private applyBindings(ic: InteractionController | null): void {
    const c = this.config;
    this.seedInteractionOut();
    const sceneArgs = this.sceneApplyArgs();
    for (const b of c.interaction?.bindings ?? []) {
      const applier = SCENE_APPLIERS[b.target];
      const value = ic
        ? THREE.MathUtils.lerp(b.from ?? applier.base(c), b.to, ic.bindingValue(b))
        : applier.base(c);
      applier.apply(value, sceneArgs);
    }
    const lampCount = Math.min(c.lamps.length, MAX_LAMPS);
    for (let i = 0; i < lampCount; i++) {
      const bindings = c.lamps[i].bindings;
      if (!bindings?.length) continue;
      const args = { vec: this.lampData[i] };
      for (const b of bindings) {
        const applier = LAMP_APPLIERS[b.target];
        const value = ic
          ? THREE.MathUtils.lerp(b.from ?? applier.base(c.lamps[i]), b.to, ic.bindingValue(b))
          : applier.base(c.lamps[i]);
        applier.apply(value, args);
      }
    }
    for (const item of this.items) {
      const bindings = item.config?.interaction?.bindings;
      if (!bindings?.length || !item.bound || !item.base) continue;
      const args = {
        u: item.bound as unknown as ItemApplyArgs["u"],
        mesh: item.mesh,
        home: item.home,
      };
      for (const b of bindings) {
        const applier = ITEM_APPLIERS[b.target];
        const value = ic
          ? THREE.MathUtils.lerp(
              b.from ?? applier.base(item.base, item.home),
              b.to,
              ic.bindingValue(b),
            )
          : applier.base(item.base, item.home);
        applier.apply(value, args);
      }
    }
    // A time offset is a DELTA over the authored one; zoom is a plain multiplier.
    this.interactionTime = this.interactionSceneOut.timeOffset - c.timeOffset;
    this.interactionZoom = this.interactionSceneOut.zoom;
  }

  /** Resolve `hoverSelf` / `pressSelf` against the meshes that actually bind them. */
  private updateItemHover(ic: InteractionController): void {
    if (this.collectHitCandidates("hoverSelf")) {
      ic.setHoverItem(this.resolveItemHit(ic.pointerTarget()));
    }
    // A pending press must ALWAYS be consumed, even when nothing binds it, or it waits forever.
    const pressNdc = ic.pendingPress();
    if (pressNdc) {
      this.collectHitCandidates("pressSelf");
      ic.setPressItem(this.resolveItemHit(pressNdc));
    }
  }

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

  /** The nearest hit's index into the RESOLVED item list — the controller's index space. */
  private resolveItemHit(ndc: { x: number; y: number } | null): number | null {
    if (!ndc || this.hoverCandidates.length === 0) return null;
    this.hoverNdc.set(ndc.x, ndc.y);
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.hoverNdc, this.camera);
    const hit = this.raycaster.intersectObjects(this.hoverCandidates, false)[0];
    if (!hit) return null;
    const item = this.items.find((entry) => entry.mesh === hit.object);
    const index = item?.config ? this.resolvedItems.indexOf(item.config) : -1;
    return index >= 0 ? index : null;
  }

  /**
   * Retrace the beam when a binding has moved it.
   *
   * A beam's path is decided on the CPU — Snell at each face, per wavelength — so no uniform can
   * bend it; the mesh has to be rebuilt. Compared against what the current mesh was traced from so
   * a pointer sitting still does not rebuild it every frame for an identical answer.
   */
  private retraceBeamIfMoved(): void {
    const beam = this.config.beam;
    if (!beam) return;
    // Only a scene that BINDS the beam can move it. Without this the retrace is reachable on
    // scenes that have no interaction at all, where rebuilding the mesh mid-frame is pure risk for
    // an answer that cannot have changed.
    const bound = (this.config.interaction?.bindings ?? []).some(
      (b) => b.target === "beamIncidence" || b.target === "beamEntry",
    );
    if (!bound) return;
    const want = {
      incidence: this.interactionSceneOut.beamIncidence,
      entry: this.interactionSceneOut.beamEntry,
    };
    const from = this.beamTracedFrom;
    if (from && from.incidence === want.incidence && from.entry === want.entry) return;
    const authored = { incidence: beam.incidence, entry: beam.entry };
    beam.incidence = want.incidence;
    beam.entry = want.entry;
    this.buildBeam();
    beam.incidence = authored.incidence;
    beam.entry = authored.entry;
    // `buildBeam` recorded the AUTHORED pair it was handed; correct it to what was actually
    // traced, or the next frame sees a mismatch and rebuilds again for the same answer.
    this.beamTracedFrom = want;
  }

  pick(clientX: number, clientY: number): MaterialItem | null {
    const ndc = this.toNdc(clientX, clientY);
    if (!ndc) return null;
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = this.items.map((item) => item.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const found = this.items.find((item) => item.mesh === hit.object);
    return (found as unknown as MaterialItem) ?? null;
  }

  /**
   * Where a pointer ray meets the plane through `through` that faces the camera.
   *
   * The plane FACES THE CAMERA rather than being axis-aligned, so a drag tracks the pointer at
   * whatever angle the scene is being viewed from instead of sliding away as the orbit turns.
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

  /**
   * The item's screen rectangle, from all EIGHT corners of its bounding box.
   *
   * Projecting the box's own min and max would be wrong under rotation: the extremes of the
   * projected shape are not the projections of the extremes.
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
      const x = rect.left + ((this.projectScratch.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - this.projectScratch.y) / 2) * rect.height;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Add a mesh built in code, outside the scene config.
   *
   * It gets the same material graph a configured item does, so an imperatively added shape is
   * glass or metal in exactly the same sense — there is no second, lesser material path.
   */
  add(geometry: THREE.BufferGeometry, options: AddOptions = {}): MaterialItem {
    const { material, uniforms, planes } = this.buildItemMaterial({
      shape: normalizeShape(undefined),
      material: options.material ?? {},
    } as unknown as ItemConfig);
    const mesh = new THREE.Mesh(geometry, material);
    if (options.position) mesh.position.set(...options.position);
    if (options.rotationOrder) mesh.rotation.order = options.rotationOrder;
    if (options.rotation) mesh.rotation.set(...options.rotation);
    if (options.scale !== undefined) {
      const sc = options.scale;
      if (typeof sc === "number") mesh.scale.set(sc, sc, sc);
      else mesh.scale.set(...sc);
    }
    this.scene.add(mesh);
    const entry = {
      mesh,
      uniforms,
      planes,
      // No config: an item added in code is not a prism the tracer can walk, and
      // `applyPrismPlanes` uses exactly this to decide that. Nothing can bind to it either, which
      // is why it carries no `base`/`bound`.
      base: undefined,
      bound: undefined,
      config: undefined,
      motion: normalizeMotion(options.motion),
      phase: options.phase ?? 0,
      home: mesh.position.clone(),
      homeRotation: mesh.rotation.clone(),
      homeScale: mesh.scale.clone(),
    };
    this.items.push(entry);
    return entry as unknown as MaterialItem;
  }

  remove(item: MaterialItem): void {
    const index = this.items.findIndex((entry) => entry.mesh === item.mesh);
    if (index < 0) return;
    const [entry] = this.items.splice(index, 1);
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
  }

  clear(): void {
    while (this.items.length > 0)
      this.remove(this.items[this.items.length - 1] as unknown as MaterialItem);
  }

  setInteractionInput(name: string, value: number): this {
    this.interaction?.setInput(name, value);
    return this;
  }

  setScrollPreview(value: number | null): this {
    this.scrollPreview = value === null ? null : Math.min(1, Math.max(0, value));
    if (this.interaction) {
      this.interaction.scrollOverride = this.scrollPreview;
      this.interaction.snapScroll();
      this.renderOnce();
    }
    return this;
  }

  setScrollTestProgress(value: number): this {
    this.scrollPreview = Math.min(1, Math.max(0, value));
    if (!this.interaction) return this;
    this.interaction.scrollOverride = this.scrollPreview;
    if (!this.running) {
      this.interaction.snapScroll();
      this.seek(this.time);
    }
    return this;
  }

  /**
   * Drag to orbit, wheel to zoom — the twin of the WebGL engine's `bindOrbit`.
   *
   * This engine had `yaw`, `pitch` and `distance`, and `updateCamera` read all three, but NOTHING
   * ever wrote them: the whole control block was missed in the port, so a scene with `orbit` on was
   * simply inert here while the WebGL engine orbited and zoomed. It survived every comparison in
   * this directory because they all drive the pointer, and none of them turns a wheel.
   */
  private bindOrbit(): void {
    const canvas = this.canvas;
    const { signal } = this.listeners;
    let dragging = false;
    let px = 0;
    let py = 0;
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        // SECONDARY button (right, or middle as the 3D-app convention). The primary belongs to
        // whatever is layered on top — the studio marquee-selects with it, and a left-drag that
        // orbited underneath a rubber band would make selection impossible.
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
        // Clamped hard: this is a hero composition, not a model viewer. Past these angles the lamp
        // field slides out from behind the glass and the illusion goes with it.
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
      // NOT passive: the handler calls `preventDefault` to stop the page scrolling under the
      // gesture, and a passive listener is forbidden from doing that.
      { signal, passive: false },
    );
  }

  /** Redraw only when the loop is not already doing it. */
  private renderIfIdle(): void {
    if (!this.running && !this.capturing) this.renderOnce();
  }

  /** Put the camera back where the scene asked for it. Snaps rather than eases — it is a reset. */
  resetCamera(): void {
    this.yaw = 0;
    this.pitch = 0;
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.distance = this.config.camera.distance;
    this.updateCamera(false);
    this.renderOnce();
  }

  private updateCamera(ease = false): void {
    const cam = this.config.camera;
    // Eased toward the drag target on animated frames, snapped everywhere else — the same split
    // the WebGL engine makes, so a reset lands rather than easing toward a target the loop may not
    // be running to advance.
    const k = ease ? 0.07 : 1;
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    // The zoom binding is a multiplier over the authored distance (2 = twice as close); the orbit
    // ones are degrees ADDED to the drag-orbit, so a scene can have both and they compose rather
    // than fight over the same variable.
    const d = (this.distance || cam.distance) / Math.max(this.interactionZoom, 0.05);
    const yaw = this.yaw + THREE.MathUtils.degToRad(this.interactionSceneOut.orbitYaw);
    const pitch =
      this.pitch + 2 * Math.tan(THREE.MathUtils.degToRad(this.interactionSceneOut.orbitPitch));
    this.camera.position.set(Math.sin(yaw) * d, cam.height + pitch * d * 0.5, Math.cos(yaw) * d);
    this.camera.lookAt(cam.lookAt.x, cam.lookAt.y, cam.lookAt.z);
    if (cam.roll) this.camera.rotateZ((cam.roll * Math.PI) / 180);
  }

  /** Push every non-structural config value into the live uniforms. */
  refresh(): void {
    this.applyConfig();
    this.updateCamera();
    this.renderOnce();
  }

  /** Rebuild everything a structural change invalidates — the item list, the beam, the targets. */
  rebuild(): void {
    this.buildItems();
    this.buildBeam();
    this.applyConfig();
    this.resize();
    this.renderOnce();
  }

  onFrame(callback: ((time: number) => void) | null): this {
    this.frameCallback = callback;
    return this;
  }

  captureStream(fps = 60): MediaStream {
    return this.canvas.captureStream(fps);
  }

  resize(): void {
    // `||`, NOT `??`. `clientWidth` returns 0 for an element that is hidden or not yet laid out,
    // and `0 ?? 1` is 0 — which makes `camera.aspect` 0/0, and a NaN projection matrix renders
    // nothing at all. Nothing about the failure points back here: the canvas is present, the
    // passes run, and every pixel comes out empty.
    const w = this.outputSize?.width || this.container.clientWidth || 1;
    const h = this.outputSize?.height || this.container.clientHeight || 1;
    // An explicit output size is a request for EXACTLY that many pixels — a headless render must
    // not be silently doubled by the display's ratio.
    // `dprMax`, not a hard 2: the config's ceiling is the whole point of the setting, and the
    // WebGL engine honours it.
    const ratio = this.outputSize
      ? 1
      : Math.min(globalThis.devicePixelRatio || 1, this.config.dprMax);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, this.ownsCanvas);
    this.camera.aspect = w / h;
    this.aspect.value = w / h;
    // Re-derived here, not once in the constructor: `fit` and `minVisibleWidth` are answers to a
    // question only the live aspect can ask, so a camera posed at construction ignores both and
    // every preset authored for anything but 16:9 frames differently from the WebGL engine.
    const cam = this.config.camera;
    this.camera.fov = frameFov(cam.fov, this.camera.aspect, cam.fit, cam.minVisibleWidth);
    this.camera.updateProjectionMatrix();
    // The wall's extent is derived from the aspect, so it has to be re-derived here.
    this.refreshWallExtent();

    // Size the backdrop the way the WebGL engine does — an oversized plane, never below the
    // authored 160x110, with the visible fraction recorded. The vertical ramp is calibrated
    // against that span, so a plane sized to the frame pulls the whole ramp into view and reads as
    // a far stronger gradient than the scene asked for.
    const backdropZ = this.config.plate.z - 14;
    const dist =
      Math.abs(this.camera.position.z) + Math.abs(this.config.camera.lookAt.z - backdropZ);
    const need = 2 * dist * Math.tan((this.camera.fov * Math.PI) / 360) * 1.35;
    const bh = Math.max(110, need);
    const bw = Math.max(160, need * this.camera.aspect);
    (this.bgSize.value as THREE.Vector2).set(bw, bh);
    const visibleH = need / 1.35;
    (this.bgFrame.value as THREE.Vector2).set(
      Math.min(1, (visibleH * this.camera.aspect) / bw),
      Math.min(1, visibleH / bh),
    );
    if (this.backdrop) {
      this.backdrop.scale.set(bw, bh, 1);
      this.backdrop.position.z = backdropZ;
    }

    // The drawing buffer, then the SCENE resolution within it. `quality` below 1 renders the scene
    // and post smaller and lets the blit to the screen upscale, exactly as the WebGL engine does —
    // it used to be ignored here entirely, which made the setting a no-op on this engine and left
    // the two renderers 2.06 apart at quality 0.5.
    const pw = Math.max(1, Math.round(w * ratio));
    const ph = Math.max(1, Math.round(h * ratio));
    const rw = Math.max(1, Math.round(pw * this.config.quality));
    const rh = Math.max(1, Math.round(ph * this.config.quality));
    (this.resolution.value as THREE.Vector2).set(rw, rh);
    (this.outputResolution.value as THREE.Vector2).set(pw, ph);
    // Gather radii are authored in full-resolution pixels; scaling by `quality` keeps them the
    // same fraction of the frame when the scene renders smaller than the canvas.
    this.postScale.value = this.config.quality;
    const hdr = this.config.post.toneMap !== "none";
    if (!this.targets) {
      this.targets = createTargets(rw, rh, pw, ph, hdr);
      this.buildPasses(this.targets);
    } else {
      resizeTargets(this.targets, rw, rh, pw, ph);
      // The graphs hold texture references, and a resize replaces the underlying storage — for the
      // items too, which sample the plate.
      this.buildPasses(this.targets);
      if (this.items.length) this.buildItems();
    }
  }

  private async draw(): Promise<void> {
    await this.ready;
    const t = this.targets;
    if (!t || !this.passes) {
      // Before the targets exist there is nothing to compose, so draw straight to the screen
      // rather than skipping the frame entirely and showing whatever was there before.
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // The bindings write into live uniforms, so they run before anything reads them. Also seeds
    // the beam's wanted incidence/entry, which the retrace below consults.
    // MOTIONS FIRST, BINDINGS SECOND. The order is load-bearing and it is the WebGL engine's:
    // `ITEM_APPLIERS.positionY` writes `mesh.position.y` directly, so whichever runs last owns that
    // component. Running the bindings after means a bound axis wins over a drift on the same axis,
    // which is what a scene asking for both is asking for. Running them first — as this engine did
    // — means the drift wins and the binding is silently inert at rest.
    //
    // It shows up as a POSE difference, not as anything that looks like a binding problem: on
    // `staircase`, where every one of the twenty shapes binds `positionY` to scroll and also
    // drifts, each shape sat about a tenth of a unit off from where the WebGL engine put it, and
    // that fed straight into the measured optical path and out into the colour.
    //
    // Both engines drive the motions on the PREVIOUS frame's `interactionTime`, because that is
    // what `applyInteraction` has produced by this point in the frame. A `timeOffset` binding
    // scrubs the clock as a DELTA, so the authored timeline is untouched and removing it restores.
    this.timeUniform.value = this.time + this.interactionTime;
    applyMotions(
      this.items as unknown as MaterialItem[],
      this.time + this.interactionTime,
      this.config.loopSeconds,
    );
    this.applyInteraction();
    this.retraceBeamIfMoved();
    this.updateCamera(true);
    // The traced planes are world-space, so they follow the pose and have to be recomputed after it.
    for (const entry of this.items) this.applyPrismPlanes(entry);
    // The wall's contact shadows follow the poses too.
    if (this.config.backgroundMode === "wall") this.applyGrounding();
    // The room, baked before anything samples it. Cheap after the first call — it returns on an
    // unchanged key — but a fresh target invalidates every graph that captured the texture, which
    // is why the rebuild is driven from its return rather than from the config change.
    if (await this.buildEnvironment()) {
      this.backGlass?.material.dispose();
      this.backGlass = undefined;
      if (this.items.length) this.buildItems();
    }

    // 0. Depth — the back faces, as linear depth. The post pass's gather measures its circle of
    //    confusion against this, and without it every fragment reads depth zero and comes back at
    //    maximum defocus, which is a frame of blocks rather than a picture.
    // 0a. FRONT depth, for the post pass's gather.
    //
    // Cleared to the FOCAL depth, not to zero: a backdrop sitting far outside the focal range has
    // a maximal circle of confusion, so every background pixel near a shape gathers a dozen pixels
    // of that shape's colour and the frame turns to smeared watercolour. Pinning the background to
    // the focal plane removes the bleed outright, and backgrounds are smooth gradients that do not
    // need blurring anyway.
    this.frontDepthMaterial ??= this.buildFrontDepthMaterial();
    const focal = Math.min(1, Math.max(0, this.config.post.focus / FAR));
    const focalLow = (focal * 255) % 1;
    this.depthClear.setRGB(focal - focalLow / 255, focalLow, 0);
    const previousClear0 = this.renderer.getClearColor(new THREE.Color());
    const previousClearAlpha0 = this.renderer.getClearAlpha();
    // Derived from the CONFIG, not read back off the meshes. Reading the live flag makes each
    // frame's restore depend on the previous frame's, so a single interleaved draw hides the
    // backdrop and the beam permanently — there is nothing that ever puts them back. It is also
    // the only place `transparentBackground` was being honoured on this engine, which is to say
    // it was not: the WebGL engine hides the backdrop for it and this one never did.
    const showBackdrop = !this.config.transparentBackground;
    const showBeam = true;
    const backdropWasVisible0 = showBackdrop;
    const beamWasVisible0 = showBeam;
    if (this.backdrop) this.backdrop.visible = false;
    if (this.beamMesh) this.beamMesh.visible = false;
    if (this.causticMesh) this.causticMesh.visible = false;
    this.scene.overrideMaterial = this.frontDepthMaterial;
    this.renderer.setClearColor(this.depthClear, 1);
    this.renderer.setRenderTarget(t.front);
    this.renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = null;
    this.renderer.setClearColor(previousClear0, previousClearAlpha0);
    if (this.backdrop) this.backdrop.visible = backdropWasVisible0;
    if (this.beamMesh) this.beamMesh.visible = beamWasVisible0;
    if (this.causticMesh) this.causticMesh.visible = beamWasVisible0;

    this.depthMaterial ??= this.buildDepthMaterial();
    this.scene.overrideMaterial = this.depthMaterial;
    // The backdrop and the beam are HIDDEN here, and both for the same reason: under an override
    // material every mesh is drawn with it, and neither of these has a meaningful back face. The
    // backdrop's would blanket the frame in false thickness; the beam is a sheet of quads lying
    // across the scene, so it would hand every pixel it covers a near exit surface and make the
    // glass behind it read as paper-thin.
    const backdropWasVisible = showBackdrop;
    const beamWasVisible = showBeam;
    if (this.backdrop) this.backdrop.visible = false;
    if (this.beamMesh) this.beamMesh.visible = false;
    if (this.causticMesh) this.causticMesh.visible = false;
    // CLEARED TO BLACK, not to the scene background. A pixel with no back face must come out with
    // no thickness, and zero minus the front depth clamps to exactly that; clearing to anything
    // else gives empty space an optical path.
    const previousClear = this.renderer.getClearColor(new THREE.Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setRenderTarget(t.back);
    this.renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = null;
    this.renderer.setClearColor(previousClear, previousClearAlpha);
    if (this.backdrop) this.backdrop.visible = backdropWasVisible;

    // 1. Plate — the backdrop and every shape, un-refracted. What the main pass refracts.
    // The beam stays hidden for the plate too: the plate is what the glass REFRACTS, and the
    // tracer has already computed the beam's true path through the glass. Carrying it here as well
    // refracts it a second time and draws a bent ghost of the beam inside the solid.
    // 0b. The plate WITHOUT the glass, for `material.bend`. A refracted ray near the centre of a
    //     convex solid lands back inside that solid's own silhouette, where the ordinary plate
    //     holds its clear-glass pixel rather than the backdrop — so a real optical path needs a
    //     plate with no glass in it. Skipped by every scene that asks for no bending.
    if (this.wantsPlainPlate()) {
      const hidden = this.items.map((item) => item.mesh.visible);
      for (const item of this.items) item.mesh.visible = false;
      this.passIndex.value = 0;
      this.bindPlate(false);
      this.bindPlain(false);
      this.renderer.setRenderTarget(t.plain);
      this.renderer.render(this.scene, this.camera);
      for (const [i, item] of this.items.entries()) item.mesh.visible = hidden[i];
    }

    this.passIndex.value = 0;
    this.bindPlate(false);
    this.bindPlain(false);
    this.renderer.setRenderTarget(t.plate);
    this.renderer.render(this.scene, this.camera);
    if (this.beamMesh) this.beamMesh.visible = beamWasVisible;
    if (this.causticMesh) this.causticMesh.visible = beamWasVisible;

    // 1b. The solids' INNER interfaces, added into the plate — light that bounced its way back out
    //     of a far face, so the near faces have something to show other than the backdrop.
    await this.renderBackGlass(t);

    // 2. Main — the same frame again, now refracting the plate. Tubes refracting tubes.
    this.passIndex.value = 1;
    this.bindPlate(true);
    this.bindPlain(true);
    this.renderer.setRenderTarget(t.color);
    this.renderer.render(this.scene, this.camera);

    // 3. Bloom, between main and post so it sees the frame while it still has range to work with.
    await this.renderBloom(t);

    // A dev harness can ask for an intermediate target instead of the composed frame.
    const dump = devProbe();
    if (dump?.startsWith("env")) {
      const level = Number(dump.slice(3)) || 0;
      this.debugEnv ??= passMaterial(
        vec4(TSL.texture(this.envTexture(), uv()).level(TSL.float(level)).rgb, 1),
      );
      this.quad.blit(this.renderer, this.debugEnv, null);
      return;
    }
    if (dump === "platealpha") {
      // The plate's ALPHA, shown as luminance: it stores linear depth, and the main pass validates
      // every refracted sample against it, so what is in it is worth being able to look at.
      this.debugAlpha ??= passMaterial(
        vec4(
          vec3(
            TSL.texture(t.plate.texture, TSL.vec2(TSL.screenUV.x, TSL.float(1).sub(TSL.screenUV.y)))
              .a.mul(FAR)
              .div(19),
          ),
          1,
        ),
      );
      this.quad.blit(this.renderer, this.debugAlpha, null);
      return;
    }
    // The bloom pyramid, level by level — `bloom0`..`bloom3` are the blurred levels and `bloomC`
    // the composite. Not cached: unlike `debugBlit` these differ per name.
    if (dump === "coloralpha") {
      this.quad.blit(
        this.renderer,
        passMaterial(
          vec4(
            TSL.vec3(TSL.texture(t.color.texture, TSL.vec2(uv().x, TSL.float(1).sub(uv().y))).a),
            1,
          ),
        ),
        null,
      );
      return;
    }
    const bloomLevel = dump && /^bloom[0-3]$/.test(dump) ? Number(dump.slice(5)) : -1;
    if (bloomLevel >= 0 || dump === "bloomC") {
      const src = bloomLevel >= 0 ? t.bloom[bloomLevel].a.texture : t.bloom[0].b.texture;
      // Same flip as `debugColor` below, NOT `screenUV` like the plate/back/front dumps: these are
      // pyramid levels of the colour target and have to land in the colour target's orientation.
      // Dumped through `screenUV` they came back mirrored top-to-bottom, which reads as a large
      // difference concentrated on whatever is off-centre — here, the beam.
      this.quad.blit(this.renderer, passMaterial(vec4(TSL.texture(src, uv()).rgb, 1)), null);
      return;
    }
    if (dump === "plate" || dump === "back" || dump === "front" || dump?.startsWith("plate:")) {
      const src =
        dump === "back" ? t.back.texture : dump === "front" ? t.front.texture : t.plate.texture;
      // Alpha forced to one: the plate stores linear DEPTH there, and letting it reach the canvas
      // composites the whole frame away at about one percent opacity.
      // NO V-FLIP, for the same reason `debugColor` has none: these dumps exist to be DIFFED
      // against the WebGL engine's, which blits its targets unflipped. They used to flip so a
      // human saw the target upright, which made every comparison a mirror image.
      this.debugBlit ??= passMaterial(vec4(TSL.texture(src, TSL.screenUV).rgb, 1));
      this.quad.blit(this.renderer, this.debugBlit, null);
      return;
    }
    // ANY OTHER PROBE IS A MATERIAL INTERMEDIATE, substituted into the main pass — so blit the
    // colour target straight to the screen rather than composing it.
    //
    // Post is not a window onto what the material computed: tone mapping, bloom, haze, vignette and
    // grain are all non-linear, so a probe pushed through them is a different number — one that
    // saturates, that shifts by a constant, and that answers identically for two different probes
    // wherever the shape covers little of the frame. Reading probes through post is the single most
    // effective way to misread this tool. The WebGL engine bypasses post at the same point, so the
    // two stay comparable.
    if (dump) {
      // NO V-FLIP, unlike the `plate`/`back` dumps above. Those exist to be LOOKED at, and flip so
      // a human sees the target upright. This one exists to be DIFFED against the WebGL engine's
      // bypass, which blits through `vUvIn` unflipped — so a flip here mirrors every probe against
      // its twin. It shows up as a sign flip in any y-bearing quantity and as nothing at all in a
      // constant, which is why the calibration probe cannot catch it.
      this.debugColor ??= passMaterial(
        vec4(TSL.texture(t.color.texture, TSL.vec2(uv().x, TSL.float(1).sub(uv().y))).rgb, 1),
      );
      this.quad.blit(this.renderer, this.debugColor, null);
      return;
    }

    // 4. Post — to the screen.
    // 5. Post, and then the FINISH pass if any of its effects is on. When none is — the usual
    //    case — post draws straight to the screen and the extra target is never touched.
    if (this.needsFinish()) {
      this.finishMaterial ??= this.buildFinishMaterial(t.finish.texture);
      if (this.finishSource) this.finishSource.value = t.finish.texture;
      this.quad.blit(this.renderer, this.passes.post, t.finish);
      this.quad.blit(this.renderer, this.finishMaterial, null);
    } else {
      this.quad.blit(this.renderer, this.passes.post, null);
    }

    // 6. Dust — additively over the FINISHED frame, in display space.
    //
    // After the bloom for the obvious reason that the bloom is what tells each grain whether any
    // light reaches it, and after the TONE MAP for a less obvious one: a mote is a point of light
    // in its own right rather than part of the scene beneath it, so drawing it into the HDR target
    // would compress it together with whatever it lands on. That crushes every mote sitting on the
    // beam — exactly where they are brightest — and passes them through the depth of field
    // besides, smearing specks that should be pixel-sharp. Each grain tone maps itself instead.
    this.applyDust(t);
    if (this.dustMesh) {
      this.renderer.setRenderTarget(null);
      const wasAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.render(this.dustScene, this.camera);
      this.renderer.autoClear = wasAutoClear;
    }
    this.frameCallback?.(this.time);
    this.renderPending();
  }

  /**
   * Draw, unless one is already in flight.
   *
   * A request arriving mid-draw is DROPPED rather than queued. This is a render loop: a backlog of
   * frames computed against state that has since moved on is worse than a skipped frame, and
   * queueing them would let the backlog grow without bound whenever a frame costs more than 16ms.
   */
  private drawGuarded(): Promise<void> {
    if (this.drawing) return this.drawing;
    const run = this.draw().finally(() => {
      if (this.drawing === run) this.drawing = null;
    });
    this.drawing = run;
    return run;
  }

  /**
   * Wait for any in-flight draw, then run `work` before another can start.
   *
   * Anything that REPLACES scene objects has to go through here. A rebuild landing between two of
   * `draw`'s awaits swaps the meshes out from under a pass that has already hidden them and is
   * about to restore them, which leaves the new objects in whatever state the old ones were in.
   *
   * `work` is synchronous on purpose: `requestAnimationFrame` fires as a task, so nothing can start
   * a draw between this resuming and `work` returning — but only for as long as `work` never yields.
   */
  private async exclusive<T>(work: () => T): Promise<T> {
    while (this.drawing) await this.drawing.catch(() => undefined);
    return work();
  }

  renderOnce(): void {
    void this.drawGuarded();
  }

  start(): this {
    if (this.running) return this;
    this.running = true;
    // Seeded HERE, not at construction: the gap between the two is however long the device
    // negotiation took, and feeding that in as the first delta jumps the scene forward.
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(loop);
      // WALL CLOCK, not a fixed 1/60. The frame callback fires at the display's refresh rate, so a
      // fixed step runs a 120Hz screen at exactly double speed and a 144Hz one at 2.4x — the scene
      // is simply faster on better hardware, which is not something anyone would attribute to the
      // renderer. Capped at 50ms so a backgrounded tab resumes where it left off instead of
      // teleporting through however long it was away.
      const delta = Math.min((now - this.lastFrame) / 1000, 0.05);
      this.lastFrame = now;
      if (!this.config.paused) {
        // The ramp scales ACCUMULATION, never the clock itself: `seek` still sets an absolute
        // time, so captures and posters stay reproducible.
        if (this.introRamp < 1) this.introRamp = Math.min(1, this.introRamp + delta);
        this.time += delta * (this.config.introRamp ? this.introRamp : 1);
      }
      if (this.interaction) {
        // Hover BEFORE the sources advance, so `hoverSelf` resolves against the pointer position
        // this frame rather than the smoothed value from the last one.
        this.updateItemHover(this.interaction);
        this.interaction.update(delta); // the SAME delta the scene advanced by
      }
      void this.drawGuarded();
    };
    this.frame = requestAnimationFrame(loop);
    return this;
  }

  stop(): this {
    this.running = false;
    cancelAnimationFrame(this.frame);
    return this;
  }

  refreshPlayback(): void {
    if (this.config.paused) this.stop();
    else this.start();
  }

  seek(time: number): void {
    this.time = time;
    this.renderOnce();
  }

  getConfig(): SceneConfig {
    return this.config;
  }

  /**
   * Adopt a new scene.
   *
   * `applyConfig` alone is not enough, and that gap is the whole reason this is not a one-liner: it
   * pushes uniform VALUES, while the item list, the beam and the render targets are OBJECTS built
   * once from the config. Changing preset without rebuilding them left the previous scene's meshes
   * on screen wearing the new scene's uniforms — every studio preset drew as one leftover shape,
   * which reads as "WebGPU is broken" rather than as a stale mesh list.
   *
   * The structural test mirrors `MaterialRenderer.setConfig` deliberately: the two engines have to
   * agree on when a change is structural, or a scene rebuilds under one and not the other.
   *
   * The rebuild is chained onto `ready` because this renderer negotiates a device asynchronously —
   * a `setConfig` arriving before that resolves would otherwise build items against a renderer
   * that cannot yet allocate anything.
   */
  setConfig(config: Partial<SceneConfig>): void {
    const previous = this.config;
    // A REPLACE, not a merge — matching the WebGL engine. Spreading the old config underneath
    // would let a key the new scene deliberately omits survive from the old one.
    const next = ensureSceneConfig(config);
    const structural =
      next.quality !== previous.quality ||
      next.post.toneMap !== previous.post.toneMap ||
      JSON.stringify(next.scatter) !== JSON.stringify(previous.scatter) ||
      JSON.stringify(next.items) !== JSON.stringify(previous.items) ||
      // The beam is geometry built from these, not a uniform read per frame.
      JSON.stringify(next.beam) !== JSON.stringify(previous.beam);

    this.config = next;
    // Only when the SCENE asks for a different distance: this field also holds however far the
    // viewer has orbited out to, and overwriting it on every edit would snap their view back.
    if (next.camera.distance !== previous.camera.distance) this.distance = next.camera.distance;

    if (!structural) {
      this.refresh();
      this.resize();
      this.refreshPlayback();
      return;
    }
    void this.ready.then(() =>
      // EXCLUSIVE: this replaces the item meshes, the beam and the render targets, and a draw
      // holding references to the old ones is almost certainly in flight.
      this.exclusive(() => {
        this.rebuild();
        // AFTER `rebuild`: `resize` inside it re-derives the fov from the new camera config, and
        // `updateCamera` has to run against that rather than the previous scene's framing.
        this.updateCamera();
        this.refreshPlayback();
        this.renderOnce();
      }),
    );
  }

  setLamps(lamps: LampConfig[]): this {
    this.config.lamps = lamps;
    this.applyConfig();
    return this;
  }

  setPost(post: Partial<PostConfig>): this {
    this.config.post = { ...this.config.post, ...post };
    this.applyConfig();
    return this;
  }

  async captureImage(mime = "image/webp", quality?: number, time?: number): Promise<Blob> {
    if (time !== undefined) this.time = time;
    // Strip the live interaction state, exactly as the WebGL engine does. `applyBindings` already
    // writes the REST values while `capturing` — see `draw` — but the CAMERA is posed from these
    // four, and leaving them live meant a capture was framed from wherever the last pointer had
    // swung it. They are not zero at rest either: before any pointer arrives the sources read 0
    // rather than their midpoint, so a scene binding `cameraYaw` captured from the binding's
    // `from` end. This was found and fixed in the WebGL engine and never mirrored here, which is
    // its own lesson about porting a fix to one of two engines.
    this.interactionTime = 0;
    this.interactionZoom = 1;
    this.interactionSceneOut.orbitYaw = 0;
    this.interactionSceneOut.orbitPitch = 0;
    // Waits rather than skipping: a capture has to reflect the time it was asked for, so returning
    // whatever frame happened to be in flight would hand back the previous one.
    await this.exclusive(() => undefined);
    this.capturing = true;
    try {
      await this.drawGuarded();
    } finally {
      this.capturing = false;
    }
    return new Promise<Blob>((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("captureImage produced no blob"))),
        mime,
        quality,
      );
    });
  }

  dispose(): void {
    this.listeners.abort();
    this.disposeMedia();
    this.stop();
    this.interaction?.dispose();
    this.interaction = undefined;
    if (this.targets) disposeTargets(this.targets);
    this.envTarget?.dispose();
    this.quad.dispose();
    this.renderer.dispose();
    if (this.ownsCanvas) this.canvas.remove();
  }
}
