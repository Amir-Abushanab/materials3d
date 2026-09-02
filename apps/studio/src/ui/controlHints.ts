/**
 * Hover hints for the control-panel labels. Ported from Wave Studio's controlHints.
 *
 * A hinted label gets a dotted underline + a "help" cursor; hovering it — or keyboard-focusing
 * the control on that row — reveals a small tooltip. The tooltip is a single shared element
 * rendered through the native Popover API (Baseline 2025), so it lives in the top layer and
 * escapes the panel's overflow/scroll clipping and the WebGL canvas beneath. Positioning is done
 * in JS from the label's rect (prefer-below, flip-above when there's no room), so no anchor-
 * positioning polyfill is needed. WCAG 1.4.13: dismissible (Escape / scroll), persistent while
 * hovered/focused, and it fades in only when motion is allowed.
 *
 * The map keys are the EXACT label strings Tweakpane renders (the `label` option, or the bare
 * property key when none is given). A handful of labels repeat across sections (e.g. "quality"
 * in Performance vs Output) — those are disambiguated by an enclosing folder via FOLDER_HINTS.
 * Folder titles are normalized before lookup: the live counts this panel appends ("Lamps · 10")
 * and per-lamp numbering ("lamp 3") are stripped, so one key covers every instance.
 *
 * Hint wording is grounded in what each control actually does in the renderer — a one-line gloss
 * of the visual effect, since even a well-named knob benefits from a plain-language description.
 * The long-form rationale lives with the config model (`config/model.ts`); keep the two in step.
 */

/** Hints keyed by the rendered label text (button titles keep their leading emoji here; the
 *  de-emoji'd form is matched too, since applyIcons strips the glyph from the DOM). */
