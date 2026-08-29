---
"@materials3d/core": minor
"@materials3d/element": minor
"@materials3d/react": minor
---

Initial release: scene-level refractive glass for the web.

A four-pass renderer (depth → plate → main → post) where the colour comes from a bounded field of
lamps _behind_ the glass rather than from tint applied to it. Ported from the r128 prototype to
TypeScript and three ≥ 0.180.

- `@materials3d/core` — the renderer, lathe-based shape builders, motions, the
  `skewer`/`assembly`/`slimes`/`reactions` presets, a JSON config model, and a poster-first shell
  whose `.` entry has no static three import (three is code-split behind a dynamic import).
- `@materials3d/react` — the `<Materials3D>` component.
- `@materials3d/element` — the `<materials-3d>` custom element.

Notable choices carried over from the port: `material.radius` is now `material.path` and defaults
are derived from the shape's geometry, since the old name invited passing a disc's radius where its
half-thickness was meant; the pass chain is authored in display space with three's colour
management deliberately bypassed, because the look was calibrated there.

Two behaviours worth calling out because they are easy to hit and hard to diagnose: a scene
constructed in a background tab now reads `document.visibilityState` instead of assuming it is
visible (it used to mark itself running, queue a rAF that never fired, and stay frozen forever
once the tab came forward), and an idle repaint re-derives the camera pose, so orbiting or
resetting the camera on a paused scene actually moves it. `MaterialRenderer.rebuild()` is public for
editors that mutate `getConfig()` in place, where `setConfig`'s structural diff would be comparing
an object against itself.

`background: "transparent"` (or `transparentBackground: true`) renders the scene over
transparency, so the glass composites onto the page behind the canvas. The main pass carries
coverage in the alpha channel the plate pass uses for depth — nothing reads depth back from it —
and the post pass gathers and un-premultiplies RGBA so soft edges don't bleed. Haze takes coverage
away rather than painting a band. Exposed as `transparentBackground` on `<Materials3D>` and a
`transparent` attribute on `<materials-3d>`.

Materials Studio records animated WebP and GIF in addition to WebM/MP4. It is muxed in the browser from
natively-encoded WebP frames (no encoder dependency), and walked through `seek()` rather than
captured in real time — so the clip is frame-exact, reproducible from the same config, and keeps
alpha, which neither WebM nor MP4 can. `MaterialRenderer.isRunning` is public so a capture can
restore playback to whatever state it interrupted.

`@materials3d/core/studio` exposes the offscreen thumbnail helpers (`createThumbHost`,
`prepThumbConfig`, `renderThumbFrame`) that render a config to a still frame through one hidden,
reused renderer — what the studio's preset picker and version history are built on.

GIF export uses `gifenc` and the same `seek()` frame walk, flattening onto the background colour
(GIF's one-bit alpha would fringe a soft edge) and capping the long edge at 640px. The panel states
the 256-colour banding and the downscale up front rather than after the wait.

`MaterialRenderer` gains the primitives direct manipulation needs: `pick` (raycast a client point to a
shape), `projectBounds` (a shape's screen-space box, for a DOM overlay), `pointOnDragPlane`,
`viewDirection`, `getItems` and `isRunning`, plus a `bakeScatter` helper that turns a generated
scene into an authored one. Items now keep the identity of the config objects they were built from,
so an editor mutating `item.config` edits the scene rather than a copy.

Motion is per shape rather than per scene: `ItemConfig.motion` and `ItemConfig.phase`, with a
matching template on `ScatterConfig` (`motion` + `stagger`). `MotionConfig` loses `stagger` — how
successive shapes are offset is a property of the arrangement, not of a motion. `createItem(shape, from)` inherits an existing shape's geometry, material and
motion, which is what the studio's "add shape" uses.

Shapes can be rotated in the viewport by right-dragging (about the camera's up and right axes,
with shift rolling about the view axis). Viewport gestures edit the shape's AUTHORED pose — `home`
and `homeRotation` — rather than the live mesh, so a gesture on a shape that is already moving
composes with its motion instead of folding a frame of the animation into its resting pose.
`MaterialRenderer`'s orbit now ignores non-primary buttons, which previously meant a right-drag
orbited the camera and opened the context menu at the same time.
