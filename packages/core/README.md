<a href="https://github.com/Amir-Abushanab/materials3d"><img src="https://raw.githubusercontent.com/Amir-Abushanab/materials3d/main/brand/icon-192.png" alt="" width="64" align="right"></a>

# @materials3d/core

The renderer behind [Materials3D](https://github.com/Amir-Abushanab/materials3d): scene-level refractive
glass, where the colour comes from bounded light sources _behind_ the glass rather than from tint
applied to it.

```bash
pnpm add @materials3d/core three
```

## The drop-in

`createMaterials` is the poster-first shell. It has **no static three import** — the engine arrives via
a dynamic import, so a bundler code-splits three out of your initial load and fetches it only when
a scene actually upgrades.

```ts
import { createMaterials } from "@materials3d/core";

const handle = createMaterials(
  document.querySelector("#hero"),
  { lampGain: 2 },
  {
    poster: "/hero.webp",
    lazy: true,
    minSizeForWebGL: 520,
  },
);

handle.pause();
const poster = await handle.snapshot({ time: 0 }); // Blob — reproducible, not "whatever was on screen"
handle.destroy();
```

It falls back to a permanent poster on no-WebGL, Save-Data, reduced motion, a viewport under
`minSizeForWebGL`, repeated context loss, or a failed engine fetch — `onFallback(reason)` tells you
which.

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

Importing `/renderer` pulls in three directly — use it when you are already rendering three anyway,
or in an authoring tool. For a page, prefer `createMaterials`.

`glass.seek(t)` renders one fixed frame; `glass.captureImage(mime, quality, time)` returns it as a
Blob. Same config plus same `time` always produces the same pixels, which is what makes posters
reproducible.

## Entry points

| entry          | contents                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| `.`            | the shell + the config model. No three.                                                   |
| `./renderer`   | `MaterialRenderer`, `shapes`, `motions`. Pulls in three.                                  |
| `./presets`    | `PRESETS` — kept separate so naming one preset doesn't pull in the rest.                  |
| `./standalone` | a single self-contained file with three bundled, for `<script type="module">` from a CDN. |

## Config

Plain JSON, and the same object drives the renderer, the studio panel and every export.
`ensureSceneConfig` fills a partial out to a complete one and clamps anything that would produce a
broken frame rather than an ugly one — an inverted lamp gate, an IOR below 1, a negative σ. It is
idempotent and survives a JSON round trip, so it is safe to run on imported configs.

Scenes come from either `items` (authored by hand) or `scatter` (generated deterministically from a
seed). Scatter keeps a 16-rod scene a dozen lines of JSON.

## Colour

The whole pass chain is authored in **display (sRGB) space**, and three's colour management is
deliberately bypassed for it — the look was calibrated in display space, and moving Beer–Lambert
and the DOF/bloom gathers into linear changes their character. Pass colours as hex strings. A
`new THREE.Color(hex)` handed to a Materials3D uniform is _linear_ and will read washed out.

## Peer dependencies

`three >= 0.180 < 1`. `@types/three` is an optional peer.

MIT.
