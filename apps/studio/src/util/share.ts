import type { SceneConfig } from "@materials3d/core";

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

/** Takes a *minimal* config (defaults stripped) — a full one is ~2kB encoded, which makes for an
 *  ugly link and starts crowding real URL limits once a scene has hand-authored items. */
export function toShareUrl(config: Partial<SceneConfig>): string {
  return `${location.origin}${location.pathname}#c=${encode(JSON.stringify(config))}`;
}

/** Read a config out of the current URL hash, or null when there isn't one (or it's corrupt —
 *  a bad link should open the default scene, not a broken page). */
export function fromLocationHash(): Partial<SceneConfig> | null {
  const match = /[#&]c=([\w-]+)/.exec(location.hash);
  if (!match) return null;
  try {
    return JSON.parse(decode(match[1])) as Partial<SceneConfig>;
  } catch {
    return null;
  }
}
