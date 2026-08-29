<a href="https://github.com/Amir-Abushanab/materials3d"><img src="https://raw.githubusercontent.com/Amir-Abushanab/materials3d/main/brand/icon-192.png" alt="" width="64" align="right"></a>

# @materials3d/element

The `<materials-3d>` custom element: a drop-in refractive-glass scene for Vue, Svelte, or plain HTML.

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
SSR is a no-op). Poster-first and lazy, with three code-split out of the initial load.

## Attributes

| attribute                             | notes                                                      |
| ------------------------------------- | ---------------------------------------------------------- |
| `preset`                              | a shipped preset name                                      |
| `src`                                 | URL to a config JSON — e.g. one of the files in `gallery/` |
| `config`                              | inline JSON, merged over `preset`/`src`                    |
| `poster`, `poster-fit`                | `fill` (default, matches the canvas) / `cover` / `contain` |
| `paused`, `lazy`, `webgl`, `min-size` |                                                            |

Also a `config` **property** (merged last, for framework bindings) and a read-only `handle` getter.

## Events

`materials3d-ready` (detail = the renderer) and `materials3d-fallback` (detail = the reason the scene
stayed a poster).

```js
document.querySelector("materials-3d").addEventListener("materials3d-ready", async (e) => {
  const blob = await e.target.handle.snapshot({ time: 0 });
});
```

Peer dependency: `three >= 0.180 < 1`.

MIT.
