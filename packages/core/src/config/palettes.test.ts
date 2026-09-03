import { describe, expect, it } from "vitest";
import { createDefaultConfig, createLamp } from "./model";
import { applyLampPalette, isLampPaletteName, LAMP_PALETTE_NAMES, LAMP_PALETTES } from "./palettes";

describe("lamp palettes", () => {
  it("lists every palette by name, reference first", () => {
    expect(LAMP_PALETTE_NAMES).toEqual(Object.keys(LAMP_PALETTES));
    expect(LAMP_PALETTE_NAMES[0]).toBe("reference");
    expect(isLampPaletteName("reference")).toBe(true);
    expect(isLampPaletteName("toString")).toBe(false);
  });

  it("keeps `reference` equal to the default scene's lamps, which it was measured from", () => {
    expect(createDefaultConfig().lamps.map((lamp) => lamp.color)).toEqual([
      ...LAMP_PALETTES.reference,
    ]);
  });
});

describe("applyLampPalette", () => {
  it("recolours in place, cycling the palette, and moves nothing", () => {
    const lamps = Array.from({ length: LAMP_PALETTES.ember.length + 2 }, (_, i) =>
      createLamp(i / 10, 0.3, "#000000"),
    );
    const before = lamps.map((lamp) => ({ ...lamp }));
    applyLampPalette(lamps, "ember");
    for (const [index, lamp] of lamps.entries()) {
      expect(lamp.color).toBe(LAMP_PALETTES.ember[index % LAMP_PALETTES.ember.length]);
      expect({ ...lamp, color: before[index].color }).toEqual(before[index]);
    }
  });

  it("ignores a name it does not know", () => {
    const lamps = [createLamp()];
    applyLampPalette(lamps, "constructor");
    expect(lamps[0].color).toBe(createLamp().color);
  });
});
