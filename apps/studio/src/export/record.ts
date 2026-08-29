/**
 * Clip recording via MediaRecorder over the canvas's own stream.
 *
 * No encoder dependency and no frame-by-frame capture: the browser records what the renderer is
 * already drawing. The trade is that it records in real time at whatever framerate the four passes
 * actually sustain — a heavy scene records a slower-looking clip rather than dropping to a
 * deterministic frame walk. For a hero loop that is the right trade; for frame-exact output you
 * would drive `seek()` and mux the stills yourself.
 */

import type { MaterialRenderer } from "@materials3d/core/renderer";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { MAX_GIF_EDGE, pickVideoMime, type VideoFormat } from "../output/formats";
import { parseHex } from "@materials3d/core";
import { download } from "../util/download";
import { encodeAnimatedWebp, type WebpAnimFrame } from "./webpMux";

export interface Recording {
  /** Stop early; the file is written either way. */
  stop(): void;
  /** Resolves with the extension actually used — WebM if the requested container was refused. */
  readonly done: Promise<VideoFormat>;
}

export function startRecording(
  renderer: MaterialRenderer,
  format: VideoFormat,
  seconds: number,
  name: string,
): Recording {
  const { mime, ext } = pickVideoMime(format);
  const stream = renderer.captureStream(60);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  const done = new Promise<VideoFormat>((resolve, reject) => {
    const release = (): void => {
      for (const track of stream.getTracks()) track.stop();
    };
    recorder.addEventListener(
      "stop",
      () => {
        release();
        download(new Blob(chunks, { type: mime }), `${name}.${ext}`);
        resolve(ext);
      },
      { once: true },
    );
    recorder.addEventListener(
      "error",
      () => {
        release();
        reject(new Error("Recording failed"));
      },
      { once: true },
    );
  });

  recorder.start();
  const timer = setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, seconds * 1000);

  return {
    stop() {
      clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
    },
    done,
  };
}

export interface FrameWalkOptions {
  seconds: number;
  fps: number;
  quality: number;
  /** Reports progress 0–1 so the button can count frames instead of appearing hung. */
  onProgress?(fraction: number): void;
}

/**
 * Record an animated WebP by walking `seek()` frame by frame.
 *
 * This is the opposite trade from {@link startRecording}. MediaRecorder captures in real time, so
 * a heavy scene records a slower-looking clip; this renders frame N at exactly `N / fps` seconds
 * whatever the frame took, so the clip is frame-exact and reproducible from the same config. It is
 * also the only recording path that keeps alpha, since WebM and MP4 have nowhere to put it.
 *
 * The cost is that it is not live: the scene is stepped, not played, and a long clip at a large
 * size is a lot of encodes.
 */
export async function recordAnimatedWebp(
  renderer: MaterialRenderer,
  { seconds, fps, quality, onProgress }: FrameWalkOptions,
  name: string,
): Promise<number> {
  const canvas = renderer.canvas;
  const total = Math.max(1, Math.round(seconds * fps));
  const durationMs = 1000 / fps;
  const frames: WebpAnimFrame[] = [];
  const wasRunning = renderer.isRunning;

  renderer.stop();
  try {
    for (let i = 0; i < total; i++) {
      renderer.seek(i / fps);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", quality),
      );
      if (!blob) throw new Error("This browser could not encode a WebP frame");
      frames.push({ file: new Uint8Array(await blob.arrayBuffer()), durationMs });
      onProgress?.((i + 1) / total);
      // Yield between frames so the tab stays responsive and the progress label repaints.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    download(encodeAnimatedWebp(frames, canvas.width, canvas.height), `${name}.webp`);
    return total;
  } finally {
    if (wasRunning) renderer.start();
    else renderer.seek(renderer.getConfig().timeOffset);
  }
}

/**
 * Record a GIF by walking `seek()` frame by frame, quantizing each to 256 colours.
 *
 * GIF is the worst possible container for this renderer's output and it is offered anyway, because
 * some places still only take a GIF. Be clear about the trade: a scene built from smooth gradients
 * and soft depth of field is exactly what a 256-colour palette destroys, so expect banding, and
 * the long edge is capped at {@link MAX_GIF_EDGE} because file size grows with area × frames.
 *
 * Frames are composited onto an opaque background first. GIF's transparency is one bit — a pixel
 * is fully opaque or fully gone — so a soft alpha edge would come out as a hard, speckled fringe.
 */
export async function recordGif(
  renderer: MaterialRenderer,
  { seconds, fps, onProgress }: Omit<FrameWalkOptions, "quality">,
  name: string,
): Promise<number> {
  const source = renderer.canvas;
  const scale = Math.min(1, MAX_GIF_EDGE / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));

  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not open a 2D context for GIF encoding");

  const [r, g, b] = parseHex(renderer.getConfig().background);
  const flat = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

  const encoder = GIFEncoder();
  const total = Math.max(1, Math.round(seconds * fps));
  const delay = Math.round(1000 / fps);
  const wasRunning = renderer.isRunning;

  renderer.stop();
  try {
    for (let i = 0; i < total; i++) {
      renderer.seek(i / fps);
      ctx.fillStyle = flat;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(source, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const palette = quantize(data, 256);
      encoder.writeFrame(applyPalette(data, palette), w, h, { palette, delay });
      onProgress?.((i + 1) / total);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    encoder.finish();
    download(new Blob([encoder.bytes()], { type: "image/gif" }), `${name}.gif`);
    return total;
  } finally {
    if (wasRunning) renderer.start();
    else renderer.seek(renderer.getConfig().timeOffset);
  }
}
