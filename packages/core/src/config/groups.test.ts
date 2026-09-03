import { describe, expect, it } from "vitest";
import { createItem, ensureSceneConfig, MIN_GROUP_SIZE, type SceneConfig } from "./model";
import {
  expandToGroups,
  groupItems,
  groupLabel,
  groupMembers,
  pruneGroups,
  ungroupItems,
} from "./groups";

/** A hand-authored scene of `count` loose shapes. */
function scene(count = 4): SceneConfig {
  return ensureSceneConfig({ items: Array.from({ length: count }, () => createItem()) });
}

describe("groupItems", () => {
  it("names what it creates, so the studio's name field is never an empty box", () => {
    const config = scene(4);
    expect(groupItems(config, [config.items[0], config.items[1]])?.name).toBe("Group 1");
    expect(groupItems(config, [config.items[2], config.items[3]])?.name).toBe("Group 2");
  });

  it("skips a default name already in use rather than making two 'Group 1's", () => {
    const config = scene(6);
    groupItems(config, [config.items[0], config.items[1]]);
    config.groups[0].name = "Group 2"; // renamed by hand, into the next default's way
    expect(groupItems(config, [config.items[2], config.items[3]])?.name).toBe("Group 1");
    expect(groupItems(config, [config.items[4], config.items[5]])?.name).toBe("Group 3");
  });

  it("binds shapes into one group and registers it", () => {
    const config = scene();
    const group = groupItems(config, [config.items[0], config.items[2]]);
    expect(group).not.toBeNull();
    expect(config.groups).toHaveLength(1);
    expect(config.items.map((item) => item.group)).toEqual([
      group?.id,
      undefined,
      group?.id,
      undefined,
    ]);
  });

  it("refuses a group of one, a group of one is not a group", () => {
    const config = scene();
    expect(groupItems(config, [config.items[0]])).toBeNull();
    expect(config.groups).toEqual([]);
    expect(config.items[0].group).toBeUndefined();
  });

  it("is a no-op on a selection that is already exactly one whole group", () => {
    // Otherwise mashing ⌘G would bury the scene under layers of identical groups.
    const config = scene();
    const first = groupItems(config, [config.items[0], config.items[1]]);
    const again = groupItems(config, [config.items[0], config.items[1]]);
    expect(again?.id).toBe(first?.id);
    expect(config.groups).toHaveLength(1);
  });

  it("moves shapes out of their old group, and dissolves what is left behind", () => {
    const config = scene(4);
    const first = groupItems(config, [config.items[0], config.items[1]]);
    // Take one of them plus an outsider. The remainder of `first` is a single shape, so it goes.
    const second = groupItems(config, [config.items[1], config.items[3]]);
    expect(second?.id).not.toBe(first?.id);
    expect(config.groups.map((g) => g.id)).toEqual([second?.id]);
    expect(config.items[0].group).toBeUndefined();
    expect(groupMembers(config, second?.id ?? "")).toEqual([config.items[1], config.items[3]]);
  });

  it("hands out ids nobody is using, without reusing a live one", () => {
    const config = scene(6);
    const a = groupItems(config, [config.items[0], config.items[1]]);
    const b = groupItems(config, [config.items[2], config.items[3]]);
    expect(a?.id).toBe("g1");
    expect(b?.id).toBe("g2");
    ungroupItems(config, [config.items[0]]);
    // g1 is free again, and reusing it is fine, nothing outside the config holds an id.
    expect(groupItems(config, [config.items[4], config.items[5]])?.id).toBe("g1");
  });
});

