/**
 * An optional alignment grid over the preview.
 *
 * DOM, not scene geometry — for the same reason the selection box is. A grid drawn into the scene
 * would go through all four passes: depth of field would soften it, haze would fade it out at the
 * bottom of the frame, and it would land in every export. This sits above the canvas, so it stays
 * hairline-crisp at any zoom and `captureImage` (which reads the canvas) never sees it.
 *
 * It divides the FRAME, not the world. What you are usually judging in a hero is where a shape
 * sits in the picture — thirds, centred, off to one side — and that is a question about the frame.
 */

export interface GridOptions {
  /** Cells across and down. 3 gives the familiar rule-of-thirds guides. */
  divisions: number;
  /** Emphasise the centre lines, for judging what is actually centred. */
  centre: boolean;
  /**
   * Rotate the guides, in degrees — a camera's level, for judging a deliberately tilted frame.
   *
   * Set it to match `camera.roll` and the guides line up with the tilted composition instead of
   * fighting it; leave it at 0 and they stay true to the frame, which is what tells you how far
   * off level something is.
   */
  tilt: number;
}

export const DEFAULT_GRID: GridOptions = { divisions: 3, centre: true, tilt: 0 };

/** Half-range of the protractor, in degrees. Matches the tilt slider's range. */
const GAUGE_RANGE = 45;
const GAUGE_R = 92;
const GAUGE_CX = 120;
const GAUGE_CY = 116;

/** A point on the gauge arc. 0° is straight up; positive leans right, like the tilt itself. */
function gaugePoint(degrees: number, radius: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [GAUGE_CX + Math.sin(a) * radius, GAUGE_CY - Math.cos(a) * radius];
}

/**
 * The protractor face: arc, ticks and labels. Built once — only the needle and the readout change
 * as the angle does, so dragging the slider doesn't rebuild any of this.
 */
function gaugeFace(): string {
  const [ax, ay] = gaugePoint(-GAUGE_RANGE, GAUGE_R);
  const [bx, by] = gaugePoint(GAUGE_RANGE, GAUGE_R);
  const parts = [
    `<path class="g3-gauge-arc" d="M ${ax.toFixed(1)} ${ay.toFixed(1)} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${bx.toFixed(1)} ${by.toFixed(1)}"/>`,
  ];
  for (let angle = -GAUGE_RANGE; angle <= GAUGE_RANGE; angle += 5) {
    const major = angle % 15 === 0;
    const [x1, y1] = gaugePoint(angle, GAUGE_R);
    const [x2, y2] = gaugePoint(angle, GAUGE_R - (major ? 11 : 6));
    parts.push(
      `<line class="g3-gauge-tick${major ? " is-major" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`,
    );
    if (major) {
      const [lx, ly] = gaugePoint(angle, GAUGE_R + 13);
      parts.push(
        `<text class="g3-gauge-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${angle}</text>`,
      );
    }
  }
  return parts.join("");
}

export class GridOverlay {
  private readonly el: HTMLDivElement;
  private readonly gauge: SVGSVGElement;
  private readonly needle: SVGLineElement;
  private readonly readout: SVGTextElement;

  constructor(host: HTMLElement) {
    GridOverlay.injectStyle();
    this.el = document.createElement("div");
    this.el.className = "g3-grid";
    this.el.hidden = true;

    // A protractor rather than a bare line: the point of a tilt guide is knowing HOW FAR off
    // level you are, and a line on its own can only tell you that you are.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "g3-gauge");
    svg.setAttribute("viewBox", `0 -8 ${GAUGE_CX * 2} ${GAUGE_CY + 38}`);
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML =
      gaugeFace() +
      `<line class="g3-gauge-needle" x1="${GAUGE_CX}" y1="${GAUGE_CY}" x2="${GAUGE_CX}" y2="${GAUGE_CY - GAUGE_R + 14}"/>` +
      `<circle class="g3-gauge-hub" cx="${GAUGE_CX}" cy="${GAUGE_CY}" r="3"/>` +
      `<text class="g3-gauge-readout" x="${GAUGE_CX}" y="${GAUGE_CY + 22}">0.0°</text>`;
    this.gauge = svg;
    this.needle = svg.querySelector("line.g3-gauge-needle") as SVGLineElement;
    this.readout = svg.querySelector("text.g3-gauge-readout") as SVGTextElement;
    this.el.appendChild(svg);
    // Inserted before anything else in the stage so the selection box draws on top of it — the
    // thing you are moving should never sit behind the guide you are moving it against.
    host.prepend(this.el);
  }

