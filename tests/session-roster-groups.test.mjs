import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadSummariesModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-session-summaries-"));
  const output = path.join(temporary, "session-summaries.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "source/host/extensions/session/session-summaries.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("group roster summaries read isGroup and memberIds from group.json", async () => {
  const loaded = await loadSummariesModule();
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "grok-group-roster-"));
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "group.json"), JSON.stringify({
      version: 1,
      memberIds: ["member-a", "member-b"],
    }, null, 2));
    const dbPath = path.join(agentDir, "store.db");
    const summary = loaded.module.minimalAgentSummary({
      dirName: "group-room",
      dbPath,
      dbStats: { mtimeMs: 12_345 },
    });
    assert.equal(summary.isGroup, true);
    assert.deepEqual(summary.memberIds, ["member-a", "member-b"]);
    const built = await loaded.module.buildSummary({
      extras: null,
      dbPath,
      dirName: "group-room",
      dbStats: { mtimeMs: 12_345 },
      includeBlank: true,
      agentHasMemory: () => false,
    });
    assert.equal(built?.isGroup, true);
    assert.deepEqual(built?.memberIds, ["member-a", "member-b"]);
  } finally {
    await loaded.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});
