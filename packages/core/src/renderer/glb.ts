/**
 * A `.glb` reader, and the cache the `model` shape kind draws on.
 *
 * WHY NOT `GLTFLoader`. three ships one, and it is the right tool for a scene: it resolves
 * materials, textures, cameras, skins and animation clips. This renderer throws all of that away.
 * A shape here is lit by the four-pass stack and shaded by a `MaterialConfig`, so the only thing
 * a `.glb` can contribute is its surface, and the glass shader reads exactly two attributes off
 * it, `position` and `normal`. Reading those directly is a few hundred lines against an addon
 * that pulls a second dependency into the renderer chunk to deliver data that is then discarded.
 *
 * WHAT IS READ. Every triangle primitive reachable from a scene's node tree, baked to world space
 * through the node transforms, merged into one geometry. Node transforms matter: a designer's
 * file is a hierarchy, and a reader that ignores them piles every part on the origin.
 *
 * WHAT IS NOT. Materials, textures, UVs, cameras, lights, skins, morph targets and animation.
 * Also the two compression extensions, which are the one omission a file can be REQUIRED to use;
 * those are refused by name rather than parsed into nonsense, see {@link GEOMETRY_EXTENSIONS}.
 * Quantized and sparse accessors ARE read: both are cheap, and half-reading either produces a
 * mesh that is wrong rather than one that is missing.
 */

import * as THREE from "three";

/** `glTF`, little-endian, the first word of every GLB. */
const MAGIC = 0x46546c67;
/** `JSON` and `BIN\0`, the two chunk types glTF 2.0 defines. */
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
/** glTF primitive mode 4. Points, lines, strips and fans have no surface to refract. */
const TRIANGLES = 4;

/** Bytes per component, by GL enum. */
const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/**
 * Past this a scene stops being a hero and starts being a stall.
 *
 * Every shape is drawn four times a frame, plus once more per bloom level, so a triangle here
 * costs several times what it costs in a single-pass viewer. A quarter of a million is a
 * generously detailed prop and roughly where a mid-range laptop stops holding 60fps on the
 * plate pass alone. Refused rather than accepted and quietly stuttered through: a file this
 * heavy is a decimation job, and saying so is more useful than dropping the frame rate and
 * leaving someone to guess which shape did it.
 */
export const MAX_MESH_TRIANGLES = 250_000;

/**
 * Extensions that COMPRESS the vertex data, and which this reader therefore cannot skip.
 *
 * Everything else a file can require is about appearance, which is replaced wholesale here, so
 * an unknown `KHR_materials_*` or `KHR_texture_*` is ignored rather than refused. These two
 * re-encode the buffer itself: parsing on past one of them reads compressed bytes as floats and
 * produces a cloud of noise where a mesh was meant to be. Reading them means shipping a decoder,
 * and Draco's is a couple of hundred kilobytes of WebAssembly, which is the whole dependency this
 * reader exists to avoid.
 *
 * `KHR_mesh_quantization` is deliberately NOT here, though it is often named alongside them. It
 * compresses nothing: it stores positions as shorts or bytes and puts the scale that undoes it on
 * the node, both of which this reader already handles. See {@link denormalize}.
 */
const GEOMETRY_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression"];

