/**
 * The WebGPU/TSL engine, fetched only when a consumer asks for it.
 *
 * A sibling of `core-loader` rather than a branch inside it, because the split has to survive
 * bundling: the two engines are separate three builds sharing only `three.core`, and a bundler can
 * only code-split on a literal import specifier. Keeping them in different modules is what lets a
 * default consumer ship the WebGL engine alone — see `MaterialOptions.renderer`.
 */
import { NodeMaterialRenderer } from "./renderer/NodeMaterialRenderer";
import type { MaterialRenderer as WebGLRenderer } from "./renderer/MaterialRenderer";

/**
 * MIGRATION SEAM, and the one dishonest line in the engine split.
 *
 * The shell types its engine as the WebGL renderer because `onReady` hands that object to
 * consumers, and narrowing it to the surface both engines share would break every caller in order
 * to describe an engine that is not finished. So this asserts the node renderer into that shape.
 *
 * The assertion no longer hides a missing API: `NodeMaterialRenderer` now implements the whole
 * imperative surface — `add`/`remove`/`clear`, `pick`, `projectBounds`, `pointOnDragPlane`,
 * `viewDirection`, `getItems`, `setOutputSize`, `refresh`, `rebuild`, `resetCamera`, `onFrame`,
 * `captureStream` and the interaction inputs — against the same renderer-agnostic helpers the
 * WebGL engine uses. What remains is only that the two classes are nominally unrelated: they share
 * no base type, so TypeScript cannot see the match. Naming that shared type is what removes this
 * line; widening the shell is not.
 */
export const MaterialRenderer = NodeMaterialRenderer as unknown as typeof WebGLRenderer;
export { createDefaultConfig } from "./config/model";
