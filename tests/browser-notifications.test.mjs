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

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-browser-notifications-"));
  const output = path.join(temporary, "module.cjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    loader: { ".css": "empty" },
  });
  return { module: require(output), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("agents event unwraps { agents } and notifies when a turn finishes unfocused", async () => {
  const loaded = await loadModule("frontend/src/recovered/features/window-chrome/browser-notifications.ts");
  try {
    const shown = [];
    const manager = new loaded.module.SandBrowserNotificationManager({
      isSupported: () => true,
      isPermissionGranted: () => true,
      isWindowFocused: () => false,
      createNotification: (options) => {
        shown.push(options);
        return { onclick: null, onclose: null, close() {} };
      },
      openAgent: () => {},
      now: () => 1_000,
    });
    const running = {
      id: "agent-1",
      name: "Grok",
      isRunning: true,
      lastMessageId: "m1",
      lastMessagePreview: "working",
    };
    const idle = {
      ...running,
      isRunning: false,
      lastMessageId: "m2",
      lastMessagePreview: "Fetched the latest Gmail threads.",
    };
    assert.equal(loaded.module.toNotificationAgentsFromRoster({ agents: [running] })[0].notifyOnUpdatesEnabled, true);
    manager.handleAgentsEvent(loaded.module.toNotificationAgentsFromRoster({
      agents: [{ ...running, notifyOnUpdatesEnabled: true }],
    }));
    manager.handleAgentsEvent(loaded.module.toNotificationAgentsFromRoster({
      agents: [{ ...idle, notifyOnUpdatesEnabled: true }],
    }));
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, "Grok");
    assert.match(shown[0].body, /Gmail/);
  } finally {
    await loaded.dispose();
  }
});

test("projectRendererAgents unwraps the coordinator { agents } payload", async () => {
  const loaded = await loadModule("frontend/src/production/model.ts");
  try {
    const projected = loaded.module.projectRendererAgents({
      activeAgentId: "agent-1",
      agents: [{ id: "agent-1", name: "Grok", isRunning: true }],
    });
    assert.equal(projected.length, 1);
    assert.equal(projected[0].id, "agent-1");
    assert.equal(projected[0].isRunning, true);
  } finally {
    await loaded.dispose();
  }
});
