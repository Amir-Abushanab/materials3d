/** Terse typed DOM lookups. Throws on a missing id — every one of these is in index.html, so a
 *  miss is a build mistake, not a runtime condition to handle. */
export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export function on<K extends keyof HTMLElementEventMap>(
  el: HTMLElement | Document | Window,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  el.addEventListener(type, handler as EventListener);
}
