---
"@materials3d/core": patch
---

The `blob` shape's lumps come from simplex noise instead of a product of sines.

A product of sines has its zeros on a regular lattice and its extrema on another, so anything
displaced by it picks up structure aligned to the axes — which on the one shape whose entire job is
to read as organic is exactly the wrong artefact. Stacking octaves did not help, because every
octave shared the alignment.

`util/noise.ts` is a TypeScript transcription of Vercel's `@vgpu/wgsl-std` simplex (MIT — see
`THIRD-PARTY-NOTICES.md`), and two of their decisions are kept deliberately:

- **The kernel radius squared is 0.5, not the widespread 0.6.** At 0.6 the support radius exceeds
  the four-corner traversal's reach, so the corner the traversal drops still carries weight and
  dropping it is a C0 crack. At 0.5 that corner contributes exactly zero with vanishing first and
  second derivatives, so the field stays smooth across every simplex face.
- **Gradients come from an integer hash, not a permutation table**, giving a 2³²-cell period rather
  than the folklore period-289 float hash. That matters here because a blob is seeded, and a short
  period makes different seeds visibly rhyme.

The seed became a translation of the sample point rather than a parameter of the field, which is
what a lattice noise wants: two seeds are two regions of one infinite field, so they cannot rhyme
the way two phase offsets of the same sine can.

Sampled at 0.45× with two octaves rather than three, following the reference's own migration note —
simplex is a markedly higher-frequency field than the trig octaves it replaced (~2.5× the slope),
so the same coordinates gave a crumpled surface where the shape wants one or two broad lumps.

`noise.test.ts` pins the range bound (±0.98854, never clipped), continuity across a simplex face,
seed separability, and — the one that speaks to the actual defect — that the old sine field
autocorrelates above 0.9 at one period along an axis while simplex stays below 0.3.
