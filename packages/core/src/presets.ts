/**
 * Shipped scenes. Presets are the actual product for most users: the renderer has a lot of knobs
 * and only a narrow band of each is right.
 *
 * Kept in its own entry so a consumer that names one preset doesn't pull in the rest.
 */

import {
  BEAM_DISPERSION,
  createDefaultConfig,
  createMaterial,
  createShape,
  MATERIAL_KINDS,
  MATERIAL_PRESETS,
  SHAPE_KINDS,
  type CutConfig,
  type ItemInteractionBinding,
  type MaterialConfig,
  type SceneConfig,
  type ShapeConfig,
  type ShapeKind,
  type ItemConfig,
} from "./config/model";
import { KNOT_GLB } from "./knotMesh";

// Lives in the model now, next to `createBeam`, so the default beam and the named glasses cannot
// disagree. Re-exported here because this is where consumers have always found it.
export { BEAM_DISPERSION } from "./config/model";

/** The reference scene: flat-ended rods threaded on one shared horizontal axis, rolling in a
 *  staggered wave, warm-through-magenta lamps behind them and their bases lost in haze. Each rod
 *  also answers the cursor: hovering it swings the colour of the light it refracts around the
 *  hue wheel, easing back once the cursor moves on to the next one. */
export function skewer(): SceneConfig {
  const config = createDefaultConfig();
  if (config.scatter) {
    config.scatter.interaction = {
      // 0.4 of a turn is far enough that warm lamp light lands clearly in the blues and violets,
      // while staying short of the full-opposite flip that reads as a different scene. Well above
      // the default smoothing, so the colour blooms through the rod over a second or so, and
      // drains just as gently on leave, rather than snapping.
      bindings: [{ source: "hoverSelf", target: "hueShift", to: 0.4, smoothing: 0.6 }],
    };
  }
  return config;
}

/** Shared optics for the Assembly pieces: softer absorption than the rods, since these shapes
 *  are wide and would otherwise saturate to plastic, and each carries its own tint. */
const GLASSY = {
  density: 1.7,
  ior: 1.5,
  // Three knobs, all off, all for the same reason: an exploded view has to read as CUT.
  //
  // `lens` is the one that actually blurs. It displaces the background sample by up to
  // `lens * 3.4` of the frame, rim-weighted, which is the right effect for a thick lump of
  // glass, and exactly wrong for a thin plate whose whole subject is the slots cut through it:
  // every edge in frame smears the picture behind it. `dispersion` splits that same sample per
  // channel, so what survives the smear also fringes. And `emission` lifts the whole shape toward
  // the backdrop, which costs the contrast that makes an edge an edge.
  dispersion: 0,
  lens: 0,
  rim: 0.28,
  specular: 1,
  saturation: 1.12,
  emission: 0,
};

/** The hub the rest of the Assembly threads through: the same glass with the absorption almost
 *  gone, so it reads as a pale window you can see the other pieces *through* rather than as one
 *  more coloured plate. Rim and specular go up to compensate, with no absorption left, the
 *  silhouette and the sheen are the only things still saying "glass". */
const HUB_GLASS = {
  ...GLASSY,
  density: 0.55,
  // The rim is the ONLY thing left saying "glass" here, so it stays up, but as a tight edge,
  // not a halo. The shader loads it as `pow(1 - N·V, 3)`, which is already narrow; the old 0.95
  // pushed that narrow band bright enough to bloom over the slots it was supposed to define.
  rim: 0.4,
  specular: 1.2,
};

/**
 * The shaft the Assembly is threaded on: one line through the origin, running lower-left to
 * upper-right and tipped toward the camera.
 *
 * This is the whole preset. Shapes at unrelated positions read as parts laid out on a table; the
 * *same* shapes spaced along a single axis, necessarily overlapping, because one shaft runs
 * through all of them, read as one machine pulled apart. So nothing here is positioned freehand:
 * every piece is placed a distance ALONG this line, and only then nudged off it.
 */
const SPINE: [number, number, number] = [0.94, 0.2, 0.24];

/** Position `distance` units along {@link SPINE}, plus an offset off the shaft. Use the offset
 *  sparingly, it is what stops the stack reading as a rigid comb, and what breaks the read if a
 *  piece drifts far enough that the shaft no longer passes through it. */
function onSpine(
  distance: number,
  offset: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  return [
    SPINE[0] * distance + offset[0],
    SPINE[1] * distance + offset[1],
    SPINE[2] * distance + offset[2],
  ];
}

/**
 * Euler XYZ that aims a lathe's sweep axis, the face normal of a disc, ring or plate, along a
 * given direction, so a piece is authored by WHERE IT FACES instead of by three angles nobody can
 * picture.
 *
 * The camera looks down -Z, so `z` is the punchline: 1 is a coin flat to the lens, 0 is edge-on,
 * and everything between is the lean. That single number is what separates an exploded view from
 * a row of circles, and getting it by hand-tuning Euler triples is how the first pass ended up
 * with plates that were accidentally parallel.
 *
 * Solved, not searched. Leaving the Y term of the XYZ chain at zero gives
 * `Rx(a)·Rz(c)·(0,1,0) = (-sin c, cos c·cos a, cos c·sin a)`, which inverts directly:
 * `c = asin(-x)` and `a = atan2(z, y)` (`cos c` is never negative over asin's range, so the
 * atan2 needs no correction).
 */
function facing(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  const nx = Math.min(1, Math.max(-1, x / length));
  return [Math.atan2(z, y), 0, Math.asin(-nx)];
}

/**
 * A stadium slot: a rect whose corner radius has reached half its short side.
 *
 * Written out because every carve-out in this preset is one, and `{ kind: "rect", r: w / 2 }`
 * repeated six times buries the two numbers that actually differ between them.
 */
function slot(x: number, y: number, w: number, h: number): CutConfig {
  return { kind: "rect", x, y, w, h, r: Math.min(w, h) / 2, rotation: 0 };
}

function piece(
  shape: Partial<ReturnType<typeof createShape>> & { kind: ItemConfig["shape"]["kind"] },
  position: [number, number, number],
  rotation: [number, number, number],
  tint: string,
  material: Partial<ItemConfig["material"]> = {},
  scale: [number, number, number] = [1, 1, 1],
): ItemConfig {
  return {
    shape: { ...createShape(shape.kind), ...shape },
    position: { x: position[0], y: position[1], z: position[2] },
    rotation: { x: rotation[0], y: rotation[1], z: rotation[2] },
    scale: { x: scale[0], y: scale[1], z: scale[2] },
    material: { ...GLASSY, tint, ...material },
    // Every piece drifts; the phase that spreads them through the cycle (so the group breathes
    // rather than bobbing in lockstep) is stamped on by `assembly()`'s trailing map, per index.
    //
    // Half the rate and half the travel of an ordinary drift. These pieces are interlocked and
    // slotted through each other, so the motion has one job, keep the light moving across the
    // carve-outs, and any amplitude big enough to NOTICE is big enough to pull the stack apart.
    // Slow is what sells it: at this rate a piece takes half a minute to come back, which reads
    // as a room breathing rather than as an animation playing.
    motion: { kind: "drift", axis: "y", rate: 0.19, amount: 0.042 },
    phase: 0,
  };
}

/**
 * An exploded view: three slotted plates, a washer and a shaft, the same renderer, tinted
 * shapes, no scatter.
 *
 * Five pieces, not the seven this started with. Seven read as a heap: each one had to be small
 * enough to leave room for the rest, and at that size the carve-outs that give a plate its
 * character were a texture rather than a feature. Cutting to five buys every remaining piece
 * enough frame to be looked at, which is the whole point of an exploded view.
 */
