/** Save a Blob to disk, cleaning up the object URL afterwards. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking synchronously can beat the download in some browsers; a second later is safe.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, type = "application/json"): void {
  download(new Blob([text], { type }), filename);
}

/** Copy to the clipboard, falling back to a hidden textarea where the async API is blocked
 *  (non-secure origins, older Safari). Returns whether it landed. */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}
