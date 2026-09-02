---
"materials-studio": minor
---

Make the beam editable, and the tuning loop batched.

- **A Beam folder in the control panel.** The one thing in the language that is _solved_ rather
  than shaded was the one thing the studio could not touch: `grep -c beam ControlPanel.ts` was 0,
  so aiming meant hand-editing JSON. Aiming is a search — the route through a chain of solids
  survives only a few degrees — and a search wants a slider and a live frame. Nothing here is
  structural: `refresh()` calls `applyBeam`, which re-traces from its own key.
- `entryAngle` and `entrySweep` are guarded inline, because `normalizeBeam` deliberately leaves
  them absent rather than seeding them — 0 is a real bearing and must not be confused with not
  having asked for one. The bindings audit now seeds a beam from `{}`, so every other beam field
  is checked to survive normalization.
- **`pnpm sweep <scene> <path>=<v,v,v>`** renders every variant into one labelled contact sheet
  from a single browser launch. One axis is a row; two make a grid. Tuning asks "which of these"
  far more often than "is this one right", and answering that one PNG at a time costs a launch and
  a page load per guess.
- **`pnpm preset:from <config.json> [--base <preset>]`** prints a tuned scene as pasteable source.
  `gallery:build` only ever went preset → JSON, so a scene tuned in the studio had no route back
  into `presets.ts`. It emits the difference against a base rather than the whole config: a dump of
  every field buries the three numbers that matter under two hundred defaults, and what a preset
  contains should be what somebody chose.