export function assembly(): SceneConfig {
  return {
    ...createDefaultConfig(),
    background: "#eef2f8",
    backgroundMode: "gradient",
    backgroundPalette: [
      { color: "#e4ebf6", position: 0 },
      { color: "#fbfcfe", position: 1 },
    ],
    backgroundGradientType: "linear",
    backgroundGradientAngle: Math.PI / 2,
    clearGlass: "#f4f6fa",
    // Spread left-to-right rather than clustered, so the stack runs cool at one end and hot at the
    // other instead of every plate borrowing the same wash.
    lamps: [
      { x: 0.22, y: 0.62, r: 0.22, color: "#5f86ea", intensity: 1 },
      { x: 0.5, y: 0.44, r: 0.2, color: "#9b6fe0", intensity: 1 },
      { x: 0.79, y: 0.58, r: 0.18, color: "#f0803a", intensity: 1 },
    ],
    lampGain: 1.35,
    lampGate: { lo: 0.05, hi: 0.95 },
    plate: { z: -3, scale: { x: 26, y: 20 }, offset: { x: 0.5, y: 0.5 } },
    camera: { fov: 16, distance: 34, lookAt: { x: 1.2, y: -0.15, z: 0 }, height: 0.5 },
    measuredThickness: true,
    post: {
      ...createDefaultConfig().post,
      // Sharp everywhere: `aperture: 0` zeroes the circle of confusion, so the depth-of-field
      // gather collapses to the centre tap at every pixel. An exploded view is a diagram, the
      // piece at the back of the shaft is as much the subject as the one at the front, and
      // softening it just says "ignore this". `focus`/`range` are inert while the aperture is 0,
      // and are left at sane values so dialling one back in has somewhere to land.
      focus: 34,
      range: 11,
      aperture: 0,
      // Haze and bloom are the post-stack half of the same softness the materials had: a wash
      // over the finished frame that lifts the blacks and glows the edges. A trace of each is
      // worth keeping, it is what stops the plates looking pasted onto the backdrop, but not
      // enough to see.
      bloom: 0.008,
      caustics: 0,
      haze: 0.03,
      hazeTop: 0.03,
      hazeColor: "#f7f9fc",
      vignette: 0.18,
      grain: 0.01,
    },
    scatter: undefined,
    items: [
      // The hub: the biggest piece, almost flat to the lens, and the one everything else passes
      // through. Nearly clear on purpose, a second opaque plate here would just hide the stack.
      // Two slots carry the light straight through it, which is what a clear piece has instead of
      // a colour: an edge that catches.
      piece(
        {
          kind: "slab",
          len: 6.1,
          thickness: 6.4,
          depth: 0.7,
          r: 1.5,
          cuts: [slot(-1.5, 0.1, 0.75, 4.3), slot(1.5, 0.1, 0.75, 4.3)],
        },
        onSpine(0, [-0.2, -0.35, -1.7]),
        [0.1, -0.16, 0.06],
        "#a6cbee",
        HUB_GLASS,
      ),
      // Left of the hub: a slotted tile, leaning away rather than aimed by `facing`. A slab is
      // authored flat to the lens like the arrow, so it is posed by turning it OFF the camera,
      // and three parallel slots are what turn a plate into a component.
      piece(
        {
          kind: "slab",
          len: 4.4,
          thickness: 5.6,
          depth: 0.62,
          r: 1.05,
          cuts: [
            slot(-1.15, -0.2, 0.56, 3.3),
            slot(0, -0.2, 0.56, 3.3),
            slot(1.15, -0.2, 0.56, 3.3),
          ],
        },
        onSpine(-4.5, [0.1, 1.0, 1.5]),
        [0.22, -0.6, 0.16],
        "#4d7be6",
        { density: 1.1 },
      ),
      // The shaft. Long enough to enter at one end of the stack and leave at the other, which is
      // what actually sells "these are on one shaft", and a plain rod, not the arrow this preset
      // used to carry: with seven pieces an arrowhead was one detail among many, but at five it
      // is the loudest thing in frame and reads as clip art rather than as hardware.
      piece(
        { kind: "rod", r: 0.34, len: 15 },
        onSpine(1.2, [0, 0.1, 1.4]),
        facing(0.94, 0.2, 0.24),
        "#8b6cf0",
        { density: 1.5 },
      ),
      // A washer, on the shaft and square to it, nearly edge-on, so it reads as a band around
      // the arrow rather than as another plate. The cheapest possible "this is hardware" cue, and
      // the only small piece left now that the stack is down to five.
      piece(
        { kind: "ring", r: 1.45, hole: 0.72, thickness: 0.5 },
        onSpine(2.8, [0, 0.15, 1.5]),
        facing(0.94, 0.2, 0.26),
        "#6f95f0",
      ),
      // Right of the hub: the second tile, leaning the other way so the row turns through
      // edge-on and back instead of leaning the same way twice. A window and a port rather than
      // three slots, the same vocabulary, not the same part.
      piece(
        {
          kind: "slab",
          len: 4.1,
          thickness: 4.6,
          depth: 0.58,
          r: 0.95,
          cuts: [
            { ...slot(0, 0.62, 2.5, 0.62) },
            { kind: "circle" as const, x: 0, y: -1.15, w: 1.2, h: 1.2, r: 0.6, rotation: 0 },
          ],
        },
        onSpine(5.6, [0.2, -1.3, -2.6]),
        [-0.18, 0.64, -0.1],
        "#e9683c",
        { density: 1.05 },
      ),
    ].map((item, index) => ({ ...item, phase: index * 1.7 })),
  };
}

/**
 * Slime optics: `liquid`, but thicker than water everywhere it matters.
 *
 * A shorter, choppier ripple that reads as surface tension rather than open water; a slow `flow`
 * so it oozes instead of sloshing; enough absorption that each blob keeps the colour it was given
 * instead of washing out to whatever lamp is behind it; and a thin film, because the giveaway of
 * something gooey is the oily sheen sliding over the highlight. Each item supplies its own tint,
 * nothing else varies, which is what keeps seven wildly different colours reading as one material.
 */
const GOO = {
  kind: "liquid" as const,
  ior: 1.38,
  density: 1.55,
  dispersion: 0.03,
  ripple: 0.62,
  rippleScale: 2.1,
  flow: 0.45,
  rim: 0.72,
  specular: 1.3,
  saturation: 1.22,
  emission: 0.06,
  iridescence: 0.26,
  filmNm: 340,
};

/**
 * One gob of the stuff: wobbling, volume-preserving.
 *
 * `path` is pinned to a fraction of the radius rather than left to the geometry default. A blob's
 * derived path is its full radius, which at this density saturates the middle to near-black and
 * throws away the whole point of the colour, the same override every sphere in these presets
 * needs, for the same reason.
 */
function slime(
  shape: Partial<ReturnType<typeof createShape>> & { kind: ItemConfig["shape"]["kind"] },
  position: [number, number, number],
  rotation: [number, number, number],
  tint: string,
  amount = 0.14,
  material: Partial<ItemConfig["material"]> = {},
): ItemConfig {
  const resolved = { ...createShape(shape.kind), ...shape };
  return {
    shape: resolved,
    position: { x: position[0], y: position[1], z: position[2] },
    rotation: { x: rotation[0], y: rotation[1], z: rotation[2] },
    scale: { x: 1, y: 1, z: 1 },
    material: { ...GOO, tint, path: resolved.r * 0.42, ...material },
    motion: { kind: "wobble", axis: "y", rate: 0.9, amount },
    phase: 0,
  };
}

/** Blobs, droplets and beads of something viscous and far too brightly coloured, the `liquid`
 *  kind pushed past water, one hue per gob. */
export function slimes(): SceneConfig {
  return {
    ...createDefaultConfig(),
    background: "#f1f0ee",
    clearGlass: "#f5f4f2",
    // Deliberately pale and broad. The gobs carry the colour themselves, so a saturated lamp
    // field would only fight them; what the lamps are here for is the wet highlight.
    lamps: [
      { x: 0.32, y: 0.58, r: 0.24, color: "#ffd08a", intensity: 1 },
      { x: 0.58, y: 0.44, r: 0.2, color: "#e879c8", intensity: 0.95 },
      { x: 0.78, y: 0.64, r: 0.18, color: "#7fd4f0", intensity: 0.95 },
    ],
    lampGain: 1.4,
    lampGate: { lo: 0.06, hi: 0.94 },
    plate: { z: -3, scale: { x: 26, y: 20 }, offset: { x: 0.5, y: 0.5 } },
    camera: { fov: 16, distance: 38, lookAt: { x: 0, y: 0, z: 0 }, height: 0.5 },
    // Blobs and droplets are exactly the shapes the analytic chord guesses worst.
    measuredThickness: true,
    post: {
      ...createDefaultConfig().post,
      focus: 38,
      range: 9,
      aperture: 11,
      bloom: 0.03,
      caustics: 0.14,
      haze: 0.08,
      hazeTop: 0.08,
      hazeColor: "#f6f5f3",
      vignette: 0.16,
      grain: 0.012,
    },
    scatter: undefined,
    items: [
      slime({ kind: "blob", r: 2, seed: 7, bump: 0.85 }, [-5.4, 0.2, 0], [0.2, 0.7, 0], "#8ede3c"),
      slime(
        { kind: "droplet", r: 1.5, len: 3.5 },
        [-2.4, -2.3, 1.7],
        [0, 0, 0.08],
        "#f04fae",
        0.12,
      ),
      slime(
        { kind: "blob", r: 1.7, seed: 12, bump: 0.78 },
        [0.2, 1, -1],
        [0.3, 2.1, 0.2],
        "#3fd2e6",
        0.15,
      ),
      slime(
        { kind: "droplet", r: 1.15, len: 2.7 },
        [2.8, -2.3, 0.8],
        [0, 0, -0.12],
        "#ff9130",
        0.11,
      ),
      slime(
        { kind: "blob", r: 1.9, seed: 21, bump: 0.9 },
        [5.2, 0.1, -0.4],
        [0.1, 2.8, 0.3],
        "#9a5ff0",
        0.13,
      ),
      slime({ kind: "sphere", r: 1 }, [-6.9, -2.6, 1.2], [0, 0, 0], "#f5d63c", 0.16),
      slime(
        { kind: "blob", r: 1.05, seed: 33, bump: 0.95 },
        [7.1, -2.6, 1.4],
        [0.4, 1.2, 0],
        "#ff5f7a",
        0.17,
      ),
    ].map((item, index) => ({ ...item, phase: index * 1.9 })),
  };
}

/** One labelled probe for the reactions scene: its name is the parameter its hover binding
 *  drives, so the studio's shape list doubles as the legend. */
