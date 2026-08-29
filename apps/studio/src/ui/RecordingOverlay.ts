/**
 * On-frame "● REC 0:05" indicator, shown while a clip is being captured.
 *
 * It lives in the DOM over the canvas rather than in the scene: every capture path reads the WebGL
 * backing buffer (either through `captureStream` or by stepping frames), so nothing drawn here can
 * ever reach the saved file.
 *
 * Ported from Wave Studio; restyled for Materials Studio's light chrome, where a dark pill would shout.
 */
export class RecordingOverlay {
  private readonly el: HTMLDivElement;
  private readonly timeEl: HTMLSpanElement;
  private startMs = 0;
  private timerId = 0;

  constructor(private readonly host: HTMLElement) {
    RecordingOverlay.injectStyle();
    this.el = document.createElement("div");
    this.el.className = "g3-rec";
    const dot = document.createElement("span");
    dot.className = "g3-rec-dot";
    const label = document.createElement("span");
    label.textContent = "REC";
    this.timeEl = document.createElement("span");
    this.timeEl.className = "g3-rec-time";
    this.timeEl.textContent = "0:00";
    this.el.append(dot, label, this.timeEl);
  }

  /** Show the indicator and start counting up. */
  start(): void {
    this.startMs = performance.now();
    this.render();
    if (!this.el.isConnected) this.host.appendChild(this.el);
    clearInterval(this.timerId);
    this.timerId = window.setInterval(() => this.render(), 250);
  }

  /** Hide the indicator and stop the timer. */
  stop(): void {
    clearInterval(this.timerId);
    this.timerId = 0;
    this.el.remove();
  }

  dispose(): void {
    this.stop();
  }

  private render(): void {
    const total = Math.max(0, Math.floor((performance.now() - this.startMs) / 1000));
    const minutes = Math.floor(total / 60);
    this.timeEl.textContent = `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  private static injectStyle(): void {
    if (document.getElementById("g3-rec-style")) return;
    const style = document.createElement("style");
    style.id = "g3-rec-style";
    style.textContent = `
.g3-rec{position:absolute;top:10px;right:10px;z-index:7;display:inline-flex;align-items:center;gap:7px;
  padding:5px 10px 5px 8px;border-radius:999px;background:rgb(27 26 31 / 72%);color:#fff;
  font:600 11px/1 var(--sans);letter-spacing:0.06em;
  box-shadow:0 4px 16px rgb(27 26 31 / 22%);pointer-events:none;}
.g3-rec-dot{width:8px;height:8px;border-radius:50%;background:#e0483c;
  box-shadow:0 0 8px rgb(224 72 60 / 90%);animation:g3-rec-pulse 1.1s ease-in-out infinite;}
.g3-rec-time{font-variant-numeric:tabular-nums;opacity:0.9;min-width:28px;}
@keyframes g3-rec-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.25;transform:scale(0.8);}}
@media (prefers-reduced-motion:reduce){.g3-rec-dot{animation:none;}}`;
    document.head.appendChild(style);
  }
}
