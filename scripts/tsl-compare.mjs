/**
 * Renders one scene through BOTH engines and diffs the frames.
 *
 *   node scripts/tsl-compare.mjs materials
 *   node scripts/tsl-compare.mjs prism --crop 240,40,160,120
 *   node scripts/tsl-compare.mjs materials --probe base
 *   node scripts/tsl-compare.mjs --help
 *
 * The sibling of `tsl-parity.mjs`, and deliberately not the same tool. Parity compares one PASS at
 * a time on synthetic input, which is what proves a port is arithmetically faithful; this compares
 * whole FRAMES of a real scene, which is what catches the things a pass-level test cannot see:
 * a uniform never written, a pass never called, two correct passes composed in the wrong order.
 *
 * `--probe` substitutes one intermediate of the node engine's glass graph (see `devProbe` in
 * `NodeMaterialRenderer`) so a divergence can be walked back to the term that causes it.
 */
import { resolve } from "node:path";
import {
  assertPresets,
  launch,
  outputDir,
  parseArgs,
  presetNames,
  requireBuild,
  run,
  serve,
  writeDataUrl,
} from "./lib/harness.mjs";

const USAGE = `usage: pnpm tsl:compare [<preset>|<inline JSON scene>] [flags]

  --width <px> --height <px>   frame size (default 640x380)
  --probe <name>               substitute one glass-graph intermediate on both engines
  --crop x,y,w,h               compare a region only
  --at x,y[;x,y...]            print these pixels side by side (raw byte/255, no sRGB decode)
  --shift dx,dy                shift the node engine's frame before diffing (1,0 is the measured offset)
  --frames <n>                 frames to render before capturing (default 2)
  --settle <ms>                wait after constructing each renderer (default 0)
  --time <s>                   scene time to capture at (default 0)
  --loop                       run the node engine's rAF loop before capturing
  --label <name>               file name stem, for an inline scene
  --out <dir>                  where compare-<label>-{glsl,tsl,diff}.png go (default renders/)`;

const FLAGS = {
  width: 640,
  height: 380,
  probe: "",
  crop: "",
  out: "",
  label: "",
  /**
   * Pixels to print side by side, as `x,y;x,y`.
   *
   * Values are reported RAW, byte/255, because neither engine applies a display transfer at
   * output: the WebGL one writes `gl_FragColor` directly and the node one has its output colour
   * management turned off to match. Decoding these as sRGB is the single most effective way to
   * misread this tool, and it produced several confident wrong conclusions before it was noticed.
   */
  at: "",
  /**
   * Shift the TSL image by `dx,dy` pixels before diffing.
   *
   * The two engines do not rasterize to the same pixel grid: measured with a flat probe, the node
   * engine's silhouette sits one pixel left of the WebGL engine's. That misregistration inflates
   * every whole-frame number on its own, independently of any shading difference, so it is worth
   * being able to subtract it and see what is left. `--shift 1,0` is the measured offset.
   */
  shift: "",
  /** How many frames to render before capturing. Two by default, so a first-frame bake settles. */
  frames: 2,
  /**
   * Milliseconds to wait after constructing each renderer, before capturing.
   *
   * Zero by default. Needed only for scenes whose content arrives asynchronously: a background
   * image or video loads through a callback, and without a wait BOTH engines capture the fallback
   * colour and agree perfectly about a picture neither of them drew.
   */
  settle: 0,
  /**
   * Scene time to capture at, in seconds. Both engines take an explicit time in `captureImage`, so
   * a comparison at t is DETERMINISTIC, unlike `--loop`, which lets both run on the wall clock and
   * compares whatever frames happen to land.
   *
   * This is the only axis that tests MOTION. Two of the worst bugs in this port, a double-rate
   * clock and interaction bindings applied before motions rather than after, were both invisible
   * at t=0.
   */
  time: 0,
  /**
   * Run the node engine's rAF loop before capturing, instead of only awaited draws.
   *
   * The two are not the same test. `captureImage` awaits each draw; the loop fires them without
   * waiting, so anything `draw` mutates across an `await` can interleave between frames. That is
   * a failure mode this harness could not see until it could start the loop.
   */
  loop: false,
};

