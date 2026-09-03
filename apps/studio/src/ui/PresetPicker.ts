/**
 * The preset picker: a grid of rendered thumbnails rather than a dropdown.
 *
 * A `<select>` can't show an image, and for a renderer whose whole product is the look, a list of
 * words is the wrong control: "Skewer" and "Assembly" mean nothing until you have seen them. The
 * thumbnails are real renders of the presets themselves (see thumbs.ts), so they cannot go stale
 * the way a checked-in screenshot would.
 *
 * Lives inside a Tweakpane folder's content element, so it scrolls with the panel.
 */

import { getPresetThumb } from "./thumbs";

export interface PresetPickerHooks {
  onSelect(name: string): void;
}

export class PresetPicker {
  private readonly el: HTMLDivElement;
  private selected: string;

  constructor(
    parent: HTMLElement,
    private readonly names: string[],
    private readonly label: (name: string) => string,
    selected: string,
    private readonly hooks: PresetPickerHooks,
  ) {
    this.selected = selected;
    this.el = document.createElement("div");
    this.el.className = "g3-presets";
    this.el.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-preset]");
      if (!button) return;
      const name = button.dataset.preset as string;
      this.setSelected(name);
      this.hooks.onSelect(name);
    });
    parent.appendChild(this.el);
    this.render();
  }

  /** Mark which preset is current: "custom" (or any unknown name) selects nothing. */
  setSelected(name: string): void {
    this.selected = name;
    for (const card of this.el.querySelectorAll<HTMLElement>("[data-preset]")) {
      card.setAttribute("aria-pressed", String(card.dataset.preset === name));
    }
  }

  /** Re-read the thumbnail cache, called as each thumbnail lands. */
  refreshThumbs(): void {
    for (const card of this.el.querySelectorAll<HTMLElement>("[data-preset]")) {
      const url = getPresetThumb(card.dataset.preset as string);
      const image = card.querySelector<HTMLElement>(".g3-preset-img");
      if (url && image) image.style.backgroundImage = `url('${url}')`;
    }
  }

  private render(): void {
    this.el.replaceChildren();
    for (const name of this.names) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "g3-preset";
      card.dataset.preset = name;
      card.setAttribute("aria-pressed", String(name === this.selected));

      const image = document.createElement("span");
      image.className = "g3-preset-img";
      const url = getPresetThumb(name);
      if (url) image.style.backgroundImage = `url('${url}')`;

      const label = document.createElement("span");
      label.className = "g3-preset-label";
      label.textContent = this.label(name);

      card.append(image, label);
      this.el.appendChild(card);
    }
  }
}
