import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function loadProjectionModule() {
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-sidebar-sections-"));
  const output = path.join(temporary, "sidebar-section-projection.cjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/sidebar-section-projection.ts")],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
  });
  return { module: require(output), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("projectSidebarSections keeps groups and solo bots in their assigned sections", async () => {
  const loaded = await loadProjectionModule();
  try {
    const agents = [
      { id: "solo-a", name: "Solo A", updatedAt: 300, isGroup: false },
      { id: "group-1", name: "Room", updatedAt: 200, isGroup: true, memberIds: ["solo-a", "solo-b"] },
      { id: "solo-b", name: "Solo B", updatedAt: 100, isGroup: false },
    ];
    const sections = [
      { id: "sec-team", name: "Team", agentIds: ["group-1", "solo-a"], isCollapsed: false },
      { id: loaded.module.AGENTS_SECTION_ID, name: loaded.module.AGENTS_SECTION_NAME, agentIds: [], isCollapsed: false },
    ];
    const projected = loaded.module.projectSidebarSections({ agents, pinnedIds: [], sections });
    assert.equal(projected.length, 2);
    assert.deepEqual(projected[0].agents.map((agent) => agent.id), ["solo-a", "group-1"]);
    assert.deepEqual(projected[1].agents.map((agent) => agent.id), ["solo-b"]);
    assert.equal(projected[0].agents[1].isGroup, true);
  } finally {
    await loaded.dispose();
  }
});

test("projectSidebarSections excludes pinned agents and keeps synthetic unassigned section", async () => {
  const loaded = await loadProjectionModule();
  try {
    const agents = [
      { id: "pinned", name: "Pinned", updatedAt: 500, isGroup: false },
      { id: "free", name: "Free", updatedAt: 400, isGroup: false },
    ];
    const sections = [
      { id: "sec-a", name: "A", agentIds: ["free"], isCollapsed: false },
      { id: loaded.module.AGENTS_SECTION_ID, name: loaded.module.AGENTS_SECTION_NAME, agentIds: [], isCollapsed: false },
    ];
    const projected = loaded.module.projectSidebarSections({ agents, pinnedIds: ["pinned"], sections });
    assert.deepEqual(projected.map((section) => section.id), ["sec-a"]);
    assert.deepEqual(projected[0].agents.map((agent) => agent.id), ["free"]);
  } finally {
    await loaded.dispose();
  }
});
