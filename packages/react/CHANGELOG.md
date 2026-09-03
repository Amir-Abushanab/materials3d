# @materials3d/react

## 0.1.0

### Minor Changes

- Initial release: the `<Materials3D>` component. Renders a `<div>` and mounts the poster-first
  shell on the client. Props: `preset` (a name or a function), `config`, `lamps`, `lampGain`,
  `background`, `transparentBackground`, `clearGlass`, `post`, `motion`, `scatter`, `orbit`,
  `quality`, `dprMax`, `paused`, and the shell options `poster`, `posterFit`, `lazy`, `webgl`,
  `minSizeForWebGL`, `respectReducedMotion`, `renderer`. Callbacks `onReady(renderer)` and
  `onFallback(reason)`. SSR-safe; an `<img data-materials3d-poster>` child is adopted as the
  poster.
