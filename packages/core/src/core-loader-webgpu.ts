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
 * What the assertion is hiding, concretely: `NodeMaterialRenderer` implements the surface the
 * shell itself uses — construction, `canvas`, `start`/`stop`, `dispose`, `refreshPlayback`,
 * `getConfig`/`setConfig`, `captureImage` — and not yet the rest of the imperative API (`add`,
 * `pick`, `projectBounds`, the interaction inputs). Reaching for one of those through `onReady` on
 * this engine is a runtime error, not a type error, until the port lands. The assertion goes away
 * by making the class complete, never by widening the shell.
 */
export const MaterialRenderer = NodeMaterialRenderer as unknown as typeof WebGLRenderer;
export { createDefaultConfig } from "./config/model";
