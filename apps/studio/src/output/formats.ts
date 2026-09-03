/** Pixel dimensions, aspect handling and file formats for every visual export surface. */

import { clamp } from "../util/math";

export interface ExportSize {
  preset: string;
  width: number;
  height: number;
  /** Preserve `aspectRatio` when either dimension is edited. */
  lockAspectRatio: boolean;
  /** Ratio captured from the current preset, or when the lock was enabled. */
  aspectRatio: number;
}

export interface ExportPreset {
  label: string;
  width: number;
  height: number;
}

export const CUSTOM_EXPORT_PRESET = "custom";
export const MIN_OUTPUT_DIMENSION = 64;
export const MAX_OUTPUT_DIMENSION = 8192;

export const EXPORT_PRESETS: Record<string, ExportPreset> = {
  "full-hd": { label: "Full HD · 16:9", width: 1920, height: 1080 },
  "web-16-9": { label: "Website / video · 16:9", width: 1600, height: 900 },
  "open-graph": { label: "Social link card · 1.91:1", width: 1200, height: 630 },
  square: { label: "Social post · 1:1", width: 1080, height: 1080 },
  "portrait-4-5": { label: "Social portrait · 4:5", width: 1080, height: 1350 },
  "story-9-16": { label: "Story / reel · 9:16", width: 1080, height: 1920 },
  "ultra-hd-4k": { label: "4K UHD · 16:9", width: 3840, height: 2160 },
  "ultra-hd-8k": { label: "8K UHD · 16:9", width: 7680, height: 4320 },
  "hero-wide": { label: "Wide hero · 21:9", width: 2560, height: 1080 },
};

export const DEFAULT_EXPORT_SIZE: ExportSize = {
  preset: "full-hd",
  width: EXPORT_PRESETS["full-hd"].width,
  height: EXPORT_PRESETS["full-hd"].height,
  // Unlocked out of the box: the presets already cover the ratios anyone is composing to, so the
  // reason to touch width or height by hand is almost always to leave one of them alone. The
  // ratio is still seeded, so switching the lock on preserves what is on screen rather than
  // snapping to something arbitrary.
  lockAspectRatio: false,
  aspectRatio: EXPORT_PRESETS["full-hd"].width / EXPORT_PRESETS["full-hd"].height,
};

// ---------------------------------------------------------------- stills ---

export type ImageFormat = "png" | "webp" | "jpeg";

export interface ImageFormatDefinition {
  label: string;
  mime: string;
  extension: string;
  lossy: boolean;
  /** JPEG has no alpha channel: exporting a transparent scene to it silently flattens the
   *  background to black, which is the kind of thing you discover after uploading it. */
  supportsTransparency: boolean;
}

export const IMAGE_FORMATS: Record<ImageFormat, ImageFormatDefinition> = {
  webp: {
    label: "WebP",
    mime: "image/webp",
    extension: "webp",
    lossy: true,
    supportsTransparency: true,
  },
  // Lossless, and the only format `pnpm calibrate` reads: a lossy still would move the
  // clear-glass ratio it measures.
  png: {
    label: "PNG",
    mime: "image/png",
    extension: "png",
    lossy: false,
    supportsTransparency: true,
  },
  jpeg: {
    label: "JPEG",
    mime: "image/jpeg",
    extension: "jpg",
    lossy: true,
    supportsTransparency: false,
  },
};

/** Probe results, kept for the session: the answer cannot change, and the panel asks on every
 *  rebuild, where three canvas encodes were a measurable part of the cost. */
const imageProbes = new Map<ImageFormat, boolean>();

/** Canvas encoders silently fall back to PNG for unsupported MIME types. Check the data-URL
 *  prefix so the UI only advertises formats this browser can actually produce. */
export function canExportImageFormat(format: ImageFormat): boolean {
  let can = imageProbes.get(format);
  if (can === undefined) {
    const { mime } = IMAGE_FORMATS[format];
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    can = canvas.toDataURL(mime).startsWith(`data:${mime}`);
    imageProbes.set(format, can);
  }
  return can;
}

// -------------------------------------------------------------- recording ---

export type VideoFormat = "webm" | "mp4";

/** Everything the record button can produce. `webp` and `gif` are built from frame-walked stills
 *  rather than recorded through MediaRecorder, so they are deterministic; see export/record.ts. */
export type RecordFormat = VideoFormat | "webp" | "gif";

// MediaRecorder mime candidates per container, best-quality first. MP4/H.264 recording works in
// Chromium and Safari but not Firefox, so pickVideoMime falls back to WebM when the requested
// container isn't supported, so recording never silently fails.
const VIDEO_MIME_CANDIDATES: Record<VideoFormat, string[]> = {
  mp4: ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4"],
  webm: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
};

const isMimeSupported = (mime: string): boolean =>
  typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime);

export function canRecordFormat(format: VideoFormat): boolean {
  return VIDEO_MIME_CANDIDATES[format].some(isMimeSupported);
}

