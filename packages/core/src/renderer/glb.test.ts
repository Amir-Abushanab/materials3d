import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createShape } from "../config/model";
import { fitMesh, MAX_MESH_TRIANGLES, parseGlb } from "./glb";
import { defaultPath, disc, rod, slab, sphere } from "./shapes";

/** Wrap a glTF document and its binary chunk as a GLB, padding both chunks as the spec requires. */
function glb(json: unknown, bin?: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const binChunk = bin ? 8 + bin.length + binPad : 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + binChunk;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  // Spaces, per the spec: the JSON chunk pads with 0x20 so it stays parseable as text.
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  if (bin) {
    const at = 20 + jsonBytes.length + jsonPad;
    view.setUint32(at, bin.length + binPad, true);
    view.setUint32(at + 4, 0x004e4942, true);
    out.set(bin, at + 8);
  }
  return out;
}

function bytes(floats: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(floats).buffer);
}

/** One triangle at the origin, as the smallest complete glTF document. */
function triangle(extra: Record<string, unknown> = {}): Uint8Array {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  return glb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
      ...extra,
    },
    bytes(positions),
  );
}

/**
 * A triangle whose POSITION accessor carries sparse overrides.
 *
 * `base` false drops the accessor's own bufferView, the all-zero form: it is how a file stores a
 * few displaced vertices without shipping the array they are displaced from.
 */
function sparseTriangle(
  data: Uint8Array,
  { base = true, count = 1, componentType = 5126, normalized = false } = {},
): Uint8Array {
  const size = componentType === 5126 ? 4 : 2;
  const positions = 9 * size;
  const indices = 4 * count;
  return glb(
    {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          ...(base ? { bufferView: 0 } : {}),
          componentType,
          count: 3,
          type: "VEC3",
          ...(normalized ? { normalized: true } : {}),
          sparse: {
            count,
            indices: { bufferView: 1, componentType: 5125 },
            values: { bufferView: 2 },
          },
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions },
        { buffer: 0, byteOffset: positions, byteLength: indices },
        { buffer: 0, byteOffset: positions + indices, byteLength: 3 * size * count },
      ],
      buffers: [{ byteLength: data.length }],
    },
    data,
  );
}

function positionsOf(geometry: THREE.BufferGeometry): number[] {
  return [...(geometry.getAttribute("position").array as Float32Array)];
}