describe("expandToGroups", () => {
  it("pulls in every sibling of a group one member touches", () => {
    const config = scene();
    groupItems(config, [config.items[0], config.items[2]]);
    expect(expandToGroups(config, [config.items[2]])).toEqual([config.items[0], config.items[2]]);
  });

  it("returns shapes in SCENE order, not the order they were named", () => {
    const config = scene();
    groupItems(config, [config.items[0], config.items[2]]);
    const expanded = expandToGroups(config, [config.items[3], config.items[2]]);
    expect(expanded).toEqual([config.items[0], config.items[2], config.items[3]]);
  });

  it("leaves an ungrouped selection alone", () => {
    const config = scene();
    expect(expandToGroups(config, [config.items[1]])).toEqual([config.items[1]]);
  });
});

describe("ungroupItems", () => {
  it("dissolves the whole group, not just the shapes handed in", () => {
    const config = scene();
    groupItems(config, [config.items[0], config.items[1], config.items[2]]);
    expect(ungroupItems(config, [config.items[1]])).toBe(true);
    expect(config.groups).toEqual([]);
    expect(config.items.every((item) => item.group === undefined)).toBe(true);
  });

  it("reports that nothing happened when nothing was grouped", () => {
    const config = scene();
    expect(ungroupItems(config, [config.items[0]])).toBe(false);
  });
});

describe("pruneGroups", () => {
  it("dissolves a group whose membership fell below the minimum", () => {
    const config = scene();
    const group = groupItems(config, [config.items[0], config.items[1]]);
    config.items.splice(1, 1); // delete a member
    pruneGroups(config);
    expect(config.groups).toEqual([]);
    expect(config.items[0].group).toBeUndefined();
    expect(groupMembers(config, group?.id ?? "")).toEqual([]);
  });

  it("keeps a group that still has enough members", () => {
    const config = scene(4);
    groupItems(config, [config.items[0], config.items[1], config.items[2]]);
    config.items.splice(2, 1);
    pruneGroups(config);
    expect(config.groups).toHaveLength(1);
    expect(groupMembers(config, config.groups[0].id)).toHaveLength(MIN_GROUP_SIZE);
  });
});

describe("normalization", () => {
  it("synthesizes a group the shapes claim but the registry never declared", () => {
    // So `"group": "rods"` written by hand on a few shapes simply works.
    const config = ensureSceneConfig({
      items: [createItem(), createItem()].map((item) => ({ ...item, group: "rods" })),
    });
    expect(config.groups).toEqual([{ id: "rods" }]);
  });

  it("drops a registry entry no shape claims", () => {
    const config = ensureSceneConfig({
      items: [createItem(), createItem()],
      groups: [{ id: "ghost", name: "Ghost" }],
    });
    expect(config.groups).toEqual([]);
  });

  it("dissolves a group with a single member", () => {
    const config = ensureSceneConfig({
      items: [{ ...createItem(), group: "lonely" }, createItem()],
      groups: [{ id: "lonely" }],
    });
    expect(config.groups).toEqual([]);
    expect(config.items[0].group).toBeUndefined();
  });

  it("round-trips a grouped scene through JSON unchanged", () => {
    const config = scene();
    groupItems(config, [config.items[0], config.items[2]]);
    config.groups[0].name = "Rods";
    const again = ensureSceneConfig(JSON.parse(JSON.stringify(config)) as Partial<SceneConfig>);
    expect(again).toEqual(config);
  });

  it("keeps the group name through normalization", () => {
    const config = ensureSceneConfig({
      items: [
        { ...createItem(), group: "a" },
        { ...createItem(), group: "a" },
      ],
      groups: [{ id: "a", name: "  Rods  " }],
    });
    expect(config.groups[0].name).toBe("Rods");
    expect(groupLabel(config, config.groups[0])).toBe("Rods");
  });

  it("labels a hand-authored group with no name by its position", () => {
    const config = ensureSceneConfig({
      items: [
        { ...createItem(), group: "a" },
        { ...createItem(), group: "a" },
        { ...createItem(), group: "b" },
        { ...createItem(), group: "b" },
      ],
    });
    expect(config.groups[1].name).toBeUndefined();
    expect(groupLabel(config, config.groups[1])).toBe("Group 2");
  });
});