const CONTROL_HINTS: Record<string, string> = {
  // --- Actions ---
  "🎲 randomize scene":
    "Rerolls the whole look within tasteful bounds: lamps, optics, framing, motion and post. Shape KINDS are left alone — the shape set is the scene's identity. Undo brings the old one back.",
  "🎲 shuffle lamps":
    "Re-rolls only the lamp field. Colours are drawn from the reference frame's measured hue distribution — warm, magenta, blue-violet, no cyan — so a shuffle stays in the family. One undo step. (Shortcut: R.)",
  "🔄 Reset to preset":
    "Returns to the preset's authored config, discarding your edits (undoable).",
  "🔗 Copy share link":
    "Copies a URL with the whole config packed into its #hash — no server involved. A backdrop image or video chosen from disk rides along as a data URI, which can make the link very long.",
  "⟨⟩ Get code…":
    "The current scene as a ready-to-paste snippet — React, web component, vanilla, CDN or raw JSON. Only values that differ from the defaults are included.",
  "✏ Edit config…":
    "The scene as editable JSON — linted as you type; Apply runs the same validator the renderer uses.",
  "🌍 Publish to gallery":
    "Opens a prefilled GitHub new-file page so your scene arrives as a pull request to the public gallery. No account here, no backend — just GitHub.",
  "📷 Save still":
    "Renders one frame at the exact Output size (not the preview size) and downloads it. Always the frame at time 0, so a poster regenerated later doesn't churn.",
  "🖥 Save embed (.html)":
    "One self-contained HTML file: the runtime (three bundled) inlined next to this config. No network at runtime — drop it on any host.",
  "🖥 Wallpaper folder (.zip)":
    "A zip with the embed page plus a still, ready for the live-wallpaper apps that accept an HTML folder.",
  "💾 Save config (.json)": "Downloads the full scene config as JSON.",
  "📂 Load config (.json)": "Opens a saved config JSON and applies it (undoable).",

  // --- Scene ---
  backdrop:
    "Base colour behind everything. Still used while 'transparent' is on: it is what haze and soft edges fade toward, so they dissolve into something sensible.",
  "mirror ↔": "Flips the finished frame horizontally. Pure post — the scene itself is untouched.",
  "mirror ↕": "Flips the finished frame vertically.",
  "backdrop mode":
    "What the backdrop is painted with: a gentle ramp off the backdrop colour, a gradient, or an image/video. Whatever goes here is rendered INTO the refraction source, so the glass bends it rather than it sitting flat behind.",
  transparent:
    "Drops the backdrop so the gaps between shapes composite onto whatever is behind the canvas. The glass still refracts the LAMP FIELD, not your page — where no lamp sits behind a shape it falls back to 'clear glass'.",
  "clear glass":
    "What glass looks like where no lamp sits behind it — keep it a hair off white, and pick it to suit the surface the scene sits over when transparent.",
  orbit: "Drag the viewport to orbit, wheel to dolly. Turn off for a pure background.",
  paused:
    "Freezes playback on the authored frame. Exports still work — captures scrub time on their own.",
  "loop (s)":
    "Seamless-loop period. Above 0, every motion's rate is snapped to whole cycles over this window, so a clip recorded at exactly this length cuts back to its first frame without a jump. Setting it also sets the record duration to match.",
  "ease in on load":
    "Ramps the animation up over ~1s on load instead of starting at full speed. Live playback only — exports and posters are untouched.",

  // --- Gradient ---
  type: "How the palette is laid across the backdrop: linear, radial, conic, or a mesh of colour blobs.",
  angle: "Ramp direction in radians. Radial and mesh ignore it.",
  "blob softness": "Falloff of each mesh colour point — larger blends softer and broader.",

  // --- Image / video ---
  "🖼 Choose image…":
    "A backdrop image from disk. Stored as a data URI so it survives reload and travels inside a share link — large files make large configs, that's the trade.",
  "🎞 Choose video…":
    "A backdrop video from disk. When both are set the video wins. Like the image, it is refracted by the glass, not pasted behind it.",
  "✕ Clear media": "Removes the backdrop image/video and returns to colour or gradient.",
  fit: "How the media fills the frame: cover crops, contain letterboxes, stretch distorts.",
  zoom: "Scale of the backdrop media within the frame.",
  "pan x": "Horizontal pan of the backdrop media, in fractions of the frame.",
  "pan y": "Vertical pan of the backdrop media, in fractions of the frame.",

  // --- Lamps ---
  gain: "Scales the whole lamp field's coverage before the gate. More gain = more of the frame carries colour.",
  "gate lo":
    "Lower edge of the coverage gate. The gate crushes each lamp's Gaussian tail to zero — the single most important setting for making clear glass read as CLEAR: without it every lamp reaches everywhere and everything carries a little tint.",
  "gate hi":
    "Upper edge of the coverage gate. Coverage above this clamps to full — lower it to let lamp cores saturate harder.",
  "on backdrop":
    'How much of the lamp field shows on the backdrop itself, in the gaps between shapes. If colour appears ONLY inside glass the eye reads it as tint; a faint presence outside (~0.05) is what sells "the colour is behind".',
  palette:
    "Recolours the existing lamps from a named palette without moving one of them — the arrangement is the composition, this is only its colour.",
  "＋ add lamp": "Adds a lamp. The shader's lamp array is fixed at 12, so the button stops there.",

  // --- one lamp ---
  intensity: "This lamp's weight in the field (1 = full).",

  // --- Backplate ---
  "scale x":
    "World units of scene the plate's horizontal axis spans — how stretched the lamp field is.",
  "scale y": "World units the plate's vertical axis spans.",
  "offset x": "Which part of the lamp field sits at world origin — pans the field horizontally.",
  "offset y": "Pans the lamp field vertically.",

  // --- Camera ---
  fov: "Vertical field of view in degrees. Keep it LONG (~12°): with a wide fov, rotation about a horizontal axis reads as tumbling instead of foreshortening.",
  "aspect fit":
    "How the authored 16:9 framing maps onto a canvas of a different shape. Cover fills and crops (the hero look); contain shows the whole frame and reveals world beyond it; width/height always bind on that one axis.",
  "min width kept":
    "Narrow-screen crop guard: the least of the authored frame's WIDTH that must stay visible (0 = off). Cover binds on height below 16:9, so a portrait phone zooms deep into the middle — this only ever zooms back out.",
  height: "Camera height in world units — where the camera body sits vertically.",
  "tilt °": "Camera roll in degrees — tilts the whole composition in frame.",
  "look at y": "Height of the point the camera looks at — tips the framing up or down.",
  "⟲ reset camera": "Returns the camera to this scene's authored pose (after orbiting around).",

  // --- Post ---
  focus:
    "Focal distance in world units. Keep it near the camera distance or the whole scene lands outside the sharp band.",
  range: "Depth either side of focus that stays sharp. Narrow = a thin slice of crisp glass.",
  aperture:
    "Maximum blur circle in pixels for out-of-focus depths. Works with 'range': wide aperture + narrow range blurs almost everything.",
  bloom:
    "Glow weighted by SATURATION, not brightness — a normal bright-pass does nothing against a near-white backdrop, where the background is the brightest thing in frame.",
  "bloom radius": "How far the bloom gathers, in pixels — larger is a softer, wider halo.",
  "bloom threshold":
    "Saturation a pixel must exceed before it blooms. 0 blooms anything with any colour.",
  caustics:
    "Bright pools under the shapes — a downward saturation-weighted gather. A screen-space approximation, not real light transport.",
  haze: "Fog rising from the bottom of frame, dissolving the shapes' bases. On a transparent scene it fades them toward the page instead of painting a band.",
  "haze top": "How far up the frame the haze reaches.",
  "haze colour": "The haze's own colour — usually a whisper off the backdrop.",
  vignette: "Darkens the frame's corners toward the edges.",

  // --- Light shafts ---
  strength:
    "God-rays: streaks scattered out of the composited frame, radiating from the source point below. Glass is what emits, so the shafts carry the tint the light picked up passing through it.",
  decay: "Per-sample falloff along a ray — lower gives shorter, punchier rays.",
  "source x": "Horizontal position of the shaft source (0 = left edge, 1 = right).",
  "source y": "Vertical position of the shaft source (0 = bottom, 1 = top).",

  // --- Stylise ---
  dither:
    "Ordered (Bayer) dithering over the finished frame: posterizes it, then hides the banding under a cross-hatched retro pattern. Runs last.",
  "dither px": "Size of one dither cell in device pixels — larger reads chunkier.",
  "dither levels": "Colour levels kept per channel — fewer means heavier posterization.",
  halftone: "A rotated dot screen over the frame, like a single-ink print.",
  "dot size": "Dot cell size in device pixels — larger reads as a coarser print screen.",
  "screen angle": "Rotation of the dot grid, in radians — the print screen angle.",
  "cmyk process":
    "Four rotated dot screens (cyan/magenta/yellow/black) at print angles instead of one grey screen — the misregistered-print look.",
  "cmyk dot size": "Dot size for the four CMYK screens.",
  paper: "Fibrous paper-substrate shading multiplied over the frame.",
  "paper scale": "Size of the paper fibres — larger reads as coarser stock.",

  // --- Shapes (scatter) ---
  count:
    "How many shapes the scatter generates. Phase spread re-derives per count, so the wave stays covered.",
  seed: "Reseeds the deterministic layout — the same seed always reproduces the same arrangement.",
  sides:
    "Lathe segments. High is round; SIX is a hexagonal prism — most of the prism family is just this number.",
  span: "The width along X the shapes are laid out across, centred on the base position.",
  "base y": "Vertical centre the row is generated around.",
  depth: "Random depth spread along Z — how far shapes stray toward and away from the camera.",
  "len vary": "Fraction by which a shape's length may be CUT — 0 keeps every shape full length.",
  "rad vary": "Absolute jitter added to each shape's radius, in world units.",
  "phase spread":
    "How the shapes' motion phases spread across the row, in TURNS end to end. 1 is the value that matters: a full turn makes the wave travel; cluster the phases and the trough sits still as a bald patch.",
  "phase jitter": "Extra random phase per shape, in radians — roughens a too-perfect wave.",

  // --- one shape ---
  kind: "The geometry. Almost everything is a lathe — rods, discs, cones, spheres and rings differ only in profile; hex is a prism with six sides; arrow is a swept 2D path. Fields a kind doesn't use are kept, so switching back never loses values.",
  radius: "Outer radius in world units (tube radius for a rod, disc radius for a disc).",
  thickness: "Slab thickness for discs and rings, in world units.",
  "outline (svg d)":
    "The silhouette of a `path` shape. Paste an SVG `d`, or the whole `<svg>` file — every `<path>` in it is read, in order. Y is read pointing DOWN as SVG does and flipped, and the drawing is scaled until its longer half-extent is the RADIUS above, so a path from any viewBox arrives at a findable size. The first subpath is the outline; every later one is a hole. The scene rebuilds when you stop typing, not on every keystroke.",
  position: "The shape's authored resting place. Viewport drags edit the same values.",
  rotation:
    "Authored orientation in radians. Motions compose on top of it rather than overwriting it.",
  phase:
    "Where THIS shape sits in its motion's cycle, in radians. Spreading phases across a row is what turns identical motions into a travelling wave.",
  name: "A label for this panel only — nothing reads it at render time.",
  "＋ add shape":
    'Clones the last shape — its geometry, material and motion — landing beside its source. "Another one of those" is almost always what adding means.',
  "◎ locate in scene": "Flashes this one in the viewport and selects it.",
  "⛓ group selection  (⌘G)":
    "Groups the selected shapes so they select and transform as one. Membership lives on the shapes — nothing changes at render time.",

  // --- Motion ---
  axis: "Which axis the motion drives. A lathed shape spun about its own symmetry axis is literally invisible — roll it about a different one.",
  rate: "Angular speed in radians per second. Negative reverses. With a loop set, it snaps to whole cycles per loop.",
  drift: "Vertical bob amplitude in world units (drift motion only).",
  "↻ apply to all shapes":
    "Stamps this folder's values onto every shape. Per-shape motion makes uniformity the thing you ask for — this is how you ask.",

  // --- Material ---
  path: "Half the optical path at normal incidence — tube radius for a rod, HALF-THICKNESS for a disc. It feeds absorption, so a disc given its radius here saturates to opaque plastic. Derived from the geometry by default.",
  density:
    "Absorption strength σ along that path — higher pulls deeper colour out of the same glass.",
  tint: "Gives the shape its own absorption colour instead of borrowing the lamps behind it.",
  ior: "Refraction strength. 1.45 ≈ glass; higher bends the sampled background harder.",
  dispersion: "Splits the refraction per colour channel — the rainbow fringing at edges.",
  lens: 'Rim-weighted screen-space displacement: near-flat in the middle, hard bending at the edge — the difference between "frosted" and "cut".',
  rim: "Strength of the bright edge highlight at the silhouette — the cue that sells glass.",
  specular: "Specular highlight strength from the key light.",
  saturation: "Chroma boost on the colour passing through (1 = as sampled).",
  emission: "Self-glow added on top of what the shape transmits or reflects.",
  roughness:
    "Surface scatter. On frosted glass it spreads the refracted ray into a diffuse glow; on opaque kinds it broadens the highlight. Inert for clear glass.",
  sparkle: "Micro-facet glint density (glitter only).",
  colour: "Base colour the opaque surface reflects — unlike 'tint', which is an absorption colour.",
  "F0 colour":
    "A metal's colour IS its reflectance: measured normal-incidence F0, which is why gold reflects gold at every angle instead of white with a yellow wash.",
  "edge (F82)":
    'Measured reflectance near the silhouette (~82°). Real metals desaturate there — plain Schlick can\'t, and "gold that is uniformly gold" is what reads as CG. Empty = plain Schlick.',
  metal:
    "Preset F0/F82 pairs measured from real conductors. 'custom' means the colour was hand-picked.",

  // --- Output ---
  size: "Exact pixel size every export renders at, independent of the preview. GPU-heavy sizes are marked in the list — four passes cost ~4× the fill rate of a single-pass renderer.",
  "lock ratio": "Keeps width and height proportional when you change either.",
  "width px": "Export width in pixels.",
  "height px": "Export height in pixels.",
  "still format":
    "File type for stills. PNG is lossless (and what the calibrate tool reads); WebP/JPEG are smaller.",
  "video format":
    "WebM/MP4 record in real time; animated WebP and GIF are walked frame-by-frame through seek(), so they are frame-exact, reproducible — and WebP keeps alpha, which the video formats cannot.",
  seconds: "Clip length. Setting a loop syncs this to it, so recordings cut seamlessly.",
  fps: "Frames per second of the recording.",

  // --- Performance ---
  "max DPR":
    "Ceiling on devicePixelRatio. Four passes per frame is a real cost, and this is the main knob — 1.5 on a retina display halves the pixel work with little visible loss.",
  "measured thickness":
    "Measures each shape's optical path from a back-face depth pass instead of assuming a cylinder. Worth one extra pass for discs, spheres, rings and arrows; on a rod scene it buys nothing (the analytic chord is exact there).",
  engine:
    "Which renderer draws the scene. WebGL is the reference; WebGPU (TSL) is experimental and not pixel-equal to it — see WEBGPU.md. Switching costs a moment of load the first time, since it is a second three build.",

  // --- Guides ---
  grid: "Overlay alignment guides on the preview. Pure DOM — never reaches an export.",
  divisions: "How many cells the frame is divided into. 3 gives rule-of-thirds.",
  "centre lines": "Adds centre cross-hairs to the grid.",
  "tilt guide °": "Rotates the guide overlay — for judging a deliberately tilted composition.",
};

