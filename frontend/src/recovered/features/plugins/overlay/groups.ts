import type { PluginBrowserItem } from "./browser";

export interface PluginItemGroup {
  readonly id: string;
  readonly label: string;
  readonly items: PluginBrowserItem[];
}

export const PLUGIN_GROUP_OTHER = "Other";
const SERVERS_GROUP = { id: "kind:server", label: "Servers" } as const;
const WORKFLOWS_GROUP = { id: "kind:workflow", label: "Workflows" } as const;

function pluginGroupKey(item: PluginBrowserItem): { id: string; label: string } {
  if (item.kind === "plugin") {
    const category = item.category?.trim() ?? "";
    return category.length > 0 ? { id: `category:${category}`, label: category } : { id: "category:other", label: PLUGIN_GROUP_OTHER };
  }
  if (item.kind === "server") return SERVERS_GROUP;
  return WORKFLOWS_GROUP;
}

function groupRank(group: PluginItemGroup): number {
  if (group.id === SERVERS_GROUP.id) return 2;
  if (group.id === WORKFLOWS_GROUP.id) return 3;
  return group.id === "category:other" ? 1 : 0;
}

export function comparePluginItemGroups(left: PluginItemGroup, right: PluginItemGroup): number {
  return groupRank(left) - groupRank(right) || left.label.localeCompare(right.label);
}

/** Groups visible browser rows for the collapsible marketplace sections: plugin categories first, then fallback buckets. */
export function groupPluginItemsForDisplay(items: readonly PluginBrowserItem[]): PluginItemGroup[] {
  const groups = new Map<string, { id: string; label: string; items: PluginBrowserItem[] }>();
  for (const item of items) {
    const key = pluginGroupKey(item);
    const existing = groups.get(key.id);
    if (existing == null) groups.set(key.id, { ...key, items: [item] });
    else existing.items.push(item);
  }
  return [...groups.values()].sort(comparePluginItemGroups);
}