function probe(
  name: string,
  shape: Partial<ReturnType<typeof createShape>> & { kind: ItemConfig["shape"]["kind"] },
  position: [number, number],
  rotation: [number, number, number],
  material: Partial<ItemConfig["material"]>,
  binding: NonNullable<NonNullable<ItemConfig["interaction"]>["bindings"]>[number],
): ItemConfig {
  return {
    name,
    shape: { ...createShape(shape.kind), ...shape },
    position: { x: position[0], y: position[1], z: 0 },
    rotation: { x: rotation[0], y: rotation[1], z: rotation[2] },
    scale: { x: 1, y: 1, z: 1 },
    // Dispersion and emission start at zero so the probes that drive them start from nothing;
    // `path` is left to the geometry unless a shape over-absorbs (see the sphere note below).
    material: { ior: 1.45, dispersion: 0, emission: 0, ...material },
    motion: { kind: "none", axis: "x", rate: 0, amount: 0 },
    interaction: { bindings: [{ smoothing: 0.3, ...binding }] },
    phase: 0,
  };
}

/**
 * Near face-on: a lathe's sweep axis pointed almost at the camera, so a disc reads as a coin
 * rather than a line. Almost, not exactly, dead-on, a disc is a circle indistinguishable from
 * the spheres two cells over, and the few degrees of lean are what put a lit edge band on it.
 */
const FLAT: [number, number, number] = [1.32, 0, 0.1];
/** A lathe standing on its axis. `spin` turns it about that axis, which for the low-segment
 *  prisms decides how many facets face the camera, the difference between a hexagon and a
 *  rectangle. */
function upright(spin = 0): [number, number, number] {
  return [0, spin, 0];
}

/**
 * A legend, not a composition: twelve probes, each named for the ONE parameter its hover reaction
 * drives. Rest the cursor on a shape and THAT probe sweeps to its `to` value (`hoverSelf`, the
 * renderer raycasts the cursor); move off and it eases back. Walk the grid to see what each
 * binding target actually looks like, one at a time.
 *
 * Every probe used to be the same sphere, on the theory that a constant shape isolates the
 * variable. It does, but a sphere is the worst demonstrator for half of these, so each probe now
 * gets the primitive that shows ITS parameter best, and the grid doubles as a tour of all eleven
 * shape kinds.
 *
 * PICK THE SHAPE FROM THE SHADER, NOT FROM THE WORD. The first pass at this chose shapes by what
 * the parameter is *called*, dispersion is an edge effect, so a ring; rim traces a silhouette, so
 * a blob; a cone sweeps every angle, so specular. Four of the twelve then did visibly nothing at
 * all, because what a parameter needs is set by the line of GLSL that consumes it:
 *
 *   - `dispersion` splits three refracted rays and samples the plate with each, so it shows only
 *     where the surface BENDS hard. A plate held face-on barely refracts and all three rays land
 *     on the same texel.
 *   - `rim` and `ripple` are gated on N·V near zero, so they need GRAZING area, not a big flat
 *     face, which is all N·V ≈ 1 and where tilting a normal changes nothing.
 *   - `specular` is a `pow(…, 140)` lobe that fires only where a fragment's mirror direction lands
 *     on the key light. A cone's normals are a single one-parameter family and can miss it
 *     entirely, and three times zero is still zero.
 *
 * Each probe below carries the reason it is the shape it is. When one stops reacting, that note is
 * the first place to look.
 */
export function reactions(): SceneConfig {
  const xs = [-6.75, -4.05, -1.35, 1.35, 4.05, 6.75];
  const top = 1.95;
  const bottom = -1.95;
  return {
    ...createDefaultConfig(),
    background: "#f0efed",
    clearGlass: "#f3f2f1",
    lamps: [
      { x: 0.3, y: 0.35, r: 0.26, color: "#f0803a", intensity: 0.95 },
      { x: 0.62, y: 0.62, r: 0.26, color: "#6f8ce8", intensity: 0.95 },
      { x: 0.85, y: 0.3, r: 0.2, color: "#d85fa8", intensity: 0.85 },
    ],
    lampGain: 1.35,
    lampGate: { lo: 0.04, hi: 0.96 },
    plate: { z: -3, scale: { x: 26, y: 20 }, offset: { x: 0.5, y: 0.5 } },
    camera: { fov: 16, distance: 38, lookAt: { x: 0, y: 0, z: 0 }, height: 0.2 },
    // Touch has no hover, but with the opt-in a held finger drives presence + the raycast, so
    // tapping a probe fires its hoverSelf reaction on phones too.
    interaction: { touch: true },
    measuredThickness: true,
    post: {
      ...createDefaultConfig().post,
      focus: 38,
      range: 20,
      aperture: 6,
      bloom: 0.015,
      caustics: 0,
      haze: 0,
      hazeTop: 0,
      vignette: 0.12,
      grain: 0.01,
    },
    scatter: undefined,
    items: [
      // A rod IS optical path: absorption over a length you can see end to end.
      probe(
        "density",
        { kind: "rod", r: 0.75, len: 2.6 },
        [xs[0], top],
        upright(),
        { density: 0.4 },
        { source: "hoverSelf", target: "density", to: 7 },
      ),
      // The lens ball. A sphere's derived path is its radius, which over-absorbs badly, the
      // chord collapses far faster off-axis than the rim cheat models, so it is dialled back by
      // hand. This is exactly what the override exists for.
      probe(
        "ior",
        { kind: "sphere", r: 1.05 },
        [xs[1], top],
        upright(),
        { ior: 1.03, density: 1.2, path: 0.55 },
        { source: "hoverSelf", target: "ior", to: 1.9 },
      ),
      // Dispersion needs REFRACTION, not edges. The shader splits three rays at three IORs and
      // samples the plate with each, so what you see is how far apart those three hit points land
      //, and a flat plate held face-on barely bends any of them, so all three sample the same
      // texel and the swing does nothing at all. That is what a face-on ring was doing here. A
      // cone's flank is steeply inclined to the view everywhere, which is where the bend lives.
      probe(
        "dispersion",
        { kind: "cone", r: 0.95, len: 2.3 },
        [xs[2], top],
        upright(),
        { density: 1.2 },
        { source: "hoverSelf", target: "dispersion", to: 0.5 },
      ),
      // Rim-loaded displacement needs a flat middle to stay undistorted against.
      probe(
        "lens",
        { kind: "disc", r: 1.2, thickness: 0.5 },
        [xs[3], top],
        FLAT,
        { density: 1.2, lens: 0 },
        { source: "hoverSelf", target: "lens", to: 0.28 },
      ),
      // Rim is a SILHOUETTE effect, and on the transmissive path a very narrow one: the shader
      // gates it on `smoothstep(0.90, 1.0, 1 - N·V)`, so it only paints where the surface is
      // within about six degrees of edge-on. On a sphere or a blob that is the outer fraction of
      // a percent of the radius, a couple of pixels, which is why swinging it to 1 on a blob
      // looked like nothing happening. A ring gives it TWO silhouettes to trace, inner and outer,
      // and `to: 3` overdrives the mix so the band it does paint is unmistakable.
      probe(
        "rim",
        { kind: "ring", r: 1.15, hole: 0.62, thickness: 0.6 },
        [xs[4], top],
        FLAT,
        { density: 1.2, rim: 0 },
        { source: "hoverSelf", target: "rim", to: 3 },
      ),
      // The specular lobe is `pow(dot(reflect(-V, N), KEY), 140)`, needle-sharp, and it only
      // fires where some fragment's mirror direction lands almost exactly on the key light. A
      // cone cannot do that: its normals form a single one-parameter family that can miss the key
      // entirely, and then the whole term is zero and multiplying it by three is still zero. A
      // blob's lumps sweep normals in every direction, so several fragments always catch it.
      probe(
        "specular",
        { kind: "blob", r: 1.1, seed: 5, bump: 0.55 },
        [xs[5], top],
        upright(),
        { density: 1.2, specular: 0, path: 0.5 },
        { source: "hoverSelf", target: "specular", to: 3 },
      ),
      probe(
        "saturation",
        { kind: "hex", r: 0.95, len: 2.2 },
        [xs[0], bottom],
        upright(0.5),
        { density: 2.5, saturation: 0.3 },
        { source: "hoverSelf", target: "saturation", to: 1.9 },
      ),
      // Emission is a flat additive, `col += lit * trans * uEmis`, so it reads on anything.
      // That makes it the right home for the one shape kind nothing else in the grid needs, which
      // is how the legend ends up covering all eleven.
      probe(
        "emission",
        { kind: "slab", len: 1.9, thickness: 2.1, depth: 0.5, r: 0.35 },
        [xs[1], bottom],
        [0.2, 0.34, 0.08],
        { density: 2 },
        { source: "hoverSelf", target: "emission", to: 0.6 },
      ),
      // Waves do NOT need a big flat face, that was the mistake here. The ripple field tilts the
      // surface normal, and a plate held face-on is all N·V ≈ 1, where tilting a normal by a few
      // degrees changes nothing you can see: the swing only wobbled the silhouette. What shows a
      // ripple is GRAZING incidence, where the same tilt swings N·V hard and takes the Fresnel
      // term with it. A droplet's flanks run through those angles all the way round.
      probe(
        "ripple",
        { kind: "droplet", r: 1, len: 2.5 },
        [xs[2], bottom],
        upright(),
        {
          kind: "liquid",
          ior: 1.33,
          density: 1.2,
          ripple: 0,
          rippleScale: 5,
          flow: 1.4,
          path: 0.6,
        },
        { source: "hoverSelf", target: "ripple", to: 1 },
      ),
      // Five flat facets, five different angles to the light, five film bands at once.
      probe(
        "iridescence",
        { kind: "prism", r: 1, len: 2.1, sides: 5 },
        [xs[3], bottom],
        upright(0.42),
        { density: 0.8, iridescence: 0, filmNm: 420 },
        { source: "hoverSelf", target: "iridescence", to: 1 },
      ),
      // Film thickness is read off a continuous sweep of angles, which is a sphere's whole job.
      probe(
        "film (nm)",
        { kind: "sphere", r: 1.05 },
        [xs[4], bottom],
        upright(),
        { density: 0.8, iridescence: 0.85, filmNm: 150, path: 0.55 },
        { source: "hoverSelf", target: "filmNm", to: 1000 },
      ),
      // Pointing the way it is about to go.
      probe(
        "position Y",
        { kind: "arrow", len: 2.4, shaft: 0.4, head: 1, depth: 0.55 },
        [xs[5], bottom],
        [0, 0, -Math.PI / 2],
        { density: 2 },
        { source: "hoverSelf", target: "positionY", to: -0.55 },
      ),
    ],
  };
}