/**
 * Overrides for labels that mean different things in different folders, keyed `Folder label`
 * (folder titles normalized: live counts and per-item numbers stripped, so "Lamps · 10" → "Lamps"
 * and "lamp 3" → "lamp").
 */
const FOLDER_HINTS: Record<string, string> = {
  // "quality" — render-target scale vs export compression.
  "Performance quality":
    "Render-target scale (0.5–1) for the depth/plate/main passes. The post pass always runs at full resolution, so lowering this softens the glass without softening the grain.",
  "Output quality":
    "Compression quality for the exported image — higher looks better but weighs more.",
  // "grain" — film grain vs glitter grain.
  "Post grain": "Static film-grain speckle over the whole finished frame.",
  "Material grain": "Glitter grain frequency — higher is finer sparkle.",
  // "length" — a shape's length vs the light shafts' reach.
  "Shapes length": "Length along the sweep axis (rod, prism, cone) — an arrow's shaft length.",
  "Light shafts length": "How far the shafts reach from the source point.",
  // "distance" — plate depth vs camera dolly.
  "Backplate distance":
    "How far behind the scene the lamp plate hangs. A CRITICAL knob: far back, every shape lenses the whole gradient into rainbow banding; close in (≈ −3) refraction reads as distortion of one continuous field.",
  "Camera distance": "Dolly distance from the look-at point, in world units.",
  // "kind" — motion vs shading model (bare "kind" = the shape's geometry, below).
  "Motion kind":
    'How this shape moves. Skewer rolls about a shared axis (the reference wave), spin turns in place, drift bobs. Motion belongs to the SHAPE — one scene-wide driver could only say "everything does the same".',
  "Material kind":
    "The shading model. Glass, frosted and glitter refract; metal, ceramic and plastic are opaque and never sample the refraction. The kind IS the model — there is no metalness slider, because 'metal turned down' is just plastic.",
  // Lamp rows: bare single-letter labels that exist nowhere else, plus "radius" vs a shape's.
  "lamp radius": "This lamp's Gaussian radius, in plate space (the backplate's 0–1 coordinates).",
  "lamp x":
    "Horizontal position in plate space — 0..1 spans the plate; a little outside is allowed.",
  "lamp y": "Vertical position in plate space.",
  "lamp color":
    "This lamp's colour. The reference palette is warm through magenta and blue-violet — measured from the reference frame, with no cyan at all.",
};

