---
"@materials3d/element": minor
---

Add a `fade-ms` attribute to `<materials-3d>`, exposing the shell's `fadeMs` option (poster→canvas crossfade duration, default 300ms). `fade-ms="0"` swaps with no crossfade, which is what you want once the poster and the first live frame match — a dissolve is visible precisely because it blends a frozen still against a scene that has kept animating. Previously only reachable through `createMaterials`, so element users had no way to tune it.

Also documents capturing posters at the device pixel ratio they will be displayed at: `snapshot()` returns the canvas backing store, so a headless capture at the default `deviceScaleFactor: 1` yields a poster at half the resolution a 2x display renders the live canvas at, and the handoff shows up as a sharpening.
