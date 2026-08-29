import { byId } from "../util/dom";

let timer: ReturnType<typeof setTimeout> | undefined;

/** One-line transient confirmation. Anything the user needs to act on gets a dialog instead. */
export function toast(message: string, ms = 1900): void {
  const el = byId("toast");
  el.textContent = message;
  el.dataset.show = "1";
  clearTimeout(timer);
  timer = setTimeout(() => {
    delete el.dataset.show;
  }, ms);
}
