/**
 * Grouping: the operations behind the studio's group / ungroup, kept in the config layer so they
 * are testable without a renderer and reusable by anything that edits a scene.
 *
 * See {@link GroupConfig} for why membership lives on the shapes and a group carries no transform
 * of its own. Everything here is a mutation of the supplied config — the studio's edit model is
 * "mutate the renderer's own object, then commit a history step", and returning fresh configs
 * would break the identity contract the panel's bindings depend on.
 */

import { MIN_GROUP_SIZE, type SceneConfig, type GroupConfig, type ItemConfig } from "./model";

/** Ids are `g1`, `g2`, … — the lowest free integer, so they stay short, stable and readable in
 *  hand-edited JSON. Deterministic on purpose: a random id would make two identical grouping
 *  actions produce different configs, and the whole scene is meant to be a pure document. */
function nextGroupId(config: SceneConfig): string {
  const taken = new Set<string>(config.groups.map((group) => group.id));
  for (const item of config.items) if (item.group) taken.add(item.group);
  for (let n = 1; ; n++) {
    const id = `g${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * A default label for a new group.
 *
 * A group gets a REAL name rather than leaning on the positional fallback, so the studio's name
 * field is populated the moment you make one — an empty box with faint placeholder text reads as
 * "unnamed", and the fallback would also renumber itself if an earlier group were deleted. Shapes
 * keep the placeholder instead: there are dozens of them and their fallback is derived from the
 * shape itself, so writing "rod 7" into all of them would only bloat the config.
 */
function nextGroupName(config: SceneConfig): string {
  const taken = new Set(config.groups.map((group) => group.name));
  for (let n = 1; ; n++) {
    const name = `Group ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** The group a shape belongs to, if any. */
export function groupOf(config: SceneConfig, item: ItemConfig): GroupConfig | undefined {
  return item.group ? config.groups.find((group) => group.id === item.group) : undefined;
}

/** Every shape in a group, in scene order. */
export function groupMembers(config: SceneConfig, id: string): ItemConfig[] {
  return config.items.filter((item) => item.group === id);
}

/**
 * Expand a set of shapes to include every sibling of any group they touch.
 *
 * This is what makes a group behave like one object: click one member, get all of them; sweep a
 * marquee over half a group, get the other half too. Order follows the SCENE, not the input, so
 * the result is stable however the selection was built up.
 */
export function expandToGroups(config: SceneConfig, items: readonly ItemConfig[]): ItemConfig[] {
  const groups = new Set<string>();
  for (const item of items) if (item.group) groups.add(item.group);
  if (groups.size === 0) {
    const chosen = new Set(items);
    return config.items.filter((item) => chosen.has(item));
  }
  const loose = new Set(items.filter((item) => !item.group));
  return config.items.filter((item) => (item.group ? groups.has(item.group) : loose.has(item)));
}

/**
 * Drop empty and undersized groups, and any registry entry no shape claims.
 *
 * Called after anything that removes shapes. A group whose membership falls below
 * {@link MIN_GROUP_SIZE} is dissolved rather than left as a one-shape group — deleting a shape
 * should not leave a lone survivor still reporting itself as grouped.
 */
export function pruneGroups(config: SceneConfig): void {
  const counts = new Map<string, number>();
  for (const item of config.items) {
    if (item.group) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  }
  for (const item of config.items) {
    if (item.group && (counts.get(item.group) ?? 0) < MIN_GROUP_SIZE) item.group = undefined;
  }
  config.groups = config.groups.filter((group) => (counts.get(group.id) ?? 0) >= MIN_GROUP_SIZE);
}

/**
 * Group these shapes, returning the new group (or `null` if there was nothing to group).
 *
 * Shapes already in other groups are MOVED into the new one, and those groups pruned — the
 * PowerPoint behaviour, and the only one that makes repeated grouping predictable. Regrouping a
 * selection that is already exactly one whole group is a no-op rather than a rename, so mashing
 * the shortcut cannot bury a scene under layers of identical groups.
 */
export function groupItems(config: SceneConfig, items: readonly ItemConfig[]): GroupConfig | null {
  const members = [...new Set(items)].filter((item) => config.items.includes(item));
  if (members.length < MIN_GROUP_SIZE) return null;

  const existing = members[0].group;
  if (existing && members.every((item) => item.group === existing)) {
    const whole = groupMembers(config, existing);
    if (whole.length === members.length) return groupOf(config, members[0]) ?? null;
  }

  const id = nextGroupId(config);
  for (const item of members) item.group = id;
  const group: GroupConfig = { id, name: nextGroupName(config) };
  config.groups.push(group);
  pruneGroups(config); // the groups these shapes were pulled out of may now be too small
  return group;
}

/**
 * Ungroup every group represented in `items`. Returns true if anything changed.
 *
 * It ungroups the whole group, not just the shapes handed in: half-dissolving a group is not a
 * thing anyone means by "ungroup", and since selecting one member selects all of them the
 * distinction only arises after drilling into a single shape — where "ungroup" still plainly means
 * the group it is in.
 */
export function ungroupItems(config: SceneConfig, items: readonly ItemConfig[]): boolean {
  const ids = new Set<string>();
  for (const item of items) if (item.group) ids.add(item.group);
  if (ids.size === 0) return false;
  for (const item of config.items) {
    if (item.group && ids.has(item.group)) item.group = undefined;
  }
  config.groups = config.groups.filter((group) => !ids.has(group.id));
  return true;
}

/** A group's label, falling back to its position in the registry when it has no name — which is
 *  the hand-authored case, since {@link groupItems} always names what it creates. */
export function groupLabel(config: SceneConfig, group: GroupConfig): string {
  return group.name ?? `Group ${config.groups.indexOf(group) + 1}`;
}
