<a href="https://github.com/Amir-Abushanab/materials3d"><img src="https://raw.githubusercontent.com/Amir-Abushanab/materials3d/main/brand/icon-192.png" alt="" width="64" align="right"></a>

# @materials3d/core

The renderer behind [Materials3D](https://github.com/Amir-Abushanab/materials3d): scene-level
materials, glass through plastic, where the colour comes from bounded light sources behind the
shapes rather than from paint applied to them.

```bash
pnpm add @materials3d/core three
```

## The shell

`createMaterials` is the poster-first entry. It has no static three import: the engine arrives
through a dynamic import, so a bundler code-splits three out of the initial load and fetches it
only when a scene upgrades.

```ts
import { createMaterials } from "@materials3d/core";

const handle = createMaterials(
  document.getElementById("hero")!,
  { lampGain: 2 },
  { poster: "/hero.webp", lazy: true, minSizeForWebGL: 520 },
);

handle.pause();
const poster = await handle.snapshot({ time: 0 }); // a Blob of the frame the scene opens on
handle.destroy();
```

It stays on the poster on no WebGL, Save-Data, reduced motion (with
`reducedMotionBehavior: "poster"`), a container smaller than `minSizeForWebGL`, repeated context
loss, or a failed engine fetch. `onFallback(reason)` says which.

Options: `poster`, `posterFit` (`fill`, `cover`, `contain`), `lazy`, `rootMargin`, `webgl`
(`auto`, `force`, `off`), `respectReducedMotion`, `reducedMotionBehavior` (`static`, `poster`),
`respectSaveData`, `minSizeForWebGL`, `fadeMs`, `paused`, `renderer` (`webgl`, `webgpu`),
`onReady`, `onFallback`, `onStateChange`.

The handle: `state` (`poster`, `loading`, `running`, `fallback`), `renderer`,
`snapshot({ type, quality, time })`, `set(partial)`, `play()`, `pause()`, `destroy()`. `snapshot`
resolves `null` until the scene is running. `set` merges one level deep, so
`set({ post: { bloom: 0.2 } })` keeps the other post fields and `set({ camera: { fov: 20 } })`
keeps the rest of the camera. Arrays such as `lamps` and `items` are replaced whole, and so is
anything nested deeper than one level. Before the upgrade the merge is staged; after it, it is
applied to the live renderer.

## The engine

```ts
import { MaterialRenderer, shapes, motions } from "@materials3d/core/renderer";

const glass = new MaterialRenderer(container, { lamps: [...] });
glass.add(shapes.rod({ r: 0.4, len: 12 }), {
  position: [0, -4.6, 0],
  material: { path: 0.4, density: 3.4 },
});
glass.onFrame(motions.skewer({ rate: 0.34, stagger: 0.393 })).start();
```

Importing `/renderer` pulls in three. Use it when you already render with three, or in an
authoring tool. For a page, prefer `createMaterials`.

`add(geometry, options)` takes `position`, `rotation`, `scale`, `material`, `motion`, `phase` and
`data`; the `motions` callbacks are for rules that span the whole set. `seek(t)` renders one fixed
frame; `captureImage(mime, quality, time)` returns it as a Blob. The same config and the same
`time` always produce the same pixels. `setOutputSize({ width, height })` renders at an exact
pixel size, independent of the container. `pick`, `projectBounds` and `pointOnDragPlane` are the
editor primitives the studio uses.

## Entry points

| entry               | contents                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `.`                 | the shell and the config model. No three.                                                                      |
| `./renderer`        | `MaterialRenderer`, `shapes`, `motions`, `InteractionController`. Pulls in three.                              |
| `./renderer-webgpu` | `NodeMaterialRenderer`, the experimental WebGPU/TSL engine. A separate three build; see WEBGPU.md in the repo. |
| `./presets`         | `PRESETS` and `PRESET_NAMES`. Separate so naming one preset does not pull in the rest.                         |
| `./studio`          | thumbnail and mesh-gradient preview helpers for authoring tools. Pulls in three.                               |
| `./standalone`      | a single self-contained file with three bundled, for `<script type="module">` from a CDN.                      |

## Config

Plain JSON. The same object drives the renderer, the studio panel and every export.
`ensureSceneConfig` fills a partial config out to a complete one, clamps the scene-level values
that would produce a broken frame rather than an ugly one (an inverted lamp gate, a `quality`
outside 0.35-1, a beam `ior` below 1), and clamps the material values that are present (an IOR
below 1, a negative density, a `bend` outside 0-1). It is idempotent and survives a JSON round
trip, so it is safe to run on imported configs. `resolveMaterial` fills a partial material.

Scenes come from either `items` (authored by hand) or `scatter` (generated from a seed). Scatter
keeps a 16-rod scene a dozen lines of JSON.

## Colour

The whole pass chain is authored in display (sRGB) space and three's colour management is bypassed
for it. The look was calibrated in display space; moving Beer-Lambert and the depth-of-field and
bloom gathers into linear changes their character. Pass colours as hex strings. A
`new THREE.Color(hex)` handed to a Materials3D uniform is linear and reads washed out.

## Agent skill

The package ships a [TanStack Intent](https://github.com/TanStack/intent) skill in
`skills/materials3d/SKILL.md`. Run `npx @tanstack/intent@latest install` once in your project and
your coding agent loads it when it works with `@materials3d/*`.

## Peer dependencies

`three >= 0.180 < 1`. `@types/three >= 0.180` is an optional peer.

MIT.
