# @materials3d/react

## 0.4.0

### Minor Changes

- [#7](https://github.com/Amir-Abushanab/materials3d/pull/7) [`2d7b156`](https://github.com/Amir-Abushanab/materials3d/commit/2d7b1566aa26a9716a6d65d52488a1577651709d) Thanks [@Amir-Abushanab](https://github.com/Amir-Abushanab)! - Device tilt as an interaction input. `tiltX` / `tiltY` join the binding sources, reading the phone's
  orientation sensor normalized 0..1 the way a ball would roll on the screen and resting at 0.5 in
  whatever pose the reader was already holding — the first reading becomes the neutral centre, and the
  axes are rotated by the screen angle so `tiltX` means "toward the right edge" in every orientation.
  On these materials it is the most literal reading of the surface: tilt the device and the highlight
  travels across the glass the way it would on a real object in your hand.

  Binding either source is what arms the sensor; a scene that mentions neither attaches no
  `deviceorientation` listener. `interaction.tilt` tunes it (`range`, `smoothing`, `invertX` /
  `invertY`) and `tilt.pointer` lets tilt stand in for the cursor, so the lamp-follows-the-cursor scene
  works on a phone without a second set of bindings.

  **iOS gets no tilt, on purpose.** Safari gates the sensor behind a modal permission dialog, and
  nothing here opens one — a tilt-bound scene on an iPhone reads 0.5 on both axes and renders exactly
  as it would with no tilt at all. A decorative effect is not worth interrupting a reader for, so tilt
  is an enhancement some phones simply don't get. `enableTilt()` on the renderer / handle / element is
  the explicit opt-in for a page where tilt is the point; `tiltStatus()` reports where the sensor
  stands, and `recenterTilt()` re-takes the neutral pose after a change of grip.

  **The interactivity runtime is now a lazy chunk.** The controller, its listeners, the applier tables
  and the new tilt sensor (~3.7 KB gzipped) used to ship in every bundle, including the scenes that
  bind nothing; both engines now reach them through a dynamic import, and the eager core chunk drops
  from 75.9 KB to 72.7 KB gzipped. `interactionActive` moved to `renderer/interactionGates.ts` (it is
  re-exported from `@materials3d/core/renderer` as before), and a dependency-cruiser rule fails the
  build if anything in the eager graph imports the runtime again.

  BREAKING, narrowly: `InteractionController` is now a TYPE-only export of `@materials3d/core/renderer`
  — a value re-export would drag the chunk back into every bundle. The renderers own the instance;
  nothing outside them could usefully construct one.

  The one behavioural difference: interaction goes live a chunk-fetch after the first frame rather
  than on it. Nothing to react to until a reader moves, so it is invisible in practice —
  `setInteractionInput` calls made in that window are staged and replayed, and `enableTilt()` reports
  false (and starts the fetch) if it somehow lands first.

### Patch Changes

- Updated dependencies [[`2d7b156`](https://github.com/Amir-Abushanab/materials3d/commit/2d7b1566aa26a9716a6d65d52488a1577651709d)]:
  - @materials3d/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`9308bca`](https://github.com/Amir-Abushanab/materials3d/commit/9308bcaa15ba1f907ddfe38cccae672b2eab8f64)]:
  - @materials3d/core@0.3.0

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
