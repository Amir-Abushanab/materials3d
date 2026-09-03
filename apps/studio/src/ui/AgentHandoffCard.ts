/**
 * A one-time card pointing out that the scene you designed can be handed straight to a coding
 * agent.
 *
 * Docks bottom-right of the stage, clear of the control panel (right) and the export frame's
 * resize handles. Copying leaves it up (the button's own "Copied" is the feedback); only the close
 * button dismisses it, and that sticks. The same button lives permanently in the Get code dialog,
 * so nothing is lost once it is gone.
 *
 * Builds its own DOM and injects its own style, like the other overlays.
 */
import { injectStyle } from "../util/dom";
import { createAgentCopyButton } from "./agentCopyButton";

const DISMISS_KEY = "materials3d:agent-card-dismissed";

/** localStorage throws in some partitioned or private contexts; never let that break the studio. */
function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Storage unavailable: the card reappears next session.
  }
}

const STYLE = `
/* Inset from the right by more than a resize handle's width, so the card never sits over the
   export frame's bottom-right handle when the frame is tall. */
.agent-card { position: absolute; right: calc(var(--edge) + 42px); bottom: var(--edge); z-index: 8;
  width: 264px; padding: 12px 13px 11px; font-family: var(--sans); font-size: 11.5px;
  color: var(--ink-2); background: rgb(251 250 250 / 94%); backdrop-filter: blur(8px);
  border: 1px solid var(--hair); border-radius: 9px; box-shadow: 0 12px 34px rgb(27 26 31 / 16%);
  animation: agent-card-in .32s cubic-bezier(.32, .72, 0, 1) both; }
@keyframes agent-card-in { from { opacity: 0; transform: translateY(8px); } }
.agent-card.leaving { opacity: 0; transform: translateY(8px);
  transition: opacity .2s ease, transform .2s ease; pointer-events: none; }
.agent-card h3 { margin: 0 26px 5px 0; font-size: 12.5px; font-weight: 600; color: var(--ink); }
.agent-card p { margin: 0 0 10px; line-height: 1.5; }
.agent-card .agent-x { position: absolute; top: 7px; right: 7px; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  background: none; border: none; border-radius: 5px; color: var(--ink-3); font-size: 15px;
  line-height: 1; cursor: pointer; }
.agent-card .agent-x:hover { background: rgb(27 26 31 / 8%); color: var(--ink); }
.agent-card .agent-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
  .agent-card { animation: none; }
  .agent-card.leaving { transition: none; }
}
@media (max-width: 900px) { .agent-card { display: none; } }
`;

/** Mount the card unless it was dismissed before. `getBrief` is read on click. */
export function mountAgentHandoffCard(parent: HTMLElement, getBrief: () => string): void {
  if (isDismissed()) return;
  injectStyle("materials3d-agent-card", STYLE);

  const el = document.createElement("aside");
  el.className = "agent-card";
  el.setAttribute("aria-label", "Hand this scene to a coding agent");

  const title = document.createElement("h3");
  title.textContent = "Building with an AI agent?";
  const body = document.createElement("p");
  body.textContent =
    "Copy this scene plus the @materials3d setup guide as one prompt. Paste it into your agent and it can wire the scene into your app.";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "agent-x";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "✕";
  close.addEventListener("click", () => {
    rememberDismissed();
    el.classList.add("leaving");
    window.setTimeout(() => el.remove(), 220);
  });

  el.append(close, title, body, createAgentCopyButton(getBrief));
  parent.appendChild(el);
}
