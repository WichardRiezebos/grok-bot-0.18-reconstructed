import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadGroups() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-plugin-groups-"));
  const output = path.join(temporary, "groups.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/plugins/overlay/groups.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const plugin = (id, category) => ({
  kind: "plugin",
  id,
  displayName: id,
  description: "",
  installed: false,
  ...(category == null ? {} : { category }),
});

test("marketplace rows group under alphabetical plugin categories", async () => {
  const loaded = await loadGroups();
  try {
    const groups = loaded.module.groupPluginItemsForDisplay([
      plugin("b", "Developer Tools"),
      plugin("a", "Data"),
      plugin("c", "Developer Tools"),
      plugin("d", "Productivity"),
    ]);
    assert.deepEqual(groups.map((group) => [group.label, group.items.map((item) => item.id)]), [
      ["Data", ["a"]],
      ["Developer Tools", ["b", "c"]],
      ["Productivity", ["d"]],
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("uncategorized plugins land in Other after real categories", async () => {
  const loaded = await loadGroups();
  try {
    const groups = loaded.module.groupPluginItemsForDisplay([
      plugin("a", ""),
      plugin("b", "  "),
      plugin("c", "Data"),
      plugin("d"),
    ]);
    assert.deepEqual(groups.map((group) => group.label), ["Data", "Other"]);
    assert.deepEqual(groups[1].items.map((item) => item.id), ["a", "b", "d"]);
  } finally {
    await loaded.dispose();
  }
});

test("servers and workflows group after plugin categories", async () => {
  const loaded = await loadGroups();
  try {
    const groups = loaded.module.groupPluginItemsForDisplay([
      { kind: "workflow", id: "w1", displayName: "W", description: "", enabled: true },
      plugin("p1", "Data"),
      { kind: "server", id: "s1", displayName: "S", description: "", status: "connected" },
      { kind: "server", id: "s2", displayName: "S2", description: "", status: "connected" },
      { kind: "workflow", id: "w2", displayName: "W2", description: "", enabled: false },
    ]);
    assert.deepEqual(groups.map((group) => [group.label, group.items.map((item) => item.id)]), [
      ["Data", ["p1"]],
      ["Servers", ["s1", "s2"]],
      ["Workflows", ["w1", "w2"]],
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("within-group order follows the incoming list order", async () => {
  const loaded = await loadGroups();
  try {
    const groups = loaded.module.groupPluginItemsForDisplay([
      plugin("z", "Data"),
      plugin("a", "Data"),
    ]);
    assert.deepEqual(groups[0].items.map((item) => item.id), ["z", "a"]);
  } finally {
    await loaded.dispose();
  }
});
