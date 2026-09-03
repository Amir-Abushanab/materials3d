// @vitest-environment jsdom
/**
 * The control search, against a REAL Tweakpane DOM rather than a hand-written fixture.
 *
 * The filter is entirely a set of assumptions about Tweakpane's class names (`tp-fldv`, its title
 * and body, `tp-lblv_l`), and a fixture would encode those assumptions twice and then agree with
 * itself forever. Building an actual pane means a Tweakpane upgrade that renames a class fails
 * here, which is the only failure mode this code really has.
 */
import { describe, expect, it } from "vitest";
import { Pane } from "tweakpane";
import { applySearch, clearSearch, HIDDEN_CLASS } from "./controlSearch";

/** A pane shaped like the studio's: nested folders, several labelled rows each. */
function buildPane(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const pane = new Pane({ container: host });
  const params = { bloom: 0.5, bloomRadius: 9, vignette: 0.2, focus: 6, albedo: "#ffffff" };

  const post = pane.addFolder({ title: "Post", expanded: true });
  post.addBinding(params, "bloom", { label: "bloom" });
  post.addBinding(params, "bloomRadius", { label: "bloom radius" });
  post.addBinding(params, "vignette", { label: "vignette" });

  const camera = pane.addFolder({ title: "Camera", expanded: true });
  camera.addBinding(params, "focus", { label: "focus" });

  const shapes = pane.addFolder({ title: "Shapes", expanded: true });
  const one = shapes.addFolder({ title: "glass rod", expanded: true });
  one.addBinding(params, "albedo", { label: "albedo" });

  return host;
}

const visibleLabels = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".tp-lblv")]
    .filter((row) => !row.closest(`.${HIDDEN_CLASS}`) && !row.classList.contains(HIDDEN_CLASS))
    .map((row) => row.querySelector(".tp-lblv_l")?.textContent?.trim() ?? "");

describe("control search", () => {
  it("keeps only the rows whose label matches", () => {
    const host = buildPane();
    applySearch(host, "bloom");
    expect(visibleLabels(host).toSorted()).toEqual(["bloom", "bloom radius"]);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    const host = buildPane();
    applySearch(host, "  VIGNETTE ");
    expect(visibleLabels(host)).toEqual(["vignette"]);
  });

  it("keeps a folder's whole contents when the FOLDER's title matches", () => {
    const host = buildPane();
    applySearch(host, "camera");
    // Not just rows containing "camera", of which there are none, but the section itself.
    expect(visibleLabels(host)).toEqual(["focus"]);
  });

  it("reaches into nested folders and reports every ancestor to open", () => {
    const host = buildPane();
    const reveal = applySearch(host, "albedo");
    expect(visibleLabels(host)).toEqual(["albedo"]);
    const titles = reveal.map((f) => f.querySelector(".tp-fldv_t")?.textContent?.trim());
    // Both the group and the member: revealing has to work from the outside in, because a
    // member's own toggle does nothing while its group is collapsed.
    expect(titles).toContain("Shapes");
    expect(titles).toContain("glass rod");
  });

  it("matches labels, not values", () => {
    const host = buildPane();
    // `albedo` is bound to "#ffffff". Matching row text as well as labels would surface it here,
    // and would surface every slider sitting at 0.5 for a search of "0.5".
    applySearch(host, "ffffff");
    expect(visibleLabels(host)).toEqual([]);
  });

  it("matches a button by its own text, which has no label", () => {
    const host = buildPane();
    const pane = new Pane({ container: host });
    pane.addButton({ title: "Shuffle scene" });
    applySearch(host, "shuffle");
    const buttons = [...host.querySelectorAll(".tp-btnv")].filter(
      (b) => !b.closest(`.${HIDDEN_CLASS}`) && !b.classList.contains(HIDDEN_CLASS),
    );
    expect(buttons.length).toBe(1);
  });

  it("hides everything when nothing matches", () => {
    const host = buildPane();
    applySearch(host, "no-such-control");
    expect(visibleLabels(host)).toEqual([]);
  });

  it("restores every row when cleared, by either route", () => {
    const host = buildPane();
    const all = visibleLabels(host);
    expect(all.length).toBeGreaterThan(3);

    applySearch(host, "bloom");
    expect(visibleLabels(host).length).toBeLessThan(all.length);
    applySearch(host, "");
    expect(visibleLabels(host)).toEqual(all);

    applySearch(host, "bloom");
    clearSearch(host);
    expect(visibleLabels(host)).toEqual(all);
  });

  it("leaves no hidden markers behind, so Tweakpane's own DOM is untouched", () => {
    const host = buildPane();
    applySearch(host, "bloom");
    applySearch(host, "");
    expect(host.querySelectorAll(`.${HIDDEN_CLASS}`).length).toBe(0);
  });
});
