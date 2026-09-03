<a href="https://github.com/Amir-Abushanab/materials3d"><img src="https://raw.githubusercontent.com/Amir-Abushanab/materials3d/main/brand/icon-192.png" alt="" width="64" align="right"></a>

# @materials3d/element

The `<materials-3d>` custom element: a drop-in Materials3D scene for Vue, Svelte or plain HTML.

```bash
pnpm add @materials3d/element three
```

```html
<script type="module">
  import "@materials3d/element";
</script>

<materials-3d
  preset="skewer"
  poster="/hero.webp"
  min-size="520"
  style="display:block; width:100%; height:100vh"
></materials-3d>
```

Light DOM, `display: block`, self-registering on import (guarded, so importing under Node during
SSR is a no-op). Poster first and lazy, with three code-split out of the initial load. `register(tag)`
registers the class under another tag name.

## Attributes

| attribute                   | notes                                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| `preset`                    | a shipped preset name                                                       |
| `src`                       | URL of a config JSON, for example one of the files in `gallery/`            |
| `config`                    | inline JSON, merged one level deep over `preset` and `src`                  |
| `transparent`               | drop the backdrop, so the scene composites over the page                    |
| `paused`                    | live; toggles playback                                                      |
| `poster`, `poster-fit`      | `poster-fit` is `fill` (default, matches the canvas), `cover` or `contain`  |
| `lazy`, `webgl`, `min-size` | shell options                                                               |
| `renderer`                  | `webgpu` selects the experimental WebGPU/TSL engine; anything else is WebGL |

Boolean attributes: present means true, `"false"` or `"0"` means false, absent means the shell
default.

`poster`, `poster-fit`, `lazy`, `webgl`, `min-size` and `renderer` are read once at mount.
Changing one on a connected element does nothing until it is disconnected and reconnected.
`config`, `src`, `preset`, `transparent` and `paused` are live.

## Properties and events

The `config` property (a `Partial<SceneConfig>`) is merged last, one level deep, for framework
bindings. The read-only `handle` is the shell's `MaterialHandle`, or `null` before connect and
after disconnect. The element is declared in `HTMLElementTagNameMap`, so
`document.querySelector("materials-3d")` types as `Materials3DElement` and `.handle` typechecks
without a cast.

Events: `materials3d-ready` (detail: the renderer) and `materials3d-fallback` (detail: the reason
the scene stayed a poster).

```ts
const el = document.querySelector("materials-3d");
if (el) {
  el.addEventListener("materials3d-ready", async () => {
    const blob = await el.handle?.snapshot({ time: 0 });
  });
}
```

Peer dependency: `three >= 0.180 < 1`. `@types/three` is an optional peer.

MIT.
