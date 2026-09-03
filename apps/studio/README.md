# Materials Studio

The browser tool for designing Materials3D scenes. `pnpm dev` at the repo root serves it on
http://localhost:5173; CI deploys it to https://materials-studio.pages.dev from `main`.

One JSON config drives the preview, the panel and every export. The panel is a Tweakpane tree with
a search box, and its sections open expanded.

## Layout

The stage holds the preview with the export frame drawn over it; the panel sits beside it.
**Output**, **Performance**, **Guides** and **Actions** come first. The scene folders follow in the
order the frame is built: **Scene** (backdrop), **Lamps**, **Backplate**, **Camera**, **Post**,
**Beam**, **Interaction** and **Shapes**. Undo, redo, the version list and a **?** listing every
gesture sit in the panel header.

## Presets

**Actions** leads with the preset grid: one rendered thumbnail per shipped preset, generated after
first paint. **Reset to preset** returns to the selected one. A scene opened from a share link
selects no preset.

## Editing in the viewport

Double-click a shape to select it. Its folder in the panel expands, scrolls into view and flashes.
A generated (`scatter`) scene is baked into a concrete `items` list first; that step is
pixel-identical and undoable.

| gesture                | does                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| double-click           | select a shape; a member selects its whole group, alt-click drills in |
| drag empty space       | marquee-select                                                        |
| shift-click            | add to the selection                                                  |
| drag                   | move in the plane facing the camera                                   |
| shift-drag             | move along the view axis (depth)                                      |
| right-drag             | rotate about the camera's up and right axes                           |
| shift-right-drag       | roll about the view axis                                              |
| corner handle          | scale                                                                 |
| right-drag empty space | orbit the camera                                                      |
| wheel                  | zoom                                                                  |
| Cmd+G, Cmd+Shift+G     | group, ungroup                                                        |
| Delete or Backspace    | remove the selection                                                  |
| Esc                    | deselect                                                              |

The selection box is DOM, not scene geometry, so it stays crisp and never reaches an export. During
a gesture the badge reports the value being steered (position, scale factor, or degrees of
rotation), and the box edge dashes while rotating. A multi-selection rotates and scales about its
own centre.

## Guides

**Guides** overlays an alignment grid on the preview: `divisions` (3 for thirds), `centre lines`
and `tilt guide` in degrees, to match a rolled camera. It divides the frame, not the world, and is
DOM, so it never appears in an export.

## Undo, redo and versions

Every edit is a version. Edits coalesce per gesture, so dragging a slider is one step. Cmd+Z and
Cmd+Shift+Z (Ctrl+Z and Ctrl+Y elsewhere), or the buttons in the panel header. The version list
shows each entry with a thumbnail, a derived label ("lamp gain", "shuffle lamps", "Assembly") and a
relative time; click one to jump to it. Clearing the history can be taken back with U while its
toast is up.

## Output

**Output** sets the exact pixel size every export renders at, independent of the preview: presets
from a 1200x630 social card to 8K, a custom size (64 to 8192 px per side), a ratio lock, and
`actual size`, which shows the export at one export pixel per CSS pixel. The frame can also be
resized by its corners. Sizes at 4K and above carry a GPU warning in the dropdown: four passes per
frame cost roughly four times a single-pass renderer at the same size.

### Stills

WebP, PNG or JPEG, with a quality slider for the lossy two. Only the formats this browser can
encode are listed: canvas encoders fall back to PNG silently, so an unlisted format is named under
the format rows ("Not encodable in this browser: ..."). Stills render at time 0, the frame the
scene opens on, so a re-export matches the first frame a visitor sees. Keyboard: S.

### Clips

| format        | how                                                 | when                                                         |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| WebM, MP4     | MediaRecorder over the canvas stream, in real time  | ordinary clips; MP4 where the browser supports it, else WebM |
| Animated WebP | frame-walked through `seek()`, muxed in the browser | frame-exact, reproducible, or with alpha                     |
| GIF           | frame-walked, 256 colours per frame                 | when the destination only takes a GIF                        |

`seconds` runs 1 to 30. `fps` (8 to 60) applies to the frame-walked formats. Those render frame N
at time N / fps whatever the frame took, so a heavy scene records at the intended speed. GIF's
long edge is capped at 640 px and its frames are flattened onto the background colour, since GIF
has one-bit transparency. Set `loopSeconds` in the scene so the clip closes.

### Code and embed

**Get code** (keyboard: C) shows the scene as a React component, a `<materials-3d>` element, vanilla
`createMaterials`, a CDN script tag or JSON, with defaults stripped. **Copy for your agent** puts a task, the
scene's snippet and the package's agent skill on the clipboard as one prompt for a coding agent;
a one-time card bottom-right of the stage offers the same button. **Save embed (.html)** writes a
single self-contained page with the runtime inlined. **Wallpaper folder (.zip)** wraps that embed
with a Wallpaper Engine `project.json`, a Lively `LivelyInfo.json` and a preview frame.

## Actions

- **Edit config** (keyboard: J) opens the JSON in a CodeMirror editor whose linter marks the
  offending line. Apply writes it back; Save .json downloads it.
- **Save config (.json)** and **Load config (.json)**.
- **Copy share link** puts the minimal config (defaults stripped) in the URL hash as URL-safe
  base64, inside a versioned envelope so older links keep opening. An image or video picked from
  disk is left out, since it lives in the config as a data URI; a hosted URL travels. Past 8000
  characters no link is made, and the config download is the vehicle instead.
- **Publish to gallery** copies the scene to the clipboard and opens GitHub's new-file page for
  `gallery/community/` with it prefilled as `{ title, author, config }`. Set the title and your
  handle, then create a branch to open a pull request. Hosted image and video URLs only.
- **shuffle lamps** (keyboard: R) draws a new lamp field from the measured palette;
  **randomize scene** re-rolls the scene within bounds, keeping the shape kinds.

## Interaction

**Interaction** holds the scene-level reactions, the touch opt-in, and a scroll preview slider.
**Scroll to test** lays a scrolling test surface over the preview so `scroll` and
`scrollVelocity` reactions can be driven by real scrolling. Per-shape reactions live in each
shape's folder; a scatter scene has one shared list under **All shapes**.

## Performance

`quality` scales the depth, plate and main passes (0.35 to 2; the post pass runs at full
resolution). Above 1 it supersamples, which is the one setting that antialiases everything at
once, the depth included, so it is what cleans up a defocused edge that still stairsteps; it costs
the square, so reach for it on a small canvas rather than a full-bleed hero. `max DPR` caps
devicePixelRatio. `measured thickness` adds a back-face depth pass.
`engine` switches between the WebGL engine and the experimental WebGPU/TSL engine in place; see
[WEBGPU.md](../../WEBGPU.md).