// ---------------------------------------------------------------- staircase ---

/**
 * How many treads the spiral carries, and the number the whole preset is really tuned around.
 *
 * THE CONSTRAINT: no two treads may overlap on screen. That is not a stylistic preference, it is
 * what separates a staircase from a heap of tiles, and it is far tighter than it looks. Two treads
 * a full turn apart share an x and differ only by the descent, so the drop per tread has to exceed
 * a tread's PROJECTED height, its thickness foreshortened by {@link TILT} plus the camera's own
 * downward angle. Miss that and the run collides with itself at the two points per turn where the
 * helix doubles back, which is exactly where it used to.
 *
 * Thirty-four treads over a 28-unit descent gave 0.85 units a step against a projected height near
 * 2.0, and thirty-five of the visible pairs overlapped. Twenty over 34 units gives 1.79 a step,
 * which clears. Everything else here, the low tilt, the wide radius, the shallow taper, is in
 * service of the same inequality.
 */
const TREADS = 20;
/** Radians between successive treads, about 41°, so between eight and nine make a full turn and
 *  these twenty make a little over two. This one is bounded from BOTH sides: wider steps swing
 *  consecutive treads so far apart that the run stops reading as a sequence and becomes scattered
 *  tiles, and narrower ones need more treads to cover the same descent, which walks straight back
 *  into the overlap {@link TREADS} exists to avoid. */
const TURN = 0.72;
/**
 * Where the top tread sits on the circle.
 *
 * NOT a quarter turn, which is the obvious choice and the wrong one: at exactly π/2 a tread's
 * radial long axis points straight down the lens and it renders as a vertical sliver. Offset far
 * enough off the front of the circle that the hero shows a face.
 */
const START = 1.05;
/**
 * How far each tread tips back from level, toward the camera.
 *
 * Low, about 11°, and pulled down from the 30° this used to run at, because tilt is the single
 * biggest term in a tread's projected height: tipping a plate toward the lens is exactly how you
 * make it taller on screen, and taller treads are what collide. Eleven degrees on top of the
 * camera's own 14° of downward look still shows each tread a face rather than an edge, which is
 * the floor the other direction. See the note in {@link tread}.
 */
const TILT = 0.45;

/**
 * The optics every tread shares.
 *
 * NO `tint`, deliberately. A tint does not blend with the lamps in proportion to absorption, the
 * glass shader does `lit = mix(lit, uTint, uUseTint)`, so setting one REPLACES the lamp field
 * outright and forces the plate coverage to 1. Sixteen tinted treads are sixteen painted objects
 * and the spiral goes monochrome whatever `density` says. Left untinted they each take the colour
 * of the lamp behind them, so the descent runs warm at the top through to cool at the far end,
 * which is the library's whole argument, and free.
 */
const TREAD_GLASS = {
  density: 1.6,
  ior: 1.47,
  // Same reasoning as Assembly's {@link GLASSY}, and it bites harder here: thirty-four treads
  // overlap, so every smeared edge is smearing another tread rather than the backdrop, and the
  // softness compounds down the run. Off, the far treads stay legible plates.
  dispersion: 0,
  lens: 0,
  rim: 0.3,
  specular: 1.15,
  saturation: 1.16,
  emission: 0,
};

/**
 * The hover every tread shares: the same rotation of its transmitted colour, and a lift in
 * emission so it reads as lighting up rather than merely changing hue. Slow enough to bloom over
 * about a second and drain as gently, rather than snapping.
 *
 * Worth knowing what this can and cannot be. `hueShift` ROTATES whatever a shape is already
 * transmitting, so every tread moves by the same amount but none of them arrive at the same place.
 * Landing them all on one identical colour is not expressible: the only absolute colour a shape
 * has is `tint`, and `uUseTint` is not a bindable target, a shape either takes the lamps or takes
 * its tint, with nothing in between and no way to cross over at runtime. Monochrome spiral or
 * lamp-coloured spiral; the hover is uniform either way.
 */
const TREAD_HOVER: ItemInteractionBinding[] = [
  { source: "hoverSelf", target: "hueShift", to: 0.38, smoothing: 0.55 },
  { source: "hoverSelf", target: "emission", to: 0.34, smoothing: 0.55 },
];

/**
 * One tread on a conical helix, `t` running 0 at the top to 1 at the bottom.
 *
 * The taper is doing the work the brief asks for: radius, scale and vertical drop all shrink as
 * the spiral descends, so the top of the staircase is big and near, the hero, and the bottom
 * recedes. Perspective alone would not be enough at this focal length, and a cylindrical helix of
 * equal treads reads as a barrel rather than as something going away.
 *
 * ORIENTATION. A slab is authored flat to the lens, so a tread needs laying down and then aiming
 * outward. Euler XYZ applies Z first and X last, which is exactly the order wanted: `Rz(-angle)`
 * spins the slab within its own plane, then `Rx(-90°)` tips that plane to horizontal, leaving a
 * level tread whose long axis points radially out from the axis of the spiral, like a real one.
 */
function tread(index: number): ItemConfig {
  const t = index / (TREADS - 1);
  const angle = START + index * TURN;
  // Steep. Perspective does most of the trailing-off, and this rides with it rather than fighting
  // it: the last tread is a third the size of the first before the lens touches it. It also buys
  // clearance, the descent per tread is constant, so a tread that shrinks as it falls has an
  // easier time staying clear of its neighbours than one that does not.
  const shrink = 1 - 0.82 * t;
  // Wide, and barely tapered. Radius is what spreads the run ACROSS the frame, and horizontal
  // separation is the cheapest clearance there is: two treads far apart in x cannot overlap
  // whatever their heights. Pulling the far end in hard, this was 0.42, buys recession at the
  // cost of squeezing the lower treads back onto one another.
  const radius = 4.8 * (1 - 0.12 * t);
  // Linear, and 1.79 units a step. That number is the whole game (see {@link TREADS}): it has to
  // stay above a tread's projected height or the run overlaps itself where the helix doubles back.
  // Even spacing is also what a real stair has, and it keeps a little over two turns in view at
  // rest, the point at which the eye stops seeing a curve and starts seeing a helix.
  // PACED, not linear: the descent is spent in proportion to how big the tread is, so the gap
  // after the hero is wide and the gaps close up as the run shrinks away. A linear drop at this
  // framing puts tread 2 straight through the hero.
  const y = 5.5 - 34 * t;
  // The axis of the spiral is VERTICAL, like a real staircase's, so depth comes from the helix
  // itself and not from marching the run away from the lens. Pushing it back along Z instead,
  // the obvious way to make something recede, aims the spiral's axis at the camera, and a helix
  // seen down its own axis is a ring: sixteen plates around an empty middle, no descent at all.
  // A little recession on top of the descent, for the same reason as the taper: it guarantees the
  // far end is further away rather than merely lower. Kept well under the radius so the spiral's
  // axis stays vertical, push it harder and the helix aims at the camera and reads as a ring.
  const z = Math.sin(angle) * radius - 5 * t;

  return {
    name: `tread ${index + 1}`,
    shape: {
      ...createShape("slab"),
      // Slab X is the radial length of the step, slab Y its tangential width, and slab DEPTH
      // becomes the vertical thickness once the tread is laid down. Close to square on purpose:
      // a long thin tread vanishes to a sliver at the two points on the circle where it points at
      // the lens, and a spiral parades every tread through both of them.
      len: 4.6 * shrink,
      thickness: 3.9 * shrink,
      depth: 0.72 * shrink,
      r: 0.84 * shrink,
    },
    position: { x: Math.cos(angle) * radius, y, z },
    // A LEVEL tread is the wrong call, however literal. Seen from anywhere near its own height a
    // horizontal plate is edge-on, sixteen slivers, no glass. Tipping each one back toward the
    // camera trades staircase geometry for the faces that carry the refraction, which is the only
    // reason to render this in glass at all.
    // The tilt grows with depth: a tread far down the run is seen from further above, so a fixed
    // angle would turn the far end edge-on again just as the near end reads correctly. Safe to
    // ramp here and not at the top precisely because those treads have shrunk, the extra
    // projected height it costs is taken out of a much smaller plate.
    rotation: { x: -Math.PI / 2 + TILT + 0.26 * t, y: 0, z: -angle },
    scale: { x: 1, y: 1, z: 1 },
    material: { ...TREAD_GLASS },
    // Drift, not spin. `spin` adds `phase` straight onto the rotation it drives, so giving each
    // tread its place on the helix as a phase, the obvious way to make the motion travel down the
    // run, rotates every tread about Y by its own helix angle and destroys the radial aim set
    // just above. Drift spends phase on POSITION instead, so the wave travels and the aim holds.
    //
    // The amplitude is capped by the same no-overlap rule as everything else: drift moves treads
    // along Y, adjacent ones are out of phase, so twice this has to stay well inside the 1.79
    // units between them.
    motion: { kind: "drift", axis: "y", rate: 0.17, amount: 0.12 },
    phase: angle,
    interaction: {
      bindings: [
        ...TREAD_HOVER,
        // Full-page: scrolling lifts the whole spiral, so the page descends the staircase. There
        // is no camera target for this, `positionY` per shape is the same motion from the other
        // end, and `to` is absolute, hence each tread carrying its own destination.
        { source: "scroll", target: "positionY", to: y + 36, smoothing: 0.12 },
      ],
    },
  };
}

