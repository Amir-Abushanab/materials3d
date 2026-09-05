/**
 * `pnpm make:glb`: write a `.glb` to test the `model` shape kind against.
 *
 * Testing this feature by hand needs a file, and the interesting files are the ones no exporter
 * hands you on request. Blender will not emit a sparse accessor because you asked nicely, and
 * quantization is a checkbox some pipelines have and others do not, so the two encodings this
 * reader gained most recently are exactly the two hardest to obtain. This writes them.
 *
 * The shape is a torus knot, the argument for the `model` kind in one object: it passes through
 * itself, it has a hole, and no primitive in `shapes.ts` and no extruded outline can produce
 * either. If it renders, the reader did its job.
 *
 *   pnpm make:glb                          → renders/test.glb, plain float positions
 *   pnpm make:glb --encode quantized       → normalized shorts plus the node scale that undoes them
 *   pnpm make:glb --sparse --out odd.glb   → one vertex displaced through a sparse override
 *   pnpm make:glb --tubes 200 --sides 24   → denser, for pushing at the triangle cap
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, run } from "./lib/cli.mjs";
import { CORE, RENDERS } from "./lib/paths.mjs";

const USAGE = `usage: pnpm make:glb [options]

  --out <file>          output path (default renders/test.glb)
  --encode <kind>       float (default) or quantized
  --sparse              displace one vertex through a sparse accessor override
  --tubes <n>           segments along the knot (default 128)
  --sides <n>           segments around the tube (default 20)
  --help`;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** three, resolved from packages/core so this writes what that package is built against. The
 *  specifier is kept out of the call because knip reads a literal there as a root dependency. */
async function three() {
  const requireFromCore = createRequire(resolve(CORE, "package.json"));
  const entry = requireFromCore.resolve(THREE);
  // Prefer the ESM build beside the resolved entry; the CJS one has no named exports under import.
  return import(pathToFileURL(resolve(dirname(entry), "three.module.js")).href);
}
const THREE = "three";

/** Wrap a glTF document and its buffer as a GLB, padding both chunks as the spec requires. */
function pack(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;

  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonBytes.copy(out, 20);
  // Spaces, per the spec: the JSON chunk pads with 0x20 so it stays parseable as text.
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const at = 20 + jsonBytes.length + jsonPad;
  out.writeUInt32LE(bin.length + binPad, at);
  out.writeUInt32LE(CHUNK_BIN, at + 4);
  bin.copy(out, at + 8);
  return out;
}

await run(async () => {
  const args = parseArgs(process.argv.slice(2), {
    out: "",
    encode: "float",
    sparse: false,
    tubes: 128,
    sides: 20,
  });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  // Short flags are not a thing in the shared parser, so `-o file` would land here as two
  // positionals and the file would go quietly to the default path. Say so instead.
  if (args.positionals.length > 0) {
    throw new Error(`unexpected argument "${args.positionals[0]}" (--help for usage)`);
  }
  if (args.encode !== "float" && args.encode !== "quantized") {
    throw new Error(`--encode must be float or quantized, got "${args.encode}"`);
  }

  const THREEJS = await three();
  const geometry = new THREEJS.TorusKnotGeometry(1, 0.34, args.tubes, args.sides);
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  const positions = Float32Array.from(position.array);
  const count = position.count;
  const quantized = args.encode === "quantized";

  // Positions, in the file's own encoding. Quantized means normalized shorts spanning the type's
  // full range, with the scale that restores world units hung on the node, which is where a real
  // exporter puts it and what the reader's `denormalize` undoes.
  let scale = 1;
  let positionBytes;
  if (quantized) {
    for (const v of positions) scale = Math.max(scale, Math.abs(v));
    const shorts = new Int16Array(positions.length);
    for (let i = 0; i < positions.length; i++)
      shorts[i] = Math.round((positions[i] / scale) * 32767);
    positionBytes = Buffer.from(shorts.buffer);
  } else {
    positionBytes = Buffer.from(positions.buffer);
  }

  // Shorts whenever the vertices fit, which for anything this writes they do. Indices outweigh
  // positions on a tube (each vertex is shared by six triangles), so the width of this array is
  // most of the file size.
  const shortIndex = count <= 65535;
  const indexBytes = Buffer.from((shortIndex ? Uint16Array : Uint32Array).from(index.array).buffer);
  const chunks = [positionBytes, indexBytes];
  const views = [
    { buffer: 0, byteOffset: 0, byteLength: positionBytes.length },
    { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length },
  ];
  const accessors = [
    {
      bufferView: 0,
      componentType: quantized ? 5122 : 5126,
      ...(quantized ? { normalized: true } : {}),
      count,
      type: "VEC3",
    },
    { bufferView: 1, componentType: shortIndex ? 5123 : 5125, count: index.count, type: "SCALAR" },
  ];

  if (args.sparse) {
    // One vertex pulled well off the surface, so the override is visible rather than a matter of
    // trusting the arithmetic: a spike on the knot means the patch landed.
    const target = Math.floor(count / 2);
    const spike = quantized ? Int16Array.from([32767, 32767, 0]) : Float32Array.from([2.6, 2.6, 0]);
    const at = chunks.reduce((sum, c) => sum + c.length, 0);
    const indicesBytes = Buffer.from(Uint32Array.from([target]).buffer);
    const valuesBytes = Buffer.from(spike.buffer);
    chunks.push(indicesBytes, valuesBytes);
    views.push(
      { buffer: 0, byteOffset: at, byteLength: indicesBytes.length },
      { buffer: 0, byteOffset: at + indicesBytes.length, byteLength: valuesBytes.length },
    );
    accessors[0].sparse = {
      count: 1,
      indices: { bufferView: views.length - 2, componentType: 5125 },
      values: { bufferView: views.length - 1 },
    };
  }

  const bin = Buffer.concat(chunks);
  const glb = pack(
    {
      asset: { version: "2.0", generator: "materials3d make:glb" },
      ...(quantized
        ? {
            extensionsUsed: ["KHR_mesh_quantization"],
            extensionsRequired: ["KHR_mesh_quantization"],
          }
        : {}),
      scene: 0,
      scenes: [{ nodes: [0] }],
      // A child under a translated parent, and turned, so the file exercises the node walk rather
      // than sitting a single mesh on the origin where a reader that ignores transforms looks
      // correct.
      nodes: [
        { children: [1], translation: [3, 0, 0] },
        {
          mesh: 0,
          rotation: [0.2588, 0, 0, 0.9659],
          scale: [scale, scale, scale],
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors,
      bufferViews: views,
      buffers: [{ byteLength: bin.length }],
    },
    bin,
  );

  const out = resolve(args.out || resolve(RENDERS, "test.glb"));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, glb);
  const notes = [args.encode, args.sparse ? "sparse" : null].filter(Boolean).join(" · ");
  console.log(
    `${out}  ${(glb.length / 1024).toFixed(0)} kB  ${index.count / 3} triangles  ${notes}`,
  );
});
