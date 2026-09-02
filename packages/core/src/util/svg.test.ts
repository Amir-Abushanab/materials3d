import { describe, expect, it } from "vitest";
import { capPathData, extractPathData } from "./svg";

describe("extractPathData", () => {
  it("leaves bare path data alone", () => {
    expect(extractPathData(" M0 0 H10 V10 Z ")).toBe("M0 0 H10 V10 Z");
  });

  it("pulls the d out of a whole svg document", () => {
    // What someone actually has is the file, not the attribute inside it.
    const svg = `<?xml version="1.0"?>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
        <path fill="#333" d="M0 0 H10 V10 Z" stroke-width="2"/>
      </svg>`;
    expect(extractPathData(svg)).toBe("M0 0 H10 V10 Z");
  });

  it("keeps every path, in document order", () => {
    // Which lands on the outline-then-holes rule for free: that is the order a vector tool writes
    // a shape and its counters in.
    const svg = `<svg><path d="M0 0 H10 V10 Z"/><path d="M2 2 H8 V8 Z"/></svg>`;
    expect(extractPathData(svg)).toBe("M0 0 H10 V10 Z M2 2 H8 V8 Z");
  });

  it("reads either quote style and any attribute order", () => {
    expect(extractPathData(`<path class='a' d='M0 0 H1 Z' />`)).toBe("M0 0 H1 Z");
  });

  it("returns nothing for markup with no path in it", () => {
    // A `<circle>` is a different attribute set. Half-supporting five elements would mean a paste
    // that silently loses part of the drawing rather than one that visibly does nothing.
    expect(extractPathData(`<svg><circle cx="5" cy="5" r="4"/></svg>`)).toBe("");
  });
});

describe("capPathData", () => {
  it("leaves data within the cap untouched", () => {
    expect(capPathData("M0 0 H10 Z", 100)).toBe("M0 0 H10 Z");
  });

  it("cuts between commands, never inside a number", () => {
    // A blind slice turns `L45.6` into `L45.` — one truncated coordinate poisons its whole
    // contour, so the shape does not come out shortened, it comes out GONE.
    const capped = capPathData("M0 0 L10 10 L45.6 7", 16);
    expect(capped).toBe("M0 0 L10 10");
  });

  it("gives up rather than emit a fragment with no command at all", () => {
    expect(capPathData("M0 0 L10 10", 3)).toBe("");
  });
});