const SEP = " ";

const supportsPopover = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;
const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The affordance a hinted BUTTON gets: buttons can't wear the label's dotted underline without
 *  implying the whole control is hoverable-for-help, so they get a small info glyph instead —
 *  a separate, deliberate target, so hovering to read never competes with clicking to act.
 *  Drawn to match the panel's other inline icons (16 viewBox, currentColor stroke). */
const INFO_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.4v3.6"/>' +
  '<circle cx="8" cy="5" r=".9" fill="currentColor" stroke="none"/></svg>';

/**
 * Button titles are authored with a leading emoji, but applyIcons() swaps it for an SVG before we
 * read the text back — so a button's rendered label is its title MINUS the glyph. Index every
 * hint under that de-emoji'd form too.
 */
const HINTS_BY_RENDERED_TEXT: Map<string, string> = new Map(
  Object.entries(CONTROL_HINTS).map(([key, text]) => [
    key.replace(/^[^\p{L}\p{N}]+\s*/u, "").trim(),
    text,
  ]),
);

let tooltipEl: HTMLElement | null = null;
let currentAnchor: HTMLElement | null = null;
let hideTimer = 0;
/** Whether the most recent interaction was via keyboard. Gates the focus-reveal so a hint doesn't
 *  pop when a slider is clicked/dragged with the mouse (mirrors what :focus-visible does, but
 *  reliably — :focus-visible can still read false during the focusin event itself). */
