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
 * The node renderer's `renderAsync` means every one of these is awaited rather than issued, so the
 * loop is async end to end where the WebGL engine's is not.
 */
import * as THREE from "three/webgpu";

export interface PassTargets {
  /** Back-face linear depth, read by the main pass to measure thickness. */
  back: THREE.RenderTarget;
  /** The plate: backdrop plus shapes, un-refracted. Alpha carries linear depth. */
  plate: THREE.RenderTarget;
  /** The composed frame, before post. Half-float when a tone map is in play. */
  color: THREE.RenderTarget;
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

export function createTargets(width: number, height: number, hdr: boolean): PassTargets {
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
    back: makeTarget(width, height, { ...base, type: THREE.UnsignedByteType }),
    plate: makeTarget(width, height, scene),
    color: makeTarget(width, height, scene),
    bloom: BLOOM_DIVISORS.map((d) => ({
      a: makeTarget(width / d, height / d, {
        ...base,
        type: THREE.HalfFloatType,
        depthBuffer: false,
      }),
      b: makeTarget(width / d, height / d, {
        ...base,
        type: THREE.HalfFloatType,
        depthBuffer: false,
      }),
    })),
  };
}

export function resizeTargets(t: PassTargets, width: number, height: number): void {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  t.back.setSize(w, h);
  t.plate.setSize(w, h);
  t.color.setSize(w, h);
  BLOOM_DIVISORS.forEach((d, i) => {
    t.bloom[i].a.setSize(Math.max(1, Math.floor(w / d)), Math.max(1, Math.floor(h / d)));
    t.bloom[i].b.setSize(Math.max(1, Math.floor(w / d)), Math.max(1, Math.floor(h / d)));
  });
}

export function disposeTargets(t: PassTargets): void {
  t.back.dispose();
  t.plate.dispose();
  t.color.dispose();
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
  async blit(
    renderer: THREE.WebGPURenderer,
    material: THREE.NodeMaterial,
    target: THREE.RenderTarget | null,
    level = 0,
  ): Promise<void> {
    this.mesh.material = material;
    renderer.setRenderTarget(target, 0, level);
    await renderer.renderAsync(this.scene, this.camera);
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