describe("parseGlb", () => {
  it("reads positions and generates indices for a non-indexed primitive", () => {
    const geometry = parseGlb(triangle());
    expect(positionsOf(geometry)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect([...(geometry.getIndex()?.array ?? [])]).toEqual([0, 1, 2]);
  });

  it("bakes node transforms into world space", () => {
    // The whole reason this reader walks the node tree rather than the mesh list: a designer's
    // file is a hierarchy, and reading meshes directly piles every part on the origin.
    const geometry = parseGlb(
      triangle({ nodes: [{ mesh: 0, translation: [5, 2, 0], scale: [2, 2, 2] }] }),
    );
    expect(positionsOf(geometry)).toEqual([5, 2, 0, 7, 2, 0, 5, 4, 0]);
  });

  it("composes transforms down a node chain", () => {
    const geometry = parseGlb(
      triangle({
        scenes: [{ nodes: [0] }],
        nodes: [
          { children: [1], translation: [10, 0, 0] },
          { mesh: 0, translation: [0, 3, 0] },
        ],
      }),
    );
    expect(positionsOf(geometry).slice(0, 3)).toEqual([10, 3, 0]);
  });

  it("survives a node tree that points back at itself", () => {
    const geometry = parseGlb(
      triangle({ scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, children: [0] }] }),
    );
    expect(geometry.getAttribute("position").count).toBe(3);
  });

  it("reads interleaved attributes through the bufferView stride", () => {
    // Position and a colour packed together, 24 bytes apart, which is what a real exporter emits
    // and what a reader that assumes tight packing gets silently wrong.
    const data = bytes([0, 0, 0, 9, 9, 9, 1, 0, 0, 9, 9, 9, 0, 1, 0, 9, 9, 9]);
    const geometry = parseGlb(
      glb(
        {
          asset: { version: "2.0" },
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
          accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 72, byteStride: 24 }],
          buffers: [{ byteLength: 72 }],
        },
        data,
      ),
    );
    expect(positionsOf(geometry)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("reads short indices", () => {
    const positions = bytes([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint8Array(new Uint16Array([2, 1, 0]).buffer);
    const data = new Uint8Array(positions.length + indices.length);
    data.set(positions);
    data.set(indices, positions.length);
    const geometry = parseGlb(
      glb(
        {
          asset: { version: "2.0" },
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
          accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
            { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
          ],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 36 },
            { buffer: 0, byteOffset: 36, byteLength: 6 },
          ],
          buffers: [{ byteLength: 42 }],
        },
        data,
      ),
    );
    expect([...(geometry.getIndex()?.array ?? [])]).toEqual([2, 1, 0]);
  });

  it("merges several primitives, offsetting each one's indices", () => {
    const geometry = parseGlb(
      triangle({
        meshes: [
          {
            primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 } }],
          },
        ],
      }),
    );
    expect(geometry.getAttribute("position").count).toBe(6);
    expect([...(geometry.getIndex()?.array ?? [])]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps authored normals rather than averaging them away", () => {
    const positions = bytes([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = bytes([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const data = new Uint8Array(72);
    data.set(positions);
    data.set(normals, 36);
    const geometry = parseGlb(
      glb(
        {
          asset: { version: "2.0" },
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0, rotation: [1, 0, 0, 0] }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
          accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
            { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
          ],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 36 },
            { buffer: 0, byteOffset: 36, byteLength: 36 },
          ],
          buffers: [{ byteLength: 72 }],
        },
        data,
      ),
    );
    // A half-turn about X, so +Z becomes -Z: normals are transformed with the node, not copied.
    const normal = geometry.getAttribute("normal");
    expect(normal.getZ(0)).toBeCloseTo(-1, 5);
  });

  it("computes normals when a primitive brought none", () => {
    const geometry = parseGlb(triangle());
    const normal = geometry.getAttribute("normal");
    expect(normal.count).toBe(3);
    expect(Math.abs(normal.getZ(0))).toBeCloseTo(1, 5);
  });

  it("skips primitives that are not triangles", () => {
    // Mode 1 is LINES. A line has no surface to refract, and reading it as triangles would draw
    // slivers rather than nothing.
    expect(() =>
      parseGlb(triangle({ meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 1 }] }] })),
    ).toThrow(/no triangles/);
  });

  it("patches a sparse accessor over its base", () => {
    // Vertex 1 is displaced; the other two come from the base array untouched.
    const data = new Uint8Array(52);
    data.set(bytes([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    data.set(new Uint8Array(new Uint32Array([1]).buffer), 36);
    data.set(bytes([7, 8, 9]), 40);
    expect(positionsOf(parseGlb(sparseTriangle(data)))).toEqual([0, 0, 0, 7, 8, 9, 0, 1, 0]);
  });

  it("reads a sparse accessor that has no base at all", () => {
    const data = new Uint8Array(52);
    data.set(new Uint8Array(new Uint32Array([2]).buffer), 36);
    data.set(bytes([4, 5, 6]), 40);
    // The zeroes are the spec-legal empty base, not a failed read.
    expect(positionsOf(parseGlb(sparseTriangle(data, { base: false })))).toEqual([
      0, 0, 0, 0, 0, 0, 4, 5, 6,
    ]);
  });

  it("dequantizes normalized positions instead of reading them as raw integers", () => {
    // A short spanning the type's full range means 1.0, not 32767. Reading the flag wrong scales
    // the whole mesh by four orders of magnitude, which is why the flag cannot just be ignored.
    const quantized = new Int16Array([0, 0, 0, 32767, 0, 0, 0, -32767, 0]);
    const geometry = parseGlb(
      glb(
        {
          asset: { version: "2.0" },
          extensionsRequired: ["KHR_mesh_quantization"],
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
          accessors: [
            { bufferView: 0, componentType: 5122, count: 3, type: "VEC3", normalized: true },
          ],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 18 }],
          buffers: [{ byteLength: 18 }],
        },
        new Uint8Array(quantized.buffer),
      ),
    );
    const p = positionsOf(geometry);
    expect(p[3]).toBeCloseTo(1, 5);
    expect(p[7]).toBeCloseTo(-1, 5);
  });

  it("dequantizes after applying sparse overrides, not before", () => {
    // Both halves are quantized shorts. If the base were scaled before the patch landed, the
    // override would stay raw and vertex 0 would read 32767 instead of 1.
    const data = new Uint8Array(18 + 4 + 6);
    data.set(new Uint8Array(new Int16Array([0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer));
    data.set(new Uint8Array(new Uint32Array([0]).buffer), 18);
    data.set(new Uint8Array(new Int16Array([32767, 0, 32767]).buffer), 22);
    const p = positionsOf(
      parseGlb(sparseTriangle(data, { componentType: 5122, normalized: true })),
    );
    expect(p[0]).toBeCloseTo(1, 5);
    expect(p[2]).toBeCloseTo(1, 5);
  });

  it("reads every node when the file names no scene", () => {
    const geometry = parseGlb(triangle({ scene: undefined, scenes: undefined }));
    expect(geometry.getAttribute("position").count).toBe(3);
  });
});

describe("parseGlb refusals", () => {
  it("rejects a file that is not a glb", () => {
    expect(() => parseGlb(new TextEncoder().encode("<svg></svg>...."))).toThrow(/not a \.glb/);
  });

  it("names .glb in the magic error, since a .gltf is the likely mistake", () => {
    expect(() => parseGlb(new TextEncoder().encode('{"asset":{"version":"2.0"}}'))).toThrow(
      /export as \.glb/,
    );
  });

  it("rejects glTF 1.0", () => {
    const bad = triangle();
    new DataView(bad.buffer).setUint32(4, 1, true);
    expect(() => parseGlb(bad)).toThrow(/only 2\.0/);
  });

  it("refuses compressed geometry by name rather than reading noise", () => {
    expect(() =>
      parseGlb(triangle({ extensionsRequired: ["KHR_draco_mesh_compression"] })),
    ).toThrow(/KHR_draco_mesh_compression/);
  });

  it("ignores required extensions that only affect appearance", () => {
    // Materials are replaced wholesale here, so requiring one is not a reason to refuse a file.
    expect(() => parseGlb(triangle({ extensionsRequired: ["KHR_materials_unlit"] }))).not.toThrow();
  });

  it("refuses a file whose buffers live beside it", () => {
    expect(() => parseGlb(triangle({ buffers: [{ uri: "scene.bin", byteLength: 36 }] }))).toThrow(
      /self-contained/,
    );
  });

  it("refuses a mesh too heavy for a four-pass renderer", () => {
    // One triangle's worth of vertices, indexed over and over: the cap counts triangles, which is
    // what costs a frame here, not vertices.
    const count = (MAX_MESH_TRIANGLES + 1) * 3;
    const positions = bytes([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array(count);
    for (let i = 0; i < count; i++) indices[i] = i % 3;
    const indexBytes = new Uint8Array(indices.buffer);
    const data = new Uint8Array(positions.length + indexBytes.length);
    data.set(positions);
    data.set(indexBytes, positions.length);

    expect(() =>
      parseGlb(
        glb(
          {
            asset: { version: "2.0" },
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
            accessors: [
              { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
              { bufferView: 1, componentType: 5123, count, type: "SCALAR" },
            ],
            bufferViews: [
              { buffer: 0, byteOffset: 0, byteLength: 36 },
              { buffer: 0, byteOffset: 36, byteLength: indexBytes.length },
            ],
            buffers: [{ byteLength: data.length }],
          },
          data,
        ),
      ),
    ).toThrow(/decimate/);
  });
});

/** What `r` a `model` shape needs to render the same size as the primitive it was built from. */
function fitRadius(geometry: THREE.BufferGeometry): number {
  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  (geometry.boundingBox as THREE.Box3).getSize(size);
  return Math.max(size.x, size.y, size.z) / 2;
}

describe("fitMesh", () => {
  it("centres the mesh and scales its longest axis to a unit half-extent", () => {
    // Off-centre and lopsided on purpose: the fit has to move it as well as resize it.
    const geometry = parseGlb(
      triangle({ nodes: [{ mesh: 0, translation: [100, 0, 0], scale: [8, 2, 1] }] }),
    );
    const box = fitMesh(geometry).geometry.boundingBox as THREE.Box3;
    expect(box.max.x).toBeCloseTo(1, 5);
    expect(box.min.x).toBeCloseTo(-1, 5);
    expect((box.max.y + box.min.y) / 2).toBeCloseTo(0, 5);
  });

  it("counts its triangles", () => {
    expect(fitMesh(parseGlb(triangle())).triangles).toBe(1);
  });
});

describe("the measured chord", () => {
  /**
   * The claim in `MeshEntry.chord`, checked against the hand-written table it has to agree with.
   *
   * `defaultPath` is a constant per kind because a primitive's optical path can be reasoned
   * about; a `.glb` has no entry there and gets a measurement instead. If the measurement did not
   * reproduce the reasoning on the shapes where both exist, it would be measuring the wrong thing,
   * and glass built from a model would absorb like plastic without anything saying so.
   */
  it.each([
    ["rod", rod({ r: 0.5, len: 8 }), { ...createShape("rod"), r: 0.5, len: 8 }],
    ["disc", disc({ r: 0.8, thickness: 0.4 }), { ...createShape("disc"), r: 0.8, thickness: 0.4 }],
    ["sphere", sphere({ r: 0.78 }), { ...createShape("sphere"), r: 0.78 }],
    [
      "slab",
      slab({ w: 1.5, h: 1.5, depth: 0.4 }),
      { ...createShape("slab"), len: 1.5, thickness: 1.5, depth: 0.4 },
    ],
  ])("reproduces defaultPath for a %s", (_name, geometry, config) => {
    const r = fitRadius(geometry);
    expect(fitMesh(geometry).chord * r).toBeCloseTo(defaultPath(config), 3);
  });

  it("falls back to the sphere answer while a model has not loaded", () => {
    // The placeholder IS a sphere, so this is not a guess standing in for the real number, it is
    // the right number for what is actually on screen.
    const shape = { ...createShape("model"), r: 1.4, model: "/never-loaded.glb" };
    expect(defaultPath(shape)).toBe(1.4);
  });
});
