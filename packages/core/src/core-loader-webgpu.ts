/**
 * The WebGPU/TSL engine, fetched only when a consumer asks for it.
 *
 * A sibling of `core-loader` rather than a branch inside it, because the split has to survive
 * bundling: the two engines are separate three builds sharing only `three.core`, and a bundler can
 * only code-split on a literal import specifier. Keeping them in different modules is what lets a
 * default consumer ship the WebGL engine alone, see `MaterialOptions.renderer`.
 */
import { NodeMaterialRenderer } from "./renderer/NodeMaterialRenderer";
import type { MaterialRenderer as WebGLRenderer } from "./renderer/MaterialRenderer";

/**
 * The nominal bridge between the two engines, and the reason it is a cast rather than a bug.
 *
 * The shell types its engine as the WebGL renderer, because `onReady` hands that object to
 * consumers. The two classes are nominally unrelated, they share no base class, so TypeScript
 * cannot see that one can stand in for the other, however identical their surfaces are.
 *
 * What makes this safe rather than merely asserted: both classes declare `implements Engine`, and
 * `Engine` names the whole surface, playback, capture, sizing, picking, projection, item
 * management and the interaction inputs. The compiler checks each engine against it, so a method
 * that goes missing from either fails the build here rather than at some consumer's call site.
 *
 * The cast disappears the day the shell types `onReady` against `Engine` instead of against the
 * WebGL class. That is a public API change, which is why it has not been made lightly.
 */
export const MaterialRenderer = NodeMaterialRenderer as unknown as typeof WebGLRenderer;
export { createDefaultConfig } from "./config/model";
