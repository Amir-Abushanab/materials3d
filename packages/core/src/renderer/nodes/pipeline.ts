/**
 * The pass pipeline for the node engine: the targets it renders into and the order it walks them.
 *
 * Separated from `NodeMaterialRenderer` because the ORDER is the part worth reading on its own.
 * Four passes, and each exists because the one after it needs what it wrote:
 *
 *   DEPTH   the back faces, as linear depth. The main pass measures optical path against it, which
 *           is what lets absorption follow a shape's real thickness rather than a guessed chord.
 *   PLATE   the backdrop and every shape, with refraction disabled. This is what the main pass
 *           samples when glass refracts, and it is why glass can refract other glass.
 *   MAIN    the same frame again, now refracting the plate.
 *   POST    depth of field, bloom, tone mapping, to the screen.
 *
 * These are ISSUED, not awaited. `renderAsync` is deprecated as of three r181 in favour of
 * `render()` plus a single `await renderer.init()`, and awaiting it per pass cost about 10ms a
 * frame here — a frame is fifteen-odd passes, and that overhead did not vary with scene complexity
 * because it was never about the scene. It also removes every suspension point from `draw`, which
 * is where this engine's visibility save/restore used to interleave with itself. The old note
 * read: the renderer's `renderAsync` means every one of these is awaited rather than issued, so the
 * loop is async end to end where the WebGL engine's is not.
 */
import * as THREE from "three/webgpu";

export interface PassTargets {
  /**
   * FRONT-face linear depth, read by the post pass's depth-of-field gather.
   *
   * Separate from `back` because they answer different questions: this is how far away the surface
   * you can SEE is, which is what defocus is measured against, while `back` is where the light
   * leaves. It is also cleared differently — to the focal depth, so the backdrop sits in focus.
   */
  front: THREE.RenderTarget;
  /** Back-face linear depth, read by the main pass to measure thickness. */
  back: THREE.RenderTarget;
  /** The plate: backdrop plus shapes, un-refracted. Alpha carries linear depth. */
  plate: THREE.RenderTarget;
  /** The composed frame, before post. Half-float when a tone map is in play. */
  color: THREE.RenderTarget;
  /** Where post writes when the finish pass is going to run over it. */
  finish: THREE.RenderTarget;
  /** Bloom pyramid, two targets per level for the separable blur. */
  bloom: { a: THREE.RenderTarget; b: THREE.RenderTarget }[];
}

/** Half-resolution steps of the bloom pyramid; the last is the dust light field, not visible glow. */
export const BLOOM_DIVISORS = [2, 4, 8, 16] as const;
export const BLOOM_TAPS = [6, 10, 14, 18] as const;

/**
 * Allocate the pass targets.
 *
 * HDR is conditional on a tone map being configured, and that is not an optimisation: without a
 * half-float colour target the map is applied too late to matter, because the main pass has already
 * clipped everything above one on its way into an 8-bit buffer.
 */
/** A render target that never gets a zero dimension, however small the divisor makes it. */
const makeTarget = (w: number, h: number, options: object) =>
  new THREE.RenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), options);

/**
 * Allocate the pass targets at the SCENE resolution, except `finish`.
 *
 * `width`/`height` are the quality-scaled render size; `outWidth`/`outHeight` are the full
 * drawing-buffer size. The reference draws the scene and post at the former and resolves the finish
 * pass at the latter, because the finish effects — dither lattice, halftone cell, paper grain — are
 * authored in DEVICE pixels and must not be scaled by quality.
 */
export function createTargets(
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  hdr: boolean,
): PassTargets {
  const base = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
  };
  const scene = {
    ...base,
    type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
    // Multisampling covers geometric edges only, and is invisible on a smooth lathe — but a beam's
    // fan is made of long sub-pixel wedges near the exit face, where it is the difference between
    // a spectrum and a staircase.
    samples: hdr ? 4 : 0,
  };
  return {
    // NEAREST, not linear. The two-channel packing splits depth across r and g, and a blend of the
    // LOW byte of two different depths decodes to a distance that is in neither of them — which
    // shows up as wedges of wrong thickness wherever depth changes fast, meaning every silhouette.
    front: makeTarget(width, height, {
      ...base,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    }),
    back: makeTarget(width, height, {
      ...base,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    }),
    plate: makeTarget(width, height, scene),
    color: makeTarget(width, height, scene),
    finish: makeTarget(outWidth, outHeight, scene),
    // ROUND, not floor, and not the bare quotient: the reference rounds, and at 900x540 flooring
    // gives level 2 a 112x67 target where it has 113x68. That is a different sampling grid for the
    // widest level the composite reads, which is precisely the broad wash — worth ~3 levels of
    // mean difference on `prism`.
    bloom: BLOOM_DIVISORS.map((d) => ({
      a: makeTarget(Math.max(1, Math.round(width / d)), Math.max(1, Math.round(height / d)), {
        ...base,
        type: THREE.HalfFloatType,
        depthBuffer: false,
      }),
      b: makeTarget(Math.max(1, Math.round(width / d)), Math.max(1, Math.round(height / d)), {
        ...base,
        type: THREE.HalfFloatType,
        depthBuffer: false,
      }),
    })),
  };
}

export function resizeTargets(
  t: PassTargets,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): void {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  t.front.setSize(w, h);
  t.back.setSize(w, h);
  t.plate.setSize(w, h);
  t.color.setSize(w, h);
  t.finish.setSize(Math.max(1, Math.floor(outWidth)), Math.max(1, Math.floor(outHeight)));
  BLOOM_DIVISORS.forEach((d, i) => {
    t.bloom[i].a.setSize(Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d)));
    t.bloom[i].b.setSize(Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d)));
  });
}

export function disposeTargets(t: PassTargets): void {
  t.front.dispose();
  t.back.dispose();
  t.plate.dispose();
  t.color.dispose();
  t.finish.dispose();
  for (const level of t.bloom) {
    level.a.dispose();
    level.b.dispose();
  }
}

/**
 * A full-screen quad that can be pointed at any node material.
 *
 * One mesh reused across every blit rather than one per pass: the geometry is two triangles and the
 * material is what varies, so allocating a mesh per pass buys nothing and costs a draw-call setup
 * each time.
 */
export class FullScreenQuad {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.NodeMaterial());

  constructor() {
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /**
   * Draw `material` into `target`, or to the screen when target is null.
   *
   * `level` targets one mip rather than the base, which is how the environment chain is written:
   * eight blurs, each landing in the level it belongs to, inside a single texture.
   */
  blit(
    renderer: THREE.WebGPURenderer,
    material: THREE.NodeMaterial,
    target: THREE.RenderTarget | null,
    level = 0,
  ): void {
    this.mesh.material = material;
    renderer.setRenderTarget(target, 0, level);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

/** A node material for a full-screen pass, with depth testing off and the graph already attached. */
export function passMaterial(fragment: unknown): THREE.NodeMaterial {
  const material = new THREE.NodeMaterial();
  material.fragmentNode = fragment as never;
  material.depthTest = false;
  material.depthWrite = false;
  return material;
}