interface GltfAccessorRef {
  bufferView: number;
  byteOffset?: number;
  componentType?: number;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  /** Integer components that stand for a fraction; see {@link denormalize}. */
  normalized?: boolean;
  sparse?: { count: number; indices: GltfAccessorRef; values: GltfAccessorRef };
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  mode?: number;
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface Gltf {
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { uri?: string; byteLength: number }[];
  meshes?: { primitives?: GltfPrimitive[] }[];
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  extensionsRequired?: string[];
}

/** A parsed and fitted mesh, as {@link buildShape} and {@link defaultPath} consume it. */
export interface MeshEntry {
  /**
   * Fitted so its LARGEST half-extent is exactly 1, centred on its own bounding box.
   *
   * The same normalization `fitOutline` applies to a pasted SVG, and for the same reason: a file
   * authored in millimetres and one authored in metres should land at the same size, with `r`
   * as the one handle that resizes either. Unit-fitted rather than fitted to `r` so a single
   * cached copy serves every item that names this file, whatever radius each asks for.
   */
  geometry: THREE.BufferGeometry;
  /**
   * Half the shortest bounding-box extent at unit fit, the Beer-Lambert chord per unit of `r`.
   *
   * This is the number that made a `mesh` kind possible at all. `defaultPath` is a hand-written
   * constant per kind because a primitive's chord can be reasoned about; arbitrary geometry has
   * no such entry, and getting it wrong renders glass as opaque plastic. Measuring the shortest
   * extent reproduces the hand-written answer exactly for `rod`, `sphere`, `disc`, `ring`,
   * `slab` and `prism`, which is the check that it is measuring the right thing rather than
   * merely producing a number.
   */
  chord: number;
  triangles: number;
}

/** One component out of a DataView, by its GL type. */
function readComponent(data: DataView, at: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return data.getInt8(at);
    case 5121:
      return data.getUint8(at);
    case 5122:
      return data.getInt16(at, true);
    case 5123:
      return data.getUint16(at, true);
    case 5125:
      return data.getUint32(at, true);
    default:
      return data.getFloat32(at, true);
  }
}

/**
 * An integer component read back as the fraction it stands for, glTF's `normalized` rule.
 *
 * This is the whole of `KHR_mesh_quantization` as far as geometry is concerned. An exporter that
 * quantizes a mesh writes positions as shorts spanning the type's full range and hangs the scale
 * that restores world units on the node, which {@link walkNode} already applies. So the extension
 * needs no decoder, only this: the reader that treats a short as the number 32767 rather than as
 * 1.0 gets a mesh a thousand times too large, which is why ignoring the flag is not an option and
 * refusing the file was never necessary.
 *
 * Signed types clamp at -1: the negative end has one more representable step than the positive,
 * and the spec discards it rather than let the range be lopsided.
 */
function denormalize(value: number, componentType: number): number {
  switch (componentType) {
    case 5121:
      return value / 255;
    case 5120:
      return Math.max(value / 127, -1);
    case 5123:
      return value / 65535;
    case 5122:
      return Math.max(value / 32767, -1);
    // FLOAT and UNSIGNED_INT are never normalized; the spec forbids the pairing.
    default:
      return value;
  }
}

/** Read `count` elements out of a bufferView, honouring the interleaving it declares. */
function readView(
  gltf: Gltf,
  bin: Uint8Array,
  viewIndex: number,
  byteOffset: number,
  componentType: number,
  components: number,
  count: number,
): Float32Array {
  const view = gltf.bufferViews?.[viewIndex];
  if (!view) throw new Error(`bufferView ${viewIndex} is missing`);
  const size = COMPONENT_BYTES[componentType];
  if (!size) throw new Error(`unsupported component type ${componentType}`);
  // Attributes are commonly interleaved, so the step between elements is the view's stride when
  // it declares one and a tight packing when it does not. A sparse accessor's index and value
  // views never declare one (the spec forbids it), so the same code serves both.
  const stride = view.byteStride || size * components;
  const start = (view.byteOffset ?? 0) + byteOffset;
  const data = new DataView(bin.buffer, bin.byteOffset + start, bin.byteLength - start);

  const out = new Float32Array(count * components);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < components; c++) {
      out[i * components + c] = readComponent(data, i * stride + c * size, componentType);
    }
  }
  return out;
}

/**
 * Read one accessor into a flat array: its base data, its sparse overrides, dequantized.
 *
 * The three steps are in that order for a reason. A sparse accessor's values carry the accessor's
 * OWN component type, so they have to land in the array before anything is scaled; normalizing
 * first would scale the base and leave the overrides raw, which is a mesh that is right except
 * where it was patched.
 */