let keyboardModality = false;
let listenersReady = false;

/** "Lamps · 10" → "Lamps", "lamp 3" → "lamp": one FOLDER_HINTS key covers every instance. */
function normalizeFolderTitle(title: string): string {
  return title
    .split("·")[0]
    .trim()
    .replace(/\s+\d+$/, "");
}

/** Resolve the hint text for a row, preferring a folder-qualified override (nearest folder first). */
function lookupHint(label: string, row: HTMLElement): string | undefined {
  let el: HTMLElement | null = row;
  while ((el = el.parentElement)) {
    if (el.classList.contains("tp-fldv")) {
      const title = normalizeFolderTitle(el.querySelector(".tp-fldv_t")?.textContent ?? "");
      const scoped = title && FOLDER_HINTS[`${title}${SEP}${label}`];
      if (scoped) return scoped;
    }
  }
  return CONTROL_HINTS[label] ?? HINTS_BY_RENDERED_TEXT.get(label);
}

/** Lazily create the one shared tooltip element. */
function getTooltip(): HTMLElement {
  if (tooltipEl) return tooltipEl;
  const tip = document.createElement("div");
  tip.id = "g3-tooltip";
  tip.setAttribute("role", "tooltip");
  if (supportsPopover) tip.setAttribute("popover", "manual");
  else tip.hidden = true;
  document.body.appendChild(tip);
  tooltipEl = tip;
  return tip;
}

