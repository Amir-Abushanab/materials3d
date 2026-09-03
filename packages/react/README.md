<a href="https://github.com/Amir-Abushanab/materials3d"><img src="https://raw.githubusercontent.com/Amir-Abushanab/materials3d/main/brand/icon-192.png" alt="" width="64" align="right"></a>

# @materials3d/react

The `<Materials3D>` component: a drop-in refractive-glass scene for React.

```bash
pnpm add @materials3d/react three
```

```tsx
import { Materials3D } from "@materials3d/react";

export function Hero() {
  return (
    <Materials3D
      preset="skewer"
      poster="/hero.webp"
      minSizeForWebGL={520}
      style={{ width: "100%", height: "100vh" }}
    />
  );
}
```

Renders a `<div>` and mounts the shell on the client: poster first, lazy, aware of WebGL, reduced
motion and Save-Data, with three code-split out of the initial bundle.

## Props

Precedence: the defaults, then `preset`, then the flat props, then `config`.

| prop                                                                                          | notes                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`                                                                                      | a name (`"skewer"`, `"assembly"`, `"staircase"`, `"slimes"`, `"reactions"`, `"materials"`, `"prism"`, `"orb"`) or a function returning a config. A name lazy-loads the presets chunk; a function is tree-shakeable. |
| `config`                                                                                      | a full or partial config, applied last                                                                                                                                                                              |
| `lamps`, `lampGain`, `background`, `transparentBackground`, `clearGlass`                      | the light field and the backdrop                                                                                                                                                                                    |
| `post`, `motion`, `scatter`                                                                   | merged onto what the preset authored, so `scatter={{ count: 24 }}` re-scatters the reference scene; `motion` applies to every shape                                                                                 |
| `orbit`, `quality`, `dprMax`, `paused`                                                        | live                                                                                                                                                                                                                |
| `poster`, `posterFit`, `lazy`, `webgl`, `minSizeForWebGL`, `respectReducedMotion`, `renderer` | shell options, read at mount only. Changing one on a mounted component does nothing until it remounts.                                                                                                              |
| `onReady(renderer)`, `onFallback(reason)`                                                     | callbacks; the latest ones are called without a remount                                                                                                                                                             |
| `className`, `style`, `children`                                                              | the `<div>`                                                                                                                                                                                                         |

Config-shaped props update the live scene through the handle. A changed shape list or scatter
rebuilds geometry; everything else pushes uniforms.

## The handle

A `ref` receives a `MaterialHandle`: `snapshot({ time })`, `set(partial)`, `play()`, `pause()`,
`destroy()`, `state` and `renderer`. The object is stable and delegates to whichever shell is live,
so it survives StrictMode's remount.

```tsx
import { useRef } from "react";
import { Materials3D, type MaterialHandle } from "@materials3d/react";

export function Hero() {
  const ref = useRef<MaterialHandle>(null);
  return (
    <>
      <Materials3D ref={ref} preset="orb" poster="/orb.webp" style={{ height: 480 }} />
      <button onClick={() => ref.current?.pause()}>Pause</button>
    </>
  );
}
```

Before the shell exists `state` reads `"poster"` and the calls are no-ops. `snapshot` resolves
`null` until the scene is running; wait for `onReady`.

## SSR

The component is SSR-safe. For a server-rendered poster with no hydration flash, pass the image as
a child and the shell adopts it. The adopted image is put back on unmount, so it survives
StrictMode's double mount:

```tsx
<Materials3D preset="skewer">
  <img data-materials3d-poster src="/hero.webp" alt="" />
</Materials3D>
```

Peer dependencies: `react >= 18`, `three >= 0.180 < 1`. `@types/three` is an optional peer.

MIT.
