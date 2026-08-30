---
"@materials3d/core": minor
"@materials3d/react": minor
"@materials3d/element": minor
---

`onReady` now hands back the engine that was actually asked for.

`createMaterials` is generic over the `renderer` option, so `{ renderer: "webgpu" }` types its
callback as `NodeMaterialRenderer` and the default still types it as `MaterialRenderer`. The
default parameter means every existing call site is unchanged — nothing needs a type argument, and
nothing that compiled before stops compiling.

This was the last place the API said something untrue. The WebGPU loader really does construct a
`NodeMaterialRenderer`; typing it as the WebGL class was accurate about neither engine's members,
and the two are not interchangeable at that level even though their shared surface now is.

`EngineFor<R>` and `RendererKind` are exported, and a compile-time test asserts both branches
resolve exactly — if the conditional regresses, `pnpm typecheck` fails rather than a consumer
finding out.

**The React and web-component wrappers now forward `renderer` at all.** They did not, so
`<Materials3D>` and `<materials-3d>` were WebGL-only regardless of what a consumer asked for. React
is generic in the same way; the element reads a `renderer="webgpu"` attribute and, because that is
a runtime value, types its callback as the union of the two engines.

Naming the node renderer in a type position costs the default build nothing: `import type` is
erased, and the standalone bundle is byte-identical with zero references to `three/webgpu`.