/** Register the one-time global listeners: interaction-modality tracking + tooltip dismissers. */
function ensureGlobalListeners(): void {
  if (listenersReady) return;
  listenersReady = true;
  // Modality: any key press means "keyboard"; a pointer press means "mouse/touch". Pointer is
  // capture-phase so it lands before the focus it triggers.
  window.addEventListener("keydown", (e) => {
    keyboardModality = true;
    if (e.key === "Escape") hideNow(); // manual popovers don't light-dismiss
  });
  window.addEventListener(
    "pointerdown",
    () => {
      keyboardModality = false;
    },
    true,
  );
  window.addEventListener("resize", hideNow);
  // Capture phase so scrolling the inner panel reaches us. Keep the hint glued to its label as
  // the panel scrolls under the pointer (pointerleave handles the case where it scrolls away).
  window.addEventListener(
    "scroll",
    () => {
      if (currentAnchor) position(currentAnchor);
    },
    true,
  );
}

function openTip(tip: HTMLElement): void {
  if (supportsPopover) {
    if (!tip.matches(":popover-open")) {
      try {
        (tip as HTMLElement & { showPopover(): void }).showPopover();
      } catch {
        /* already open / not connected */
      }
    }
  } else {
    tip.hidden = false;
  }
}

function closeTip(tip: HTMLElement): void {
  if (supportsPopover) {
    if (tip.matches(":popover-open")) {
      try {
        (tip as HTMLElement & { hidePopover(): void }).hidePopover();
      } catch {
        /* already closed */
      }
    }
  } else {
    tip.hidden = true;
  }
}

