import type { SceneConfig } from "@materials3d/core";

/**
 * The hash payload's schema version. Bumped when a default changes meaning, so a link minted
 * before the change can be migrated on the way in rather than silently reinterpreted. Links from
 * before there was a version field are read as version 1.
 */
const SHARE_VERSION = 1;

/** Past this the link stops pasting cleanly into chat and mail clients, and some browsers refuse
 *  it outright; the config download is the right vehicle for a scene that big. */
const MAX_SHARE_URL_LENGTH = 8000;

/** The scene-level fields that can hold a data URI the size of a file. */
const MEDIA_KEYS = ["backgroundImageUrl", "backgroundVideoUrl"] as const;

interface Envelope {
  v: number;
  c: Partial<SceneConfig>;
}

interface ShareLink {
  url: string;
  /** A backdrop or model picked from disk was left out: it lives in the config as a data URI,
   *  which no link can carry. A hosted URL travels fine. */
  strippedMedia: boolean;
}

/**
 * Drop `.glb` data URIs from a scene's shapes, leaving hosted ones alone.
 *
 * The per-item counterpart to {@link MEDIA_KEYS}, and it needs a walk rather than a key list
 * because a model hangs off every item and off the scatter template. The shape KEEPS its kind
 * and its radius, so a stripped link still opens the scene with the model's placeholder standing
 * where it belongs, which reads as "point this at your file" rather than as a shape that vanished.
 */
function stripModels(payload: Partial<SceneConfig>): boolean {
  let stripped = false;
  const shapes = [...(payload.items ?? []).map((item) => item.shape), payload.scatter?.shape];
  for (const shape of shapes) {
    if (!shape?.model?.startsWith("data:")) continue;
    delete shape.model;
    stripped = true;
  }
  return stripped;
}

/** URL-safe base64 of the UTF-8 JSON. Configs are small (a few hundred bytes for a scatter
 *  scene), so a plain encode keeps the link readable and dependency-free. */
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(b64: string): string {
  const binary = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Takes a *minimal* config (defaults stripped): a full one is ~2kB encoded, which makes for an
 * ugly link and starts crowding real URL limits once a scene has hand-authored items.
 *
 * Returns null when the link would still be too long after dropping inline media; the caller
 * should offer the config download instead.
 */
export function toShareUrl(config: Partial<SceneConfig>): ShareLink | null {
  // A DEEP copy, unlike the shallow spread this used to take. `stripModels` deletes a field on a
  // shape several levels down, and doing that to the caller's own object would delete the model
  // out of the live scene: asking for a share link would erase the file you just picked.
  const payload: Partial<SceneConfig> = structuredClone(config);
  let strippedMedia = false;
  for (const key of MEDIA_KEYS) {
    if (payload[key]?.startsWith("data:")) {
      delete payload[key];
      strippedMedia = true;
    }
  }
  if (stripModels(payload)) strippedMedia = true;
  const envelope: Envelope = { v: SHARE_VERSION, c: payload };
  const url = `${location.origin}${location.pathname}#c=${encode(JSON.stringify(envelope))}`;
  return url.length > MAX_SHARE_URL_LENGTH ? null : { url, strippedMedia };
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Envelope).v === "number" &&
    typeof (value as Envelope).c === "object" &&
    (value as Envelope).c !== null
  );
}

/** Read a config out of the current URL hash, or null when there isn't one (or it's corrupt:
 *  a bad link should open the default scene, not a broken page). */
export function fromLocationHash(): Partial<SceneConfig> | null {
  const match = /[#&]c=([\w-]+)/.exec(location.hash);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(decode(match[1]));
    // Versioned envelope, or a bare config from before the envelope existed (version 1 either
    // way, so nothing to migrate yet).
    if (isEnvelope(parsed)) return parsed.c;
    return parsed as Partial<SceneConfig>;
  } catch {
    return null;
  }
}
