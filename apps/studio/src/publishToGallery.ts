/**
 * "Publish to gallery": open GitHub's new-file page for `gallery/community/` with the current scene
 * prefilled, so a submission arrives as a PR. No backend, no account, nothing to run.
 *
 * The JSON is copied to the clipboard first, as a fallback for when a big config overruns GitHub's
 * URL length: a background image or video as a data URI makes that very likely, since
 * encodeURIComponent roughly triples a base64 payload. The clipboard write starts BEFORE
 * window.open so it runs while this document still has focus.
 *
 * Community files live in `gallery/community/` rather than alongside `gallery/*.json`: those are
 * generated from the shipped presets by `pnpm gallery:build`, and dropping hand-authored files in
 * with them would mean a regeneration and a submission fighting over the same directory.
 */
import type { SceneConfig } from "@materials3d/core";
import { toast } from "./ui/Toast";

const REPO = "Amir-Abushanab/materials3d";

/** Very long URLs get truncated by GitHub; past this we hand over a clipboard paste instead. */
const URL_BUDGET = 8000;

export function publishToGallery(config: SceneConfig): void {
  // Title and author on their own lines so they are easy to edit, with the config compacted onto
  // one so the whole thing stays short enough to prefill.
  const json = `{\n  "title": "My scene",\n  "author": "your-github-handle",\n  "config": ${JSON.stringify(config)}\n}\n`;

  const base = `https://github.com/${REPO}/new/main?filename=gallery/community/my-scene.json`;
  const prefilled = `${base}&value=${encodeURIComponent(json)}`;
  const fits = prefilled.length < URL_BUDGET;

  // Kicked off before window.open so it runs while this document still has focus. The write can
  // fail two ways (an insecure context throws synchronously, a denied permission REJECTS), and
  // the toast below waits for the result so it never claims a copy that didn't happen.
  const copied = (async () => {
    try {
      await navigator.clipboard.writeText(json);
      return true;
    } catch {
      return false;
    }
  })();
  window.open(fits ? prefilled : base, "_blank", "noopener");
  if (!fits) console.log(json);

  const steps = ' Set your title + handle, then pick "Create a new branch" to open a PR.';
  // An embedded image or video makes for a config nobody can review and a repo nobody wants to
  // clone. Name the fix here: this is the only warning an author sees before the PR.
  const heavy = /"background(?:Image|Video)Url"\s*:\s*"data:/i.test(json)
    ? " (Heads up: embedded image/video data makes the file huge; use a hosted URL instead.)"
    : "";
  void copied.then((ok) => {
    const lead = fits
      ? "Scene prefilled."
      : ok
        ? "Config copied. Paste it in."
        : "Copy failed. Grab the config from the browser console.";
    toast(lead + steps + heavy, 7000);
  });
}