/**
 * A glass spiral staircase falling away down the page.
 *
 * Twenty near-clear treads on a little over two turns of a helix: big and near at the top where a
 * hero sits, shrinking as it winds away below. No two treads overlap on screen, see
 * {@link TREADS} for why that one rule sets almost every number in here. Scroll travels down it;
 * hovering any tread lights it up.
 */
export function staircase(): SceneConfig {
  return {
    ...createDefaultConfig(),
    background: "#f2f1f4",
    backgroundMode: "gradient",
    backgroundPalette: [
      { color: "#fbfaFc", position: 0 },
      { color: "#e7e6ee", position: 1 },
    ],
    backgroundGradientType: "linear",
    backgroundGradientAngle: Math.PI / 2,
    clearGlass: "#f6f5f8",
    // Stacked vertically rather than spread across, because the composition is vertical: a tread
    // takes its colour from the lamp at its own height, so the spiral runs warm at the top through
    // to cool at the far end and the descent reads as going somewhere.
    lamps: [
      // Placed against the new mapping: plate y = worldY / 64 + 0.5, so these sit at roughly
      // world +6, −4, −13 and −21, one lamp per stretch of the descent.
      { x: 0.5, y: 0.545, r: 0.1, color: "#f79a34", intensity: 1.4 },
      { x: 0.565, y: 0.47, r: 0.09, color: "#ea4f7d", intensity: 1.15 },
      { x: 0.44, y: 0.4, r: 0.09, color: "#8a63e0", intensity: 1.05 },
      { x: 0.525, y: 0.33, r: 0.085, color: "#5f8ae6", intensity: 0.95 },
    ],
    lampGain: 1.4,
    lampGate: { lo: 0.04, hi: 0.96 },
    // Behind the deepest tread, and TALL enough to reach the bottom of the run. The plate is
    // sampled as `world.xy / scale + offset`, so its height is a world-space window: at 34 units
    // it spanned y −17..17 while the spiral descends to −23.5, and every tread past the bottom
    // edge sampled outside the field and rendered as clear white glass. The colour draining out of
    // the lower half of a long scene is always this, not the lamps.
    plate: { z: -22, scale: { x: 108, y: 128 }, offset: { x: 0.5, y: 0.5 } },
    // Close and SHORT, 50° where the other presets use 16-24°, but only gently above level.
    //
    // The short lens is what makes the run trail off, and it is not interchangeable with a longer
    // one further back. Foreshortening is a ratio of DISTANCES, so a long lens far away renders
    // near and far treads at nearly the same size however steeply the scale ramp falls. Backing
    // off to 17 units to buy clearance did exactly that: the geometry stayed legal and the hero
    // stopped being a hero, because the first tread was no longer meaningfully closer than the
    // last. From 13 the first tread is around two and a half times nearer than the last visible
    // one, and a wide lens spends all of that on size. Clearance is bought in the helix instead,
    // see {@link TREADS}.
    //
    // The ANGLE is constrained, though, and not by taste. The lamp field is a vertical plane
    // behind the scene, so refracted rays only find it while the camera is looking roughly into
    // the scene rather than down at it. Tipped down the shaft, the obvious shot for a spiral,
    // the rays miss the plate entirely and every tread renders as near-white clear glass. Roughly
    // 28° below horizontal is as steep as this architecture goes before the colour drains out.
    camera: { fov: 46, distance: 13, lookAt: { x: -0.9, y: 1.05, z: 0 }, height: 4.2 },
    measuredThickness: true,
    post: {
      ...createDefaultConfig().post,
      // Sharp the whole way down. Defocus was doing the trailing-off here, but at fov 50 the run
      // covers a lot of depth and the far treads went to mush, losing the geometry that IS the
      // preset. Scale and haze already carry the recession, so `aperture: 0` collapses the
      // depth-of-field gather to its centre tap and every tread stays readable. `focus`/`range`
      // are inert while the aperture is 0, and are left at sane values so dialling one back in
      // has somewhere to land.
      focus: 6,
      range: 14,
      aperture: 0,
      // Haze stays higher than Assembly's and is doing a job here rather than being decoration:
      // it is the aerial perspective that carries the recession now that defocus does not, and
      // the run descends far enough for that to be worth real depth cueing. Bloom does not get
      // the same pass, it was glowing every tread edge into the one behind it.
      bloom: 0.012,
      caustics: 0.04,
      haze: 0.07,
      hazeTop: 0.03,
      hazeColor: "#f7f6fa",
      vignette: 0.2,
      grain: 0.01,
    },
    scatter: undefined,
    items: Array.from({ length: TREADS }, (_, index) => tread(index)),
  };
}

/**
 * A white beam entering a triangular prism and leaving as a spectrum, on black.
 *
 * The one preset in this set that is not lit by the lamp field. Everything else here is a pale
 * studio with colour living behind the glass; this is a dark room with a single traced ray, and
 * the colour is *made* at the glass rather than sampled through it. It exists because that is a
 * thing this renderer could not do until the beam tracer landed, and because it is the clearest
 * possible demonstration of what `dispersion` actually means, the rods show it as a coloured
 * fringe, and here it is the entire subject.
 *
 * The numbers that matter and why:
 *
 *   - The item and the beam share `r` and `sides`. They are separate systems, one builds a lathe,
 *     the other traces a polygon, and if those two disagree the rainbow leaves from a face that
 *     is not there. `beam.rotation` (π/2, a vertex at the top) matches the item's -90° X rotation.
 *   - The beam enters ABOVE centre and aimed slightly down, so it crosses the left face and exits
 *     through the right rather than the base. Aim it at the middle and it exits the bottom edge
 *     into the frame's corner, which is the same optics and a much worse picture.
 *   - `aperture` is low. A traced beam is a thin filament; a wide circle of confusion turns it
 *     into a smear and loses the one hard edge the composition has.
 */