function readAccessor(gltf: Gltf, bin: Uint8Array, index: number): Float32Array {
  const accessor = gltf.accessors?.[index];
  if (!accessor) throw new Error(`accessor ${index} is missing`);
  const components = TYPE_COMPONENTS[accessor.type];
  if (!components || !COMPONENT_BYTES[accessor.componentType]) {
    throw new Error(`unsupported accessor type ${accessor.type}/${accessor.componentType}`);
  }

  // No bufferView is spec-legal and means an all-zero base, which is only useful with the sparse
  // overrides below: it is how a file stores a handful of displaced vertices without the array
  // they are displaced from.
  const out =
    accessor.bufferView === undefined
      ? new Float32Array(accessor.count * components)
      : readView(
          gltf,
          bin,
          accessor.bufferView,
          accessor.byteOffset ?? 0,
          accessor.componentType,
          components,
          accessor.count,
        );

  const sparse = accessor.sparse;
  if (sparse) {
    const at = readView(
      gltf,
      bin,
      sparse.indices.bufferView,
      sparse.indices.byteOffset ?? 0,
      sparse.indices.componentType ?? 5125,
      1,
      sparse.count,
    );
    const values = readView(
      gltf,
      bin,
      sparse.values.bufferView,
      sparse.values.byteOffset ?? 0,
      accessor.componentType,
      components,
      sparse.count,
    );
    for (let i = 0; i < sparse.count; i++) {
      const target = at[i] * components;
      // A bad index would write off the end of a Float32Array silently (it just drops the store),
      // so the mesh would be quietly missing an override. Say so instead.
      if (target < 0 || target + components > out.length) {
        throw new Error(`sparse index ${at[i]} is outside accessor ${index}`);
      }
      for (let c = 0; c < components; c++) out[target + c] = values[i * components + c];
    }
  }

  if (accessor.normalized) {
    for (let i = 0; i < out.length; i++) out[i] = denormalize(out[i], accessor.componentType);
  }
  return out;
}

/** A node's local transform, from either form glTF allows. */
function nodeMatrix(node: GltfNode): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  // `matrix` is column-major, which is what Matrix4.fromArray reads, so no transpose.
  if (node.matrix?.length === 16) return matrix.fromArray(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return matrix.compose(
    new THREE.Vector3(t[0], t[1], t[2]),
    new THREE.Quaternion(r[0], r[1], r[2], r[3]),
    new THREE.Vector3(s[0], s[1], s[2]),
  );
}

interface Batch {
  positions: number[];
  normals: number[];
  indices: number[];
  /** False as soon as one primitive arrives without a NORMAL; see {@link parseGlb}. */
  authoredNormals: boolean;
}

function addPrimitive(
  gltf: Gltf,
  bin: Uint8Array,
  primitive: GltfPrimitive,
  world: THREE.Matrix4,
  batch: Batch,
): void {
  if ((primitive.mode ?? TRIANGLES) !== TRIANGLES) return;
  const positionIndex = primitive.attributes?.POSITION;
  if (positionIndex === undefined) return;

  const positions = readAccessor(gltf, bin, positionIndex);
  const count = positions.length / 3;
  const base = batch.positions.length / 3;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(world);
  const vector = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    vector.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(world);
    batch.positions.push(vector.x, vector.y, vector.z);
  }

  const normalIndex = primitive.attributes?.NORMAL;
  if (normalIndex === undefined) batch.authoredNormals = false;
  else {
    const normals = readAccessor(gltf, bin, normalIndex);
    for (let i = 0; i < count; i++) {
      vector
        .set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2])
        .applyMatrix3(normalMatrix)
        .normalize();
      batch.normals.push(vector.x, vector.y, vector.z);
    }
  }

  if (primitive.indices === undefined) {
    for (let i = 0; i < count; i++) batch.indices.push(base + i);
    return;
  }
  const indices = readAccessor(gltf, bin, primitive.indices);
  for (let i = 0; i < indices.length; i++) batch.indices.push(base + indices[i]);
}

/** Walk a node and its children, composing transforms on the way down. */
function walkNode(
  gltf: Gltf,
  bin: Uint8Array,
  index: number,
  parent: THREE.Matrix4,
  batch: Batch,
  seen: Set<number>,
): void {
  const node = gltf.nodes?.[index];
  // A malformed file can point a child back at an ancestor; without this the walk never ends.
  if (!node || seen.has(index)) return;
  seen.add(index);
  const world = new THREE.Matrix4().multiplyMatrices(parent, nodeMatrix(node));
  if (node.mesh !== undefined) {
    for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
      addPrimitive(gltf, bin, primitive, world, batch);
    }
  }
  for (const child of node.children ?? []) walkNode(gltf, bin, child, world, batch, seen);
  seen.delete(index);
}

