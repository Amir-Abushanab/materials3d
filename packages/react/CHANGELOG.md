# @materials3d/react

## 0.2.0

### Patch Changes

- Updated dependencies [[`82ba9e9`](https://github.com/Amir-Abushanab/materials3d/commit/82ba9e9b80098a0366786077c0ea427b8c549ee3)]:
  - @materials3d/core@0.2.0

## 0.1.0

### Minor Changes

- Initial release: the `<Materials3D>` component. Renders a `<div>` and mounts the poster-first
  shell on the client. Props: `preset` (a name or a function), `config`, `lamps`, `lampGain`,
  `background`, `transparentBackground`, `clearGlass`, `post`, `motion`, `scatter`, `orbit`,
  `quality`, `dprMax`, `paused`, and the shell options `poster`, `posterFit`, `lazy`, `webgl`,
  `minSizeForWebGL`, `respectReducedMotion`, `renderer`. Callbacks `onReady(renderer)` and
  `onFallback(reason)`. SSR-safe; an `<img data-materials3d-poster>` child is adopted as the
  poster.