/** A short filesystem-safe name for a preset name or an inline JSON scene. */
const labelFor = (s) => (s.trim().startsWith("{") ? "scene" : s.replace(/[^a-z0-9_-]/gi, ""));
/** Raw channel triple, as fractions of full scale. */
const fmt = (v) => `(${v.map((n) => (n / 255).toFixed(3)).join(", ")})`;

await run(async (defer) => {
  const args = parseArgs(process.argv.slice(2), FLAGS);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  requireBuild({ dist: true });
  const scene = args.positionals[0] ?? "materials";
  const inline = scene.trim().startsWith("{");

  const server = await serve();
  defer(server.close);
  const { page, check, close } = await launch({ width: args.width, height: args.height });
  defer(close);
  await page.goto(server.url);
  check();
  if (!inline) assertPresets([scene], await presetNames(page, server.url));

  const result = await page.evaluate(
    async ([
      base,
      sceneArg,
      w,
      h,
      probeName,
      cropSpec,
      label,
      atSpec,
      frameCount,
      runLoop,
      shiftSpec,
      settleMs,
      sceneTime,
    ]) => {
      const gl = await import(base + "bundle.js");
      const { NodeMaterialRenderer } = await import(base + "dist/renderer/NodeMaterialRenderer.js");
      const host = document.getElementById("host");
      const cfg = gl.PRESETS[sceneArg] ? gl.PRESETS[sceneArg]() : JSON.parse(sceneArg);

      const region = cropSpec ? cropSpec.split(",").map(Number) : [0, 0, w, h];
      const grab = async (renderer) => {
        const blob = await renderer.captureImage("image/png", 0.92, sceneTime);
        const bitmap = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = region[2];
        c.height = region[3];
        c.getContext("2d").drawImage(bitmap, -region[0], -region[1]);
        return c;
      };

      host.replaceChildren();
      // The GLSL twin of the node engine's probe, so both sides can be asked the same question.
      const GLSL_PROBES = [
        "",
        "trans",
        "lit",
        "hue",
        "chord",
        "base",
        "amt",
        "grey",
        "roomR",
        "plateR",
        "plateCover",
        "fill",
        "opaqueGrey",
        "gradR",
        "backZ",
        "viewZ",
        "depthGuard",
        "plateA",
        "guardMargin",
        "offset",
        "alphaOut",
        "lobe",
        "mirrorV",
        "ndvP",
        "viewV",
        "posW",
        "calib",
        "dotKey",
        "rampX",
        "camP",
        "viewLen",
        "camErr",
        "thick",
        "duv",
        "normal",
        "plateUvTd",
        "front",
        "back",
        "plate",
        "wallM",
        "wallN",
        "wallGl",
        "wallFacing",
        "wallSpec",
        "wallDirect",
        "wallGi",
        "wallGrounding",
        "wallExposure",
        "wallWp",
        "wallOccl",
        "wallFp",
        "color",
        "coloralpha",
        "bloom0",
        "bloom1",
        "bloom2",
        "bloom3",
        "bloomC",
        "bgLampRgb",
        "bgLampA",
      ];
      // DUMP-ONLY names ask for a whole render target, not a material intermediate. They must NOT
      // set the material probe index: that index substitutes an intermediate into every shape's
      // shader, so asking for the colour target used to hand back a frame whose shapes were flat
      // grey probe output, while the node engine, which matches probes by NAME, rendered them
      // normally. The resulting "difference" was entirely this tool's.
      const DUMP_PROBES = [
        "front",
        "back",
        "plate",
        "color",
        "coloralpha",
        "bloom0",
        "bloom1",
        "bloom2",
        "bloom3",
        "bloomC",
      ];
      const isDump = DUMP_PROBES.includes(probeName);
      globalThis["__glslDump"] = isDump;
      globalThis["__glslProbe"] = isDump ? 0 : Math.max(0, GLSL_PROBES.indexOf(probeName));
      // Named separately: `front`/`back` select a TARGET to blit rather than a shader intermediate.
      globalThis["__glslProbeName"] = probeName || undefined;
      const a = new gl.MaterialRenderer(host, cfg, {
        respectReducedMotion: false,
        preserveDrawingBuffer: true,
      });
      a.setOutputSize({ width: w, height: h });
      if (settleMs) await new Promise((done) => setTimeout(done, settleMs));
      const glCanvas = await grab(a);
      globalThis["__glslProbe"] = 0;
      a.dispose();

      host.replaceChildren();
      // Set BEFORE construction: the probe is read when the material graph is built.
      globalThis["__tslDebug"] = probeName || undefined;
      const b = new NodeMaterialRenderer(host, cfg, { respectReducedMotion: false });
      b.setOutputSize({ width: w, height: h });
      if (settleMs) await new Promise((done) => setTimeout(done, settleMs));
      // Two frames. The first may bake the room and rebuild the item materials; the second is
      // drawn through the finished state, which is what a consumer actually sees.
      for (let i = 1; i < frameCount; i++) await b.captureImage("image/png", 0.92, sceneTime);
      if (runLoop) {
        b.start();
        await new Promise((done) => setTimeout(done, 600));
      }
      const tslCanvas = await grab(b);
      if (runLoop) b.stop();
      globalThis["__tslDebug"] = undefined;
      b.dispose();

      const A = glCanvas.getContext("2d").getImageData(0, 0, glCanvas.width, glCanvas.height).data;
      let B = tslCanvas.getContext("2d").getImageData(0, 0, tslCanvas.width, tslCanvas.height).data;
      if (shiftSpec) {
        // Redraw the TSL image offset by (dx, dy) and read it back, so the diff below compares
        // the two grids after registration rather than across a one-pixel step.
        const [dx, dy] = shiftSpec.split(",").map(Number);
        const moved = document.createElement("canvas");
        moved.width = tslCanvas.width;
        moved.height = tslCanvas.height;
        moved.getContext("2d").drawImage(tslCanvas, dx, dy);
        B = moved.getContext("2d").getImageData(0, 0, moved.width, moved.height).data;
      }
      const stats = globalThis.m3dHelpers.frameDiff(A, B);
      const diff = document.createElement("canvas");
      diff.width = glCanvas.width;
      diff.height = glCanvas.height;
      diff.getContext("2d").putImageData(new ImageData(stats.image, diff.width, diff.height), 0, 0);

      const samples = {};
      for (const p of (atSpec || "").split(";").filter(Boolean)) {
        const [x, y] = p.split(",").map(Number);
        const i = ((y - region[1]) * diff.width + (x - region[0])) * 4;
        if (i < 0 || i >= A.length) continue;
        samples[p] = { glsl: [A[i], A[i + 1], A[i + 2]], tsl: [B[i], B[i + 1], B[i + 2]] };
      }

      return {
        stats:
          `  ${label} ${diff.width}x${diff.height}${probeName ? ` probe=${probeName}` : ""}\n` +
          `    mean|d| ${stats.mean.toFixed(2)}   worst ${stats.worst}   pixels>4 ${stats.overPct.toFixed(1)}%\n` +
          `    brightness  glsl ${stats.brightnessA.toFixed(1)}  tsl ${stats.brightnessB.toFixed(1)}\n` +
          `    saturation  glsl ${stats.saturationA.toFixed(1)}  tsl ${stats.saturationB.toFixed(1)}`,
        glsl: glCanvas.toDataURL(),
        tsl: tslCanvas.toDataURL(),
        diff: diff.toDataURL(),
        samples,
      };
    },
    [
      server.url,
      scene,
      args.width,
      args.height,
      args.probe,
      args.crop,
      labelFor(scene),
      args.at,
      args.frames,
      args.loop,
      args.shift,
      args.settle,
      args.time,
    ],
  );

  console.log(result.stats);
  if (args.at) {
    console.log("    pixel          glsl                     tsl");
    for (const p of args.at.split(";")) {
      const [x, y] = p.split(",").map(Number);
      const g = result.samples[p];
      if (!g) continue;
      console.log(
        `    (${String(x).padStart(3)},${String(y).padStart(3)})  ${fmt(g.glsl).padEnd(24)} ${fmt(g.tsl)}`,
      );
    }
  }
  // A name from the scene, so an inline JSON scene does not become a filename.
  const label = args.label || labelFor(scene);
  const dir = await outputDir(args.out || undefined);
  for (const key of ["glsl", "tsl", "diff"]) {
    await writeDataUrl(resolve(dir, `compare-${label}-${key}.png`), result[key]);
  }
  console.log(`    wrote ${dir}/compare-${label}-{glsl,tsl,diff}.png`);
});
