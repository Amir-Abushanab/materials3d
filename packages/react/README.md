<a href="https://github.com/Amir-Abushanab/materials3d"><img src="https://raw.githubusercontent.com/Amir-Abushanab/materials3d/main/brand/icon-192.png" alt="" width="64" align="right"></a>

# @materials3d/react

The `<Materials3D>` component: a drop-in, self-optimizing refractive-glass scene for React.

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

Renders a `<div>` and mounts the shell on the client — poster-first, lazy, and WebGL /
reduced-motion / Save-Data aware, with three code-split out of your initial bundle.

## Props

Precedence is `default ← preset ← flat props ← config`.

| prop                                                                              | notes                                                                                                                                                    |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`                                                                          | a name (`"skewer"`, `"assembly"`, `"materials"`, …) or a function returning a config. A name lazy-loads the presets chunk; a function is tree-shakeable. |
| `config`                                                                          | escape hatch: a full or partial config, applied last                                                                                                     |
| `lamps`, `lampGain`, `background`, `clearGlass`                                   | the light field behind the glass                                                                                                                         |
| `post`, `motion`, `scatter`                                                       | merged onto whatever the preset authored, so `scatter={{ count: 24 }}` re-scatters the reference scene                                                   |
| `orbit`, `quality`, `dprMax`, `paused`                                            |                                                                                                                                                          |
| `poster`, `posterFit`, `lazy`, `webgl`, `minSizeForWebGL`, `respectReducedMotion` | shell behaviour                                                                                                                                          |
| `onReady(renderer)`, `onFallback(reason)`                                         |                                                                                                                                                          |

## SSR

The component is SSR-safe. For a server-rendered poster with no hydration flash, pass the image as
a child and the shell adopts it:

```tsx
<Materials3D>
  <img data-materials3d-poster src="/hero.webp" alt="" />
</Materials3D>
```

Peer dependencies: `react >= 18`, `three >= 0.180 < 1`.

MIT.