/** Animated WebP is muxed from browser-encoded WebP frames, so it is available wherever the
 *  canvas can encode a still WebP. */
export function canRecordWebpAnimation(): boolean {
  return canExportImageFormat("webp");
}

/** The record formats that walk frames rather than recording in real time. A type predicate, so
 *  the MediaRecorder path narrows to {@link VideoFormat} without a cast. */
export function isFrameWalked(format: RecordFormat): format is "webp" | "gif" {
  return format === "webp" || format === "gif";
}

/**
 * GIF's long edge is capped hard. Every frame carries its own 256-colour palette, so the file
 * grows with area *and* frame count far faster than a video container does: a Full HD GIF of a
 * six-second loop is tens of megabytes and nobody wants it.
 */
export const MAX_GIF_EDGE = 640;

/**
 * The frame delay a GIF can actually store for this rate, in milliseconds.
 *
 * GIF keeps delays in whole centiseconds, so most rates cannot be honoured exactly: 24 fps is
 * written as 25, 30 as 33. The encoder rounds the same way, so the panel can say what the file
 * will really play at instead of the number on the slider.
 */
export function gifFrameDelayMs(fps: number): number {
  return Math.max(1, Math.round(100 / fps)) * 10;
}

export function gifEffectiveFps(fps: number): number {
  return 1000 / gifFrameDelayMs(fps);
}

/** Pick a MediaRecorder mime type + file extension, falling back to WebM. */
export function pickVideoMime(format: VideoFormat): { mime: string; ext: VideoFormat } {
  const wanted = VIDEO_MIME_CANDIDATES[format].find(isMimeSupported);
  if (wanted) return { mime: wanted, ext: format };
  const webm = VIDEO_MIME_CANDIDATES.webm.find(isMimeSupported) ?? "video/webm";
  return { mime: webm, ext: "webm" };
}

// ------------------------------------------------------------------ sizing ---

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function applyExportPreset(size: ExportSize, presetId: string): void {
  const preset = EXPORT_PRESETS[presetId];
  size.preset = presetId;
  if (!preset) return;
  size.width = preset.width;
  size.height = preset.height;
  size.aspectRatio = preset.width / preset.height;
}

function validAspectRatio(size: ExportSize): number {
  return Number.isFinite(size.aspectRatio) && size.aspectRatio > 0
    ? size.aspectRatio
    : size.width / size.height;
}

/** Apply one manually edited dimension, updating the other when the ratio is locked. */
export function applyCustomExportDimension(
  size: ExportSize,
  dimension: "width" | "height",
  value: number,
): void {
  size.preset = CUSTOM_EXPORT_PRESET;
  const rounded = Math.round(value);
  if (!size.lockAspectRatio) {
    size[dimension] = clamp(rounded, MIN_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION);
    size.aspectRatio = size.width / size.height;
    return;
  }

  const ratio = validAspectRatio(size);
  if (dimension === "width") {
    const minWidth = Math.ceil(Math.max(MIN_OUTPUT_DIMENSION, MIN_OUTPUT_DIMENSION * ratio));
    const maxWidth = Math.floor(Math.min(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION * ratio));
    size.width = clamp(rounded, minWidth, maxWidth);
    size.height = clamp(Math.round(size.width / ratio), MIN_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION);
  } else {
    const minHeight = Math.ceil(Math.max(MIN_OUTPUT_DIMENSION, MIN_OUTPUT_DIMENSION / ratio));
    const maxHeight = Math.floor(Math.min(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION / ratio));
    size.height = clamp(rounded, minHeight, maxHeight);
    size.width = clamp(Math.round(size.height * ratio), MIN_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION);
  }
}

/** Capture the current dimensions as the ratio future locked edits preserve. */
export function captureExportAspectRatio(size: ExportSize): void {
  size.aspectRatio = size.width / size.height;
}

export function aspectRatioLabel(width: number, height: number): string {
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

export interface ExportGpuWarning {
  /** Terse enough to sit inside a dropdown option. */
  short: string;
  /** The full sentence, for the warning block. */
  detail: string;
}

/**
 * Warn before an export that will hurt.
 *
 * Four passes per frame means Materials3D pays roughly four times the fill rate of a single-pass
 * renderer at the same size, so a 4K export here costs about what an 8K one would elsewhere,
 * which is exactly the intuition people arrive with and why the warning is worth showing at all.
 */
export function exportGpuWarning(width: number, height: number): ExportGpuWarning | null {
  const pixels = width * height;
  if (pixels >= 7680 * 4320) {
    return {
      short: "GPU very heavy",
      detail: "8K across four passes may exceed some devices' WebGL limits.",
    };
  }
  if (pixels >= 3840 * 2160) {
    return {
      short: "GPU heavy",
      detail: "GPU-heavy: four passes at 4K will take a moment, and more on a laptop.",
    };
  }
  return null;
}