export function prism(): SceneConfig {
  const d = createDefaultConfig();
  return {
    ...d,
    background: "#07080b",
    // A lit wall rather than a void. The reference's prism does not float in black, it stands a
    // few millimetres in front of a surface, and the falloff around the beam, the contact shadow
    // under the glass and the sheen the fan lands on are all that surface responding.
    backgroundMode: "wall",
    // What the glass reads where no light reaches it. Near-black, never black: at pure zero the
    // prism's silhouette disappears against the backdrop and the beam appears to float.
    // What the glass reads with NOTHING behind it, which against a black wall is most of the
    // solid, so this is very nearly the prism's own colour. It has to be dark: the reference's
    // glass is transparent, you see the wall through it, and what makes the faces visible is the
    // studio REFLECTING off them, not a pale fill. The slight blue lean is their absorption of
    // [1, 1, 0.54], which takes red and green harder than blue.
    clearGlass: "#101219",
    // A dim, cool wash so the prism's edges catch something. Turning the lamps off entirely
    // leaves the glass invisible between beam hits, which reads as a bug rather than as dark.
    // No lamps, and now genuinely none. Materials3D colours glass from the lamp field by default,
    // so this scene previously had to keep one at a whisper purely to feed that machinery. With
    // per-channel `absorption` on the prism the glass carries its own colour and the lamp field is
    // no longer load-bearing, which is what the reference does, it has no lamps at all.
    lamps: [],
    lampGain: 0,
    // The three-panel room. On black the lamp plate reaches almost none of the hemisphere, so
    // without this the prism has nothing to reflect and renders as a flat dark triangle, the
    // faces, the edges between them and the whole read of "a solid block of glass" come from here.
    studio: "softbox",
    // Strong, because the reflection is now doing ALL the work of describing the solid: their
    // reflectionStrength is 2.14 against an environmentExposure of 2.3, and with a transparent
    // glass over a black wall there is nothing else to see the faces by.
    studioGain: 2.3,
    lampGate: { lo: 0.02, hi: 0.98 },
    // A faint wash on the backdrop itself, so the prism sits in a room rather than in a void. Any
    // more and the black stops being black.
    backdropLamps: 0.05,
    plate: { z: -3, scale: { x: 26, y: 20 }, offset: { x: 0.5, y: 0.5 } },
    // The reference's framing, ported rather than re-derived: a 48° lens 1.25 units back from a
    // prism 0.57 across. Wide and CLOSE, the solid fills a good third of the frame height and the
    // fan has the whole lower quadrant to open into. Every tuned number below assumes this scale,
    // because the spectral density divides by a Jacobian measured in world units and therefore
    // does not survive being scaled.
    camera: { fov: 48, distance: 1.25, lookAt: { x: 0, y: 0, z: 0 }, height: 0 },
    // A prism is exactly the shape the analytic chord guesses worst, three flat faces and a
    // thickness that changes across the whole silhouette.
    // Trace the refracted ray against the prism's own faces. The screen-space offset is tuned for
    // rods; on three flat faces meeting at hard edges it sends the sample to the wrong place.
    tracedRefraction: true,
    // The inner interface, the far faces returning studio light back through the near ones,
    // including the paths that bounce before they escape. Needs `tracedRefraction` for the planes.
    backGlassStrength: 2.14,
    measuredThickness: true,
    post: {
      ...d.post,
      // No depth of field, as the reference has none, and at this scale the old numbers were
      // actively harmful: focus 40 against a camera 1.25 units back put EVERY pixel at maximum
      // defocus, so the whole frame carried a 24-tap gather at full radius. That permanent smear
      // was the difference between this reading as soft and the reference reading as clean.
      focus: 2.05,
      range: 1,
      aperture: 0,
      // Saturation-weighted bloom against a black frame is doing the opposite of its usual job
      // here: the only saturated thing in shot IS the spectrum, so this lights the rainbow and
      // leaves the glass alone.
      // The pyramid, not the gather. The beam is a light SOURCE, and a source's halo spans
      // several octaves at once, a tight core, a mid falloff, a broad wash. A single-radius
      // gather has to pick one of those, and whichever it picks the other two are missing.
      bloomMode: "pyramid",
      // DEFAULT_POSTPROCESS_CONTROLS: strength / threshold / radius.
      bloom: 0.7,
      bloomSpread: 0.25,
      bloomRadius: 26,
      // Above 1 so only genuinely over-range values bloom: the beam and the brightest of the fan,
      // never the glass.
      // Above the reference's 0.1, and deliberately. Their threshold is calibrated against their
      // value range; the beam here is emissive at radiance 6 and the fan sits well above 0.1, so a
      // low threshold blooms the SPECTRUM as well as the source. The halo then spreads white
      // across the bands and lifts every low channel, measured, it drops the fan's saturation
      // from 0.77 to 0.51. Thresholding above the fan keeps the glow on the beam, where it belongs.
      bloomThreshold: 0.1,
      caustics: 0,
      haze: 0.06,
      hazeTop: 0.5,
      hazeColor: "#10121a",
      vignette: 0.55,
      // No grain. Materials3D adds film grain because its other presets are pale studio shots
      // where it stops a smooth gradient banding; the reference's pipeline has none, and against a
      // near-black wall grain is the most visible thing in the frame rather than the least.
      grain: 0,
      // The beam is emissive HDR and the fan carries a spectral density well above 1. Clamped,
      // that turns the rainbow into magenta / cyan / yellow bars; the neutral curve keeps its hue
      // and lets the core go white the way an overexposed light actually does.
      // Their output.toneMapping default.
      toneMap: "aces",
    },
    beam: {
      // The beam refracts through the named ITEMS, so it follows whatever those shapes become, switch
      // the prism to a sphere and the light disperses through a sphere. `radius` and `sides` below are
      // then unused, and stay only because they are what a beam with no glass in front of it needs.
      targets: ["prism"],
      // PRISM_SIDE 0.57 → circumradius side/√3. The reference's scale, kept exactly, because every
      // tuned number below assumes it: the spectral density divides by a Jacobian measured in
      // world units, so none of them survive being rescaled.
      radius: 0.57 / Math.sqrt(3),
      sides: 3,
      rotation: Math.PI / 2,
      z: 0,
      // 30° around the cross-section is the midpoint of the upper-RIGHT face, so the beam arrives
      // from the lower right and the fan opens to the left. The mirror of the reference's edge 0,
      // which is why the incidence is negative: incidence turns the local normal counter-clockwise,
      // so a mirrored arrangement has to turn it the other way.
      //
      // An ANGLE rather than a face index, because the item is what decides the outline now and a
      // face index means nothing on a round one. `face` below is the unused fallback.
      entryAngle: 30,
      face: 2,
      // PRISM_INCIDENCE_DEGREES, negated for the mirror. Chosen there because it clears the exit
      // face with a comfortable margin and is the neutral midpoint of the pointer's travel.
      incidence: -60,
      entry: 0.5,
      // PRISM_LAMP_DISTANCE. Five times the camera distance, so the source sits far outside the
      // frame and the beam reads as collimated rather than as a spotlight.
      distance: 6.5,
      // Half of PRISM_DEFAULT_BEAM_WIDTH, which is a FULL width there, their
      // `collimatedLightBetween` stores `beamHalfWidth: beamWidth * 0.5`. This field is a
      // half-width, so copying 0.025 across made the beam twice as thick AND doubled the
      // `inputWidth` the spectral density is scaled by, putting the whole fan over the bloom
      // threshold and washing its saturation out.
      width: 0.0125,
      // The reference's homepage `spectralDispersion`, which is NOT its own `stylized` preset:
      // base 1.2 / strength 0.1 fans considerably wider than 1.245 / 0.06.
      ...BEAM_DISPERSION.hero,
      // PRISM_SPECTRAL_SAMPLES and PRISM_BEAM_SLICES.
      samples: 128,
      slices: 24,
      // PRISM_LIGHT_EXPOSURE.
      exposure: 88,
      // DEFAULT_LIGHT_FADE_CONTROLS, ported whole.
      edgeFalloff: 16,
      // Instant. A reveal is the right opening for a page that mounts this as a hero, and the
      // wrong default for a preset whose still is rendered at t = 0.
      revealSeconds: 0,
      falloffRate: 3.8,
      falloffPower: 3.7,
      // DEFAULT_LIGHT_MODE_CONTROLS.caustic and LIGHT_PIPELINE_TUNING.caustic, ported whole. Note
      // the rate and power SCALES: at 0.12 and 0.5 the caustic outlives the beam's own glow by a
      // long way, which is what makes the wall look lit rather than the beam look doubled.
      causticStrength: 1.9,
      causticCoverage: 0.86,
      causticFarDesaturation: 0.04,
      causticFarBrightness: 0.02,
      causticRateScale: 0.12,
      causticPowerScale: 0.5,
      causticNormalInfluence: 1,
      causticNormalElevation: 35,
      intensity: 1,
    },
    scatter: undefined,
    /**
     * The pointer drives the beam on two axes, as the reference does.
     *
     * Vertical swings the SOURCE, the angle of incidence on the entry face. Horizontal slides the
     * point of IMPACT along that face. They are independent only because incidence is measured
     * from the face normal rather than from world space; with a world-space angle, sweeping one
     * drags the other off the face within a couple of degrees.
     *
     * The incidence range deliberately CROSSES the critical angle. Below roughly 24° the beam
     * cannot leave through the exit face and totally internally reflects instead, bouncing inside
     * the glass, which is the light visibly doing something inside the prism rather than passing
     * through it. Above that it leaves as the full spectrum. Dragging from the top of the frame to
     * the bottom therefore travels from a trapped, bouncing beam to a wide clean fan, and the
     * handover is Fresnel: transmission falls smoothly to zero as the critical angle approaches,
     * so the exiting fan fades out instead of snapping off.
     *
     * Smoothed hard. The mesh is retraced whenever either value changes, so a raw pointer would
     * retrace on every jittered sample; the easing costs nothing and gives the beam some weight.
     */
    interaction: {
      enabled: true,
      bindings: [
        // DEFAULT_BEAM_MOUSE_Y_CONTROLS: top -35°, bottom +75°. pointerY is 1 at the TOP here,
        // so the endpoints are swapped relative to theirs.
        // Both ranges are the reference's, mirrored with the beam: the incidence negated, and the
        // entry reversed because edge 2 runs bottom-right to apex where edge 0 ran apex to
        // bottom-left. Moving the pointer right still slides the point of impact right.
        { source: "pointerY", target: "beamIncidence", from: -75, to: 35, smoothing: 0.55 },
        { source: "pointerX", target: "beamEntry", from: 0.88, to: 0.12, smoothing: 0.5 },
        // The same pointer position also tilts the CAMERA a few degrees. The light sheet is fixed
        // in world space, so this changes only its projection, and that is the point: a small
        // swing is what separates the beam from the prism and the prism from the dark behind it.
        // Bigger reads as the scene lurching after the cursor.
        { source: "pointerX", target: "cameraYaw", from: -3.5, to: 3.5, smoothing: 0.45 },
        { source: "pointerY", target: "cameraPitch", from: -3, to: 3, smoothing: 0.45 },
      ],
    },
    // Airborne dust, lit only where the beam and the fan actually are. It is what puts the prism
    // in a ROOM: without it the black is empty space rather than air, and the beam looks drawn on
    // rather than travelling through something.
    dust: {
      count: 3000,
      // Just past the frustum at the sheet's depth, a 48° lens 1.25 back sees about 0.97 x 0.56
      // there. Spreading the field much wider only spawns grains nobody can see; `extent.z` is now
      // the DEPTH SPREAD about the light plane rather than a half-box, and a shallow one keeps the
      // motes near the sheet where the parallax reads as volume instead of as flying debris.
      extent: { x: 1.15, y: 0.7, z: 0.18 },
      size: 1,
      // The reference's constants, unmodified. They only started working once the field feeding
      // them was right: an unthresholded sixteenth-res downsample rather than a walk down the
      // bloom chain, and a grain tone mapped on its own over the finished frame rather than summed
      // into the scene before the tone map. Softening the curve, which is what a lower response
      // and power are, was compensating for a field that was too dim, and both are gain knobs, so
      // it very nearly worked. It just wasn't the same picture.
      intensity: 1,
      // Drives the lifecycle clock, not a translation: grains respawn elsewhere at the end of a
      // life rather than marching along one axis.
      drift: 0.25,
      falloffPower: 5.5,
      response: 82,
      seed: 7,
    },
    items: [
      {
        name: "prism",
        // PRISM_SIDE / √3 across, PRISM_DEPTH deep.
        shape: {
          ...createShape("prism"),
          r: 0.57 / Math.sqrt(3),
          len: 0.3,
          sides: 3,
          fillet: 0,
          // PRISM_BEVEL_RADIUS, an 0.8mm fillet on a 57mm solid, rounding all nine edges rather
          // than the two cap rings a lathe can reach. It rounds the visible MESH only: the beam
          // still traces the ideal sharp cross-section, and the refraction tracer still uses the
          // sharp planes, exactly as the reference keeps the two representations separate so a
          // bevel can never move a light-producing face.
          bevel: 0.008,
        },
        position: { x: 0, y: 0, z: 0 },
        // Brings the lathe's cross-section into the XY plane, apex up, the orientation the beam
        // tracer assumes and the one the effect is named after.
        rotation: { x: -Math.PI / 2, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        material: {
          kind: "glass",
          albedo: "#eef1f6",
          density: 0.35,
          // Their DEFAULT_GLASS_TRANSMISSION.absorption. Red and green are taken about twice as
          // hard as blue, so the glass is faintly cool and gets cooler through its thick parts,
          // which is the whole reason to state it per channel rather than borrow a lamp's chroma.
          absorption: { x: 1, y: 1, z: 0.54 },
          // Their DEFAULT_GLASS_TRANSMISSION.ior. Note this is NOT the beam's 1.2, that is the
          // Cauchy BASE of the dispersion law the ray tracer uses, which is a different quantity
          // and sits below any real index by construction. Conflating the two made the shell far
          // too weak a refractor.
          ior: 1.645,
          dispersion: 0.05,
          rim: 1.35,
          specular: 1.7,
          emission: 0,
          saturation: 1,
        },
        motion: { kind: "none", axis: "y", rate: 0, amount: 0 },
        phase: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------- materials ---

/**
 * How each shape kind is sized for the swatch grid, and how it is turned to show itself.
 *
 * Typed as a full `Record<ShapeKind, …>`, which is the point: add a kind to {@link SHAPE_KINDS}
 * and this stops compiling until it has a size here. A chart that silently drops a row the day
 * someone adds a primitive is worse than no chart.
 *
 * Two rules behind the numbers. Everything is sized to about 1.6 units across, so a cell reads as
 * one swatch and the eye compares MATERIALS down a column rather than sizes. And the flat kinds
 * are tipped a few degrees off face-on rather than left square to the lens: dead-on, a disc is a
 * circle indistinguishable from the sphere beside it, and the lean is what puts a lit edge band on
 * it. `Math.PI / 2` is face-on for a lathe, `0` for the extrusions, which are authored flat.
 */
const SWATCH: Record<
  ShapeKind,
  { shape: Partial<ShapeConfig>; rotation: [number, number, number] }
> = {
  rod: { shape: { r: 0.32, len: 1.6 }, rotation: [0, 0, 0] },
  disc: { shape: { r: 0.8, thickness: 0.4 }, rotation: [1.31, 0, 0.12] },
  prism: { shape: { r: 0.72, len: 1.6, sides: 5 }, rotation: [0, 0.42, 0] },
  hex: { shape: { r: 0.72, len: 1.6 }, rotation: [0, 0.5, 0] },
  cone: { shape: { r: 0.7, len: 1.8 }, rotation: [0, 0, 0] },
  sphere: { shape: { r: 0.78 }, rotation: [0, 0, 0] },
  ring: { shape: { r: 0.82, hole: 0.44, thickness: 0.42 }, rotation: [1.31, 0, 0.12] },
  arrow: { shape: { len: 1.8, shaft: 0.3, head: 0.78, depth: 0.4 }, rotation: [0, 0, 0.32] },
  droplet: { shape: { r: 0.7, len: 1.9 }, rotation: [0, 0, 0] },
  blob: { shape: { r: 0.8, seed: 4, bump: 0.55 }, rotation: [0.2, 0.6, 0] },
  slab: { shape: { len: 1.5, thickness: 1.5, depth: 0.4, r: 0.34 }, rotation: [0.24, 0.34, 0.1] },
  // No outline given, so the swatch draws DEFAULT_OUTLINE, which is the honest thing for this
  // column to show: `path` has no shape of its own until one is authored into it.
  path: { shape: { r: 0.8, depth: 0.4 }, rotation: [0.2, 0.3, 0.08] },
  // Sized like the rest so the entry means something if this chart ever does draw it; see
  // SWATCH_KINDS for why it does not.
  model: { shape: { r: 0.8 }, rotation: [0.2, 0.3, 0.08] },
};

/**
 * The kinds the chart actually draws: every kind but `model`.
 *
 * `model` is the one kind with no geometry of its own even as a default. `path` at least falls
 * back to {@link DEFAULT_OUTLINE}, so its column shows a real silhouette; a `model` with no file
 * draws the placeholder sphere, and a column of "sphere, again" says nothing about materials,
 * which is the only thing this chart is for.
 *
 * A filter rather than a shorter table: {@link SWATCH} stays a full `Record<ShapeKind, …>`, so
 * adding a kind still stops the build until someone decides how it is sized.
 */
const SWATCH_KINDS = SHAPE_KINDS.filter((kind) => kind !== "model");

/**
 * The optics the transmissive rows share, so a row differs from its neighbour by ONE thing: the
 * shading model. Absorption is up and `lens` is off, a chart wants shapes you can read the edges
 * of, not a lump of glass smearing the swatch behind it.
 */
const SWATCH_OPTICS = {
  density: 2.2,
  ior: 1.48,
  dispersion: 0.02,
  lens: 0,
  rim: 0.4,
  specular: 1,
  saturation: 1.14,
  emission: 0,
};

/**
 * The one thing a shape kind cannot be trusted to derive: how far light travels through it.
 *
 * `defaultPath` hands a sphere and a blob their full radius, which at this density saturates the
 * middle to near-black, a swatch chart's worst outcome, since the row then says nothing about the
 * material. Everything not listed takes the geometry's own answer, which is right.
 */
const SWATCH_PATH: Partial<Record<ShapeKind, number>> = {
  sphere: 0.42,
  blob: 0.42,
  droplet: 0.45,
};

/**
 * Every material kind against every drawable shape kind: seven rows, twelve columns, one swatch
 * each.
 *
 * A legend rather than a composition, like {@link reactions}, and built by iterating
 * {@link MATERIAL_KINDS} and {@link SWATCH_KINDS} rather than by listing the pairs, so it cannot
 * fall out of date. Add a kind to either list and a row or column appears.
 *
 * The rows carry no `tint`: the transmissive kinds take the colour of whatever lamp sits behind
 * them, so each row runs warm to cool across the frame and two swatches of the same material in
 * different columns are visibly the same material in different light. The opaque kinds ignore the
 * lamp field entirely and take their published `albedo` from {@link MATERIAL_PRESETS}, which is
 * exactly the difference the chart exists to show, and the reason those three rows stay put while
 * the four above them change colour along their length.
 */
export function materials(): SceneConfig {
  const columns = SWATCH_KINDS.length;
  const rows = MATERIAL_KINDS.length;
  const items: ItemConfig[] = [];

  MATERIAL_KINDS.forEach((kind, row) => {
    SWATCH_KINDS.forEach((shape, column) => {
      const swatch = SWATCH[shape];
      const path = SWATCH_PATH[shape];
      items.push({
        // "metal · ring", the studio's shape list is the chart's legend, same trick reactions uses.
        name: `${kind} · ${shape}`,
        shape: { ...createShape(shape), ...swatch.shape },
        position: {
          x: (column - (columns - 1) / 2) * 2.15,
          y: ((rows - 1) / 2 - row) * 1.95,
          z: 0,
        },
        rotation: { x: swatch.rotation[0], y: swatch.rotation[1], z: swatch.rotation[2] },
        scale: { x: 1, y: 1, z: 1 },
        material: {
          ...SWATCH_OPTICS,
          kind,
          // Whatever the studio would apply on switching to this kind, roughness, and an albedo
          // and edge tint for the conductors. Read from the table rather than copied, so a swatch
          // shows what picking the kind actually gives you.
          ...MATERIAL_PRESETS[kind],
          ...(path === undefined ? {} : { path }),
        },
        // A slow bob, not a spin. Most of these are lathes, and a lathe turning about its own
        // sweep axis is visually stationary; drifting them through the lamp field instead is what
        // makes glass look like glass and leaves metal and ceramic conspicuously unmoved.
        // Amplitude is a fifth of the row gap, enough to live, not enough to blur the grid.
        motion: { kind: "drift", axis: "y", rate: 0.3, amount: 0.13 },
        phase: (row * columns + column) * 0.41,
      });
    });
  });

  return {
    ...createDefaultConfig(),
    background: "#f1f0ee",
    clearGlass: "#f4f3f1",
    // Four lamps spread the full width so every row crosses warm, pink, blue and teal in turn.
    // A chart of transmissive materials over a single lamp is a chart of one colour.
    lamps: [
      { x: 0.16, y: 0.66, r: 0.24, color: "#f0803a", intensity: 1 },
      { x: 0.4, y: 0.34, r: 0.24, color: "#d85fa8", intensity: 0.95 },
      { x: 0.63, y: 0.68, r: 0.24, color: "#6f8ce8", intensity: 0.95 },
      { x: 0.86, y: 0.36, r: 0.22, color: "#4fc4b8", intensity: 0.9 },
    ],
    lampGain: 1.35,
    lampGate: { lo: 0.04, hi: 0.96 },
    // Wider than the other presets': the grid runs to ±12 world units and a shape that samples off
    // the edge of the plate renders as clear white glass, which on this chart would read as a
    // material rather than as a bug.
    plate: { z: -3, scale: { x: 34, y: 24 }, offset: { x: 0.5, y: 0.5 } },
    // Long lens, far back. The grid is the subject, and any perspective at all makes the outer
    // columns lean, which on a comparison chart reads as a difference between the swatches.
    camera: { fov: 16, distance: 54, lookAt: { x: 0, y: 0, z: 0 }, height: 0.3 },
    // Eleven shape kinds, most of which the analytic chord guesses badly.
    measuredThickness: true,
    post: {
      ...createDefaultConfig().post,
      // Sharp, flat, and unglamorous on purpose: depth of field, haze and bloom all trade legibility
      // for atmosphere, and every one of them would make a swatch look like a different material
      // depending on where it sat in the frame.
      focus: 54,
      range: 24,
      aperture: 0,
      bloom: 0.012,
      caustics: 0,
      haze: 0,
      hazeTop: 0,
      vignette: 0.1,
      grain: 0.01,
    },
    scatter: undefined,
    items,
  };
}

// ---------------------------------------------------------------------- knot ---

/**
 * A loaded `.glb` in glass, flanked by two primitives.
 *
 * The `model` kind's preset, and the composition is the argument: the knot is not presented as a
 * special object with a viewer of its own, it is one item in an `items` list beside a rod and a
 * disc, taking the same lamps, the same optics and the same post stack. A mesh someone else
 * authored is a shape kind here, not a mode.
 *
 * A trefoil knot because it is the thing this feature exists for and the twelve primitives cannot
 * reach: it passes through itself and it has a hole, and no lathe or extruded outline makes
 * either. It also gives the glass something to do, since the parts of the frame it refracts
 * include the rest of itself.
 *
 * The optics came off a sphere, and that they carried over unchanged is the useful part: `path` is
 * the only material field that ever depended on the shape, and for a model it is measured off the
 * loaded mesh rather than guessed, so nothing here had to be retuned for arbitrary geometry.
 *
 * One shape, which is the composition doing the same job the optics do: there is nothing beside it
 * to explain it by, so what is on screen is a loaded mesh and the lamps behind it and nothing else.
 *
 * The mesh travels inside the config as a data URI; see {@link KNOT_GLB} for why, and why it is
 * the last preset that should.
 */
export function knot(): SceneConfig {
  const base = createDefaultConfig();
  const hero: MaterialConfig = {
    ...createMaterial(),
    kind: "glass",
    density: 0.28,
    ior: 1.5,
    dispersion: 0.16,
    lens: 0.75,
    bend: 1,
    magnify: 0.85,
    rim: 1,
    specular: 1,
    saturation: 1.35,
    emission: 0.04,
    iridescence: 0.75,
    filmNm: 430,
    roughness: 0.22,
    albedo: "#eef1f6",
  };
  return {
    ...base,
    background: "#0a0718",
    backgroundMode: "gradient",
    backgroundGradientType: "mesh",
    backgroundMeshPoints: [
      { x: 0.12, y: 0.16, color: "#ff1f5a" },
      { x: 0.52, y: 0.04, color: "#2b0f4a" },
      { x: 0.9, y: 0.2, color: "#ffb02e" },
      { x: 0.96, y: 0.6, color: "#00e5a0" },
      { x: 0.62, y: 0.96, color: "#1273ff" },
      { x: 0.22, y: 0.94, color: "#6d28ff" },
      { x: 0.04, y: 0.62, color: "#120a2e" },
      { x: 0.46, y: 0.48, color: "#ff5ec4" },
    ],
    // Bright, and load-bearing rather than a colour choice. A refracted ray inside a big solid
    // often lands back within that solid's own silhouette, and whatever `bend` cannot answer from
    // the glass-free plate falls back to THIS. Left dark it multiplies the interior down to
    // nothing and the shape reads as a hole. A knot has more interior than a sphere, not less.
    clearGlass: "#ffd9ef",
    lamps: [
      { x: 0.78, y: 0.5, r: 0.18, color: "#ff2d6f", intensity: 1.3 },
      { x: 0.63, y: 0.78, r: 0.18, color: "#ff6a2d", intensity: 1.3 },
      { x: 0.37, y: 0.78, r: 0.18, color: "#ffc53d", intensity: 1.3 },
      { x: 0.22, y: 0.5, r: 0.18, color: "#b6ff3d", intensity: 1.3 },
      { x: 0.37, y: 0.22, r: 0.18, color: "#3dffa8", intensity: 1.3 },
      { x: 0.63, y: 0.22, r: 0.18, color: "#3de0ff", intensity: 1.3 },
      { x: 0.5, y: 0.5, r: 0.32, color: "#ffe9c7", intensity: 0.8 },
    ],
    lampGain: 1.9,
    lampGate: { lo: 0.01, hi: 0.99 },
    backdropLamps: 0.1,
    // Pushed well back, which with `magnify` on is what sets the magnification: the refracted ray
    // sweeps more of the plate the further away it is, so the lamps arrive as distinct lobes
    // rather than one wash. Wide enough that the knot cannot sample past its edge, which renders
    // as clear white glass; a shape this open has a lot of silhouette to keep inside it.
    plate: { z: -14, scale: { x: 15, y: 10 }, offset: { x: 0.5, y: 0.5 } },
    camera: { ...base.camera, fov: 15, distance: 24, lookAt: { x: 0, y: 0, z: 0 }, height: 0 },
    measuredThickness: true,
    post: {
      ...base.post,
      focus: 24,
      range: 9,
      aperture: 0.3,
      bloom: 0.26,
      haze: 0.04,
      hazeTop: 0.03,
      hazeColor: "#f7f9fc",
      vignette: 0.4,
      grain: 0.014,
    },
    scatter: undefined,
    items: [
      {
        name: "knot",
        // `r` is the ONLY size control a model has, and it means the same thing it means for a
        // `path`: the mesh is fitted until its longest half-extent is this. Whatever units the
        // file was authored in have already been divided out.
        shape: { ...createShape("model"), kind: "model", model: KNOT_GLB, r: 2.9 },
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        material: hero,
        // A spin, not a drift: this is the one shape here that is not a lathe, so turning it about
        // Y actually changes its silhouette instead of leaving it visually stationary.
        motion: { kind: "spin", axis: "y", rate: 0.16, amount: 1 },
        phase: 0,
      },
    ],
  };
}

const PRESET_TABLE = {
  skewer,
  assembly,
  staircase,
  slimes,
  reactions,
  materials,
  prism,
  knot,
} satisfies Record<string, () => SceneConfig>;

/** The name of a shipped preset. */
export type PresetName = keyof typeof PRESET_TABLE;

/** True for a string that names a shipped preset; the guard for `PRESETS[name]` on user input. */
export function isPresetName(name: string): name is PresetName {
  return Object.hasOwn(PRESET_TABLE, name);
}

/**
 * Every shipped preset by name.
 *
 * The known names are typed, so `PRESETS.knot` autocompletes and a typo fails to compile. The
 * string index is kept because the studio (and any UI that picks a preset from a URL or a list)
 * indexes it with a runtime string; guard such a string with {@link isPresetName} rather than
 * trusting the index type, which cannot say `undefined`.
 */
export const PRESETS: Record<PresetName, () => SceneConfig> & Record<string, () => SceneConfig> =
  PRESET_TABLE;

export const PRESET_NAMES = Object.keys(PRESET_TABLE) as PresetName[];