/**
 * Read a `.glb` into one geometry: positions, normals and indices, in the file's own units.
 *
 * Throws with a reason rather than returning empty geometry. A file that arrives here is one
 * someone deliberately picked, and "no triangles in scene 0" is actionable where a silently
 * blank shape is not. {@link buildShape} never calls this directly for exactly that reason; it
 * reads the cache, which holds only meshes that already parsed.
 */
export function parseGlb(data: ArrayBuffer | Uint8Array): THREE.BufferGeometry {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 12) throw new Error("not a .glb: too short for a header");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== MAGIC) {
    throw new Error("not a .glb: bad magic (a .gltf and its .bin cannot be read, export as .glb)");
  }
  const version = header.getUint32(4, true);
  if (version !== 2) throw new Error(`glTF ${version} is not supported, only 2.0`);

  let json: Gltf | undefined;
  let bin: Uint8Array | undefined;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const length = header.getUint32(at, true);
    const type = header.getUint32(at + 4, true);
    const start = at + 8;
    if (start + length > bytes.byteLength) break;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length))) as Gltf;
    } else if (type === CHUNK_BIN) {
      bin = bytes.subarray(start, start + length);
    }
    // Chunks are 4-byte aligned; the padding is inside the declared length, but round anyway so
    // a writer that padded outside it does not throw the walk off by a byte or three.
    at = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error("not a .glb: no JSON chunk");

  const required = (json.extensionsRequired ?? []).filter((name) =>
    GEOMETRY_EXTENSIONS.includes(name),
  );
  if (required.length > 0) {
    throw new Error(`compressed geometry (${required.join(", ")}); re-export without compression`);
  }
  if (json.buffers?.some((buffer) => buffer.uri !== undefined)) {
    throw new Error("external buffers are not supported, export a self-contained .glb");
  }

  const batch: Batch = { positions: [], normals: [], indices: [], authoredNormals: true };
  const buffer = bin ?? new Uint8Array(0);
  // A file with no `scenes` is legal and means "no default scene"; every node in it is a root,
  // which is the reading that shows a designer their geometry rather than nothing.
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? json.nodes?.map((_, i) => i) ?? [];
  const identity = new THREE.Matrix4();
  for (const root of roots) walkNode(json, buffer, root, identity, batch, new Set());

  const triangles = batch.indices.length / 3;
  if (triangles === 0) throw new Error("no triangles in the scene");
  if (triangles > MAX_MESH_TRIANGLES) {
    throw new Error(
      `${Math.round(triangles / 1000)}k triangles, over the ${MAX_MESH_TRIANGLES / 1000}k limit; decimate it first`,
    );
  }

  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(batch.positions);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const vertices = positions.length / 3;
  geometry.setIndex(
    vertices > 65535
      ? new THREE.BufferAttribute(new Uint32Array(batch.indices), 1)
      : new THREE.BufferAttribute(new Uint16Array(batch.indices), 1),
  );
  // Authored normals win when every primitive brought one, because they carry the exporter's
  // split-vertex decisions and those ARE the hard edges: a bevelled solid reads as faceted glass
  // only if its corners stay sharp. Recomputing is not a bad fallback either, for the same
  // reason, an exporter has already split the vertices at every hard edge, so averaging across
  // what remains reproduces the same creases. It is the fallback only because a file can carry
  // custom normals that no amount of averaging recovers.
  if (batch.authoredNormals && batch.normals.length === positions.length) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(batch.normals), 3));
  } else {
    geometry.computeVertexNormals();
  }
  return geometry;
}

/** Centre a parsed mesh on its bounding box and scale it to a unit half-extent. See {@link MeshEntry}. */
export function fitMesh(geometry: THREE.BufferGeometry): MeshEntry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  // A flat mesh has no extent on one axis; the floor keeps the scale finite so the caller gets a
  // degenerate mesh rather than a NaN one, the same guard `fitOutline` carries.
  const scale = 2 / Math.max(size.x, size.y, size.z, 1e-6);
  geometry.translate(-centre.x, -centre.y, -centre.z);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingSphere();
  const index = geometry.getIndex();
  return {
    geometry,
    chord: (Math.min(size.x, size.y, size.z) * scale) / 2,
    triangles: (index ? index.count : geometry.getAttribute("position").count) / 3,
  };
}

