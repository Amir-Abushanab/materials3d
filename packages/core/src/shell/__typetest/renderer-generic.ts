/**
 * Type-level proof that `onReady` hands back the engine that was actually asked for.
 *
 * Nothing imports this, by design, it is listed in `knip.json`'s ignore for exactly that
 * reason. It is a compile-time test, so it has no runtime form and no test runner: if the conditional in
 * `EngineFor` regresses, `pnpm typecheck` fails here. That matters because the failure it guards
 * against is silent, the WebGPU path really does construct a `NodeMaterialRenderer`, and typing
 * it as the WebGL class was true of neither engine's members.
 */
import { createMaterials, type EngineFor } from "../createMaterials";
import type { MaterialRenderer } from "../../renderer/MaterialRenderer";
import type { NodeMaterialRenderer } from "../../renderer/NodeMaterialRenderer";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// The argument exists only so the call site reads as an assertion; nothing consumes it.
const assertExact = <T extends true>(_ok: T): void => void _ok;

assertExact<Exact<EngineFor<"webgl">, MaterialRenderer>>(true);
assertExact<Exact<EngineFor<"webgpu">, NodeMaterialRenderer>>(true);

// And through the public entry point, which is where a consumer meets it.
const el = null as unknown as HTMLElement;
createMaterials(el, {}, { onReady: (r) => assertExact<Exact<typeof r, MaterialRenderer>>(true) });
createMaterials(
  el,
  {},
  {
    renderer: "webgpu",
    onReady: (r) => assertExact<Exact<typeof r, NodeMaterialRenderer>>(true),
  },
);