  set(visible: boolean, options: GridOptions): void {
    this.el.hidden = !visible;
    if (!visible) return;
    const step = `${100 / Math.max(1, options.divisions)}%`;
    this.el.style.setProperty("--g3-grid-step", step);
    this.el.dataset.centre = options.centre ? "1" : "";
    // Only present when actually tilted, so a level frame shows the grid alone.
    this.el.style.setProperty("--g3-grid-tilt", `${options.tilt}deg`);
    if (options.tilt === 0) delete this.el.dataset.tilt;
    else this.el.dataset.tilt = "1";

    // The needle turns; the face never moves. A protractor whose scale rotated with its needle
    // would be unreadable.
    this.needle.setAttribute("transform", `rotate(${options.tilt} ${GAUGE_CX} ${GAUGE_CY})`);
    this.readout.textContent = `${options.tilt > 0 ? "+" : ""}${options.tilt.toFixed(1)}°`;
    this.gauge.style.display = options.tilt === 0 ? "none" : "";
  }

  dispose(): void {
    this.el.remove();
  }

  private static injectStyle(): void {
    if (document.getElementById("g3-grid-style")) return;
    const style = document.createElement("style");
    style.id = "g3-grid-style";
    style.textContent = `
.g3-grid{position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;
  /* Two repeating gradients rather than an SVG: the lines land on device pixels at any size, and
     resizing the window costs nothing to redraw. */
  background-image:
    repeating-linear-gradient(to right, rgb(27 26 31 / 13%) 0 1px, transparent 1px var(--g3-grid-step)),
    repeating-linear-gradient(to bottom, rgb(27 26 31 / 13%) 0 1px, transparent 1px var(--g3-grid-step));}
.g3-grid[hidden]{display:none;}
/* The tilt guide: a crossed pair of lines through the centre at a settable angle — a camera's
   level, not a rotated grid. Rotating the GRID would break it in two ways: "3 divisions" would
   stop meaning three across the frame, and the lines would no longer meet the frame's edges where
   the rule of thirds says they should. This sits over the top instead and leaves it alone.
   Oversized so the line still spans the frame when it is turned (the diagonal of a square is
   about 1.42 of its side). */
/* The protractor. Sits bottom-centre, clear of the middle of the frame where the subject is,
   and small enough to read without competing with it. */
.g3-gauge{position:absolute;left:50%;bottom:3.5%;width:min(30%,232px);height:auto;
  transform:translateX(-50%);overflow:visible;}
.g3-gauge-arc{fill:none;stroke:rgb(27 26 31 / 22%);stroke-width:1.25;}
.g3-gauge-tick{stroke:rgb(27 26 31 / 24%);stroke-width:1;}
.g3-gauge-tick.is-major{stroke:rgb(27 26 31 / 42%);stroke-width:1.4;}
.g3-gauge-label{fill:rgb(27 26 31 / 46%);font:600 10px var(--sans);text-anchor:middle;
  dominant-baseline:middle;}
.g3-gauge-needle{stroke:var(--accent);stroke-width:2;stroke-linecap:round;}
.g3-gauge-hub{fill:var(--accent);}
.g3-gauge-readout{fill:var(--accent);font:600 15px var(--mono);text-anchor:middle;
  font-variant-numeric:tabular-nums;}
.g3-grid[data-tilt]::before{content:"";position:absolute;inset:-25%;
  transform:rotate(var(--g3-grid-tilt,0deg));
  background-image:
    linear-gradient(to bottom, transparent calc(50% - 1px), rgb(162 75 200 / 42%) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)),
    linear-gradient(to right, transparent calc(50% - 1px), rgb(162 75 200 / 22%) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px));}
/* Centre lines are drawn separately so they read stronger than the divisions around them, and stay
   put whatever the division count is. */
.g3-grid[data-centre="1"]::after{content:"";position:absolute;inset:0;
  background-image:
    linear-gradient(to right, transparent calc(50% - 1px), rgb(27 26 31 / 26%) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)),
    linear-gradient(to bottom, transparent calc(50% - 1px), rgb(27 26 31 / 26%) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px));}
`;
    document.head.appendChild(style);
  }
}