/** Parsed meshes by URL. Module-level, so several items naming one file share a single copy. */
const cache = new Map<string, MeshEntry>();
/** In-flight loads by URL, so a scene of twenty items fetches each distinct file exactly once. */
const inFlight = new Map<string, Promise<MeshEntry>>();

/** The parsed mesh for `url`, if it has already loaded. Synchronous, for {@link buildShape}. */
export function cachedMesh(url: string): MeshEntry | undefined {
  return cache.get(url);
}

/**
 * Fetch and parse a `.glb`, or hand back the copy already parsed.
 *
 * Rejects with the parser's own message, which is written to be shown to whoever picked the file.
 * A failed URL is NOT cached as a failure: a mesh served from a dev server that had not started
 * yet should load on the next rebuild rather than stay broken for the life of the page.
 */
export async function loadMesh(url: string): Promise<MeshEntry> {
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = inFlight.get(url);
  if (pending) return pending;

  const load = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not fetch the mesh (HTTP ${response.status})`);
    const entry = fitMesh(parseGlb(await response.arrayBuffer()));
    cache.set(url, entry);
    return entry;
  })().finally(() => inFlight.delete(url));

  inFlight.set(url, load);
  return load;
}

/** Every distinct model URL a config names, across its items and its scatter template. */
export function meshUrls(config: {
  items?: readonly { shape?: { kind?: string; model?: string } }[];
  scatter?: { shape?: { kind?: string; model?: string } };
}): string[] {
  const urls = new Set<string>();
  const add = (shape?: { kind?: string; model?: string }): void => {
    if (shape?.kind === "model" && shape.model) urls.add(shape.model);
  };
  for (const item of config.items ?? []) add(item.shape);
  add(config.scatter?.shape);
  return [...urls];
}

/**
 * Load every model a config names, before anything tries to draw it.
 *
 * The renderer recovers on its own when a mesh is missing, it draws the placeholder and rebuilds
 * when the file lands, so this is not required for correctness. It is what keeps a hero from
 * showing a sphere for a frame or two on the way to showing the shape someone actually authored.
 *
 * Never rejects. A mesh that will not load is the renderer's problem to fall back on, and one
 * bad URL among ten must not stop the other nine from being ready.
 */
export async function preloadMeshes(config: Parameters<typeof meshUrls>[0]): Promise<void> {
  await Promise.all(meshUrls(config).map((url) => loadMesh(url).catch(() => undefined)));
}

/**
 * Fetch every `.glb` an item list names and has not got yet. Resolves true if one arrived, which
 * is the caller's cue to rebuild.
 *
 * The asynchronous half of the `model` kind, shared by both engines. `buildShape` is synchronous
 * and answers "not yet" with a placeholder sphere; this is what turns that answer into the real
 * shape. Nothing upstream has to know: a consumer can hand `setConfig` a scene full of models
 * and it resolves itself, one extra rebuild later.
 *
 * ONE ATTEMPT PER URL, which is why `attempted` is the caller's to own and outlive this call.
 * A failed load is deliberately not cached as a failure by {@link loadMesh}, so the retry
 * decision lands here, and retrying on every rebuild would turn one unreachable file into a
 * fetch per keystroke in an editor.
 */
export async function loadModels(
  items: readonly { shape: { kind: string; model?: string } }[],
  attempted: Set<string>,
): Promise<boolean> {
  const wanted = new Set<string>();
  for (const item of items) {
    const url = item.shape.model;
    if (item.shape.kind !== "model" || !url) continue;
    if (cache.has(url) || attempted.has(url)) continue;
    wanted.add(url);
  }
  if (wanted.size === 0) return false;
  for (const url of wanted) attempted.add(url);

  const results = await Promise.all(
    [...wanted].map((url) =>
      loadMesh(url).then(
        () => true,
        (error: unknown) => {
          // Logged rather than thrown: one bad URL among six must not take the scene down. The
          // studio surfaces its own message on the picker, so this is for the consumer who typed
          // a path into a config and is wondering why they got a sphere.
          console.warn(`[materials3d] ${url}: ${(error as Error).message}`);
          return false;
        },
      ),
    ),
  );
  return results.includes(true);
}