/** Place the tooltip below the anchor, flipping above and clamping to the viewport as needed. */
function position(anchor: HTMLElement): void {
  const tip = getTooltip();
  const r = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = Math.min(r.left, vw - tw - margin);
  left = Math.max(margin, left);

  let top = r.bottom + gap;
  if (top + th > vh - margin) {
    const above = r.top - gap - th;
    top = above >= margin ? above : Math.max(margin, vh - th - margin);
  }

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function show(anchor: HTMLElement, text: string): void {
  window.clearTimeout(hideTimer);
  const tip = getTooltip();
  currentAnchor = anchor;
  tip.textContent = text;
  openTip(tip); // make it laid out so we can measure it
  position(anchor);
  if (prefersReducedMotion()) tip.classList.add("g3-tip-show");
  else requestAnimationFrame(() => tip.classList.add("g3-tip-show"));
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer);
  // Small grace period so a flick of the pointer off the label doesn't flicker it away.
  hideTimer = window.setTimeout(hideNow, 90);
}

function hideNow(): void {
  window.clearTimeout(hideTimer);
  currentAnchor = null;
  if (!tooltipEl) return;
  tooltipEl.classList.remove("g3-tip-show");
  closeTip(tooltipEl);
}

/** Hide any open hint. Called before a panel rebuild, since the anchor DOM is about to vanish. */
export function hideControlHint(): void {
  hideNow();
}

/**
 * Mark every hinted label in `container` with the underline affordance and wire its hover/focus
 * triggers. Idempotent per row (safe to re-run after each panel rebuild — Tweakpane hands us
 * fresh DOM each time, so old listeners are discarded with the old nodes). Run AFTER applyIcons,
 * which swaps leading emoji for SVGs: the icon contributes no text, so labels read clean here.
 */
export function applyControlHints(container: HTMLElement): void {
  ensureGlobalListeners();
  container.querySelectorAll<HTMLElement>(".tp-lblv").forEach((row) => {
    if (row.dataset.g3Hinted) return;
    // A labelled row hangs its hint off the label. A BUTTON row has no label (Tweakpane marks it
    // `tp-lblv-nol`), so key off the button's own text instead.
    const labelEl = row.querySelector<HTMLElement>(".tp-lblv_l");
    const btnLabel =
      (labelEl?.textContent ?? "").trim() === ""
        ? row.querySelector<HTMLElement>(".tp-btnv_t")
        : null;
    const keyEl = btnLabel ?? labelEl;
    if (!keyEl) return;
    const label = (keyEl.textContent ?? "").trim();
    if (!label) return;
    const text = lookupHint(label, row);
    if (!text) return;

    row.dataset.g3Hinted = "1";
    let anchor: HTMLElement;
    if (btnLabel) {
      // Give the button its own info glyph and anchor there, so hovering anywhere else on the
      // button — the whole point of which is to be clicked — stays quiet.
      const info = document.createElement("span");
      info.className = "g3-hint-info";
      info.innerHTML = INFO_ICON; // a constant, never user content
      info.setAttribute("role", "img");
      info.setAttribute("aria-label", `About ${label}`);
      // The glyph sits INSIDE the button, so a click on it would fire the button's action.
      info.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        show(info, text); // also makes it usable where there is no hover (touch)
      });
      btnLabel.append(info);
      anchor = info;
    } else {
      anchor = keyEl;
      anchor.classList.add("g3-has-hint");
    }
    anchor.addEventListener("pointerenter", () => show(anchor, text));
    anchor.addEventListener("pointerleave", scheduleHide);
    // Keyboard bonus: reveal the hint when the row's own control (already a tab stop, so no new
    // ones) receives focus via the keyboard. Gated on modality so it doesn't pop when a slider is
    // clicked/dragged with the mouse.
    row.addEventListener("focusin", () => {
      if (keyboardModality) show(anchor, text);
    });
    row.addEventListener("focusout", scheduleHide);
  });
}
