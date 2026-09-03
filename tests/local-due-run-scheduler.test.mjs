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
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-local-due-run-"));
  const output = path.join(temporary, "module.cjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
  });
  return { module: require(output), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const now = 1_700_000_040_000;

function row(agentId, id, isEnabled, nextRunAt) {
  return { agentId, automation: { id, isEnabled, nextRunAt } };
}

test("collectDueFires selects only enabled automations whose slot has arrived", async () => {
  const loaded = await loadModule("source/host/extensions/automations/local-due-run-scheduler.ts");
  try {
    const { collectDueFires } = loaded.module;
    const rows = [
      row("a1", "daily", true, now - 5_000),
      row("a2", "disabled", false, now - 5_000),
      row("a3", "event-only", true, null),
      row("a4", "future", true, now + 5_000),
      row("a5", "bad", true, Number.NaN),
      row("a6", "due", true, now),
    ];
    const due = collectDueFires(rows, now);
    assert.deepEqual(due.map((entry) => entry.automation.id), ["daily", "due"]);
    for (const entry of due) {
      assert.equal(entry.scheduledForMs, entry.automation.nextRunAt);
      assert.equal(entry.latenessMs, now - entry.automation.nextRunAt);
      assert.match(entry.runUuid, /^local-a[16]-(daily|due)-\d+$/);
    }
  } finally {
    await loaded.dispose();
  }
});

test("collectDueFires emits exactly one fire per automation with a stable per-slot runUuid", async () => {
  const loaded = await loadModule("source/host/extensions/automations/local-due-run-scheduler.ts");
  try {
    const { collectDueFires } = loaded.module;
    const rows = [row("a1", "daily", true, now - 60_000)];
    const first = collectDueFires(rows, now);
    const second = collectDueFires(rows, now + 1_000);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].runUuid, second[0].runUuid);
  } finally {
    await loaded.dispose();
  }
});

test("scheduler fires due routines through the seam with runUuid and scheduledForMs", async () => {
  const loaded = await loadModule("source/host/extensions/automations/local-due-run-scheduler.ts");
  try {
    const { LocalDueRunScheduler } = loaded.module;
    const fires = [];
    const scheduler = new LocalDueRunScheduler({
      polling: { name: "test", start: () => ({ dispose: () => {} }) },
      listAutomations: async () => [row("a1", "daily", true, now - 30_000), row("a2", "other", true, now + 60_000)],
      isReady: async () => true,
      hasCloudCredential: () => false,
      now: () => now,
      fire: async (args) => { fires.push(args); },
    });
    await scheduler.pass();
    assert.equal(fires.length, 1);
    assert.equal(fires[0].agentId, "a1");
    assert.equal(fires[0].runUuid, `local-a1-daily-${now - 30_000}`);
    assert.equal(fires[0].scheduledForMs, now - 30_000);
    const status = scheduler.getStatus();
    assert.equal(status.dueCount, 1);
    assert.equal(status.firedCount, 1);
    assert.equal(status.skippedForCloud, false);
    assert.equal(status.skippedWhileNotReady, false);
    assert.equal(status.lastError, undefined);
  } finally {
    await loaded.dispose();
  }
});

test("scheduler stands down while a cloud credential exists or the turn runtime is not ready", async () => {
  const loaded = await loadModule("source/host/extensions/automations/local-due-run-scheduler.ts");
  try {
    const { LocalDueRunScheduler } = loaded.module;
    const fires = [];
    const base = {
      polling: { name: "test", start: () => ({ dispose: () => {} }) },
      listAutomations: async () => [row("a1", "daily", true, now - 1_000)],
      fire: async (args) => { fires.push(args); },
    };
    const withCloud = new LocalDueRunScheduler({ ...base, isReady: async () => true, hasCloudCredential: () => true });
    await withCloud.pass();
    assert.equal(fires.length, 0);
    assert.equal(withCloud.getStatus().skippedForCloud, true);
    const notReady = new LocalDueRunScheduler({ ...base, isReady: async () => false, hasCloudCredential: () => false });
    await notReady.pass();
    assert.equal(fires.length, 0);
    assert.equal(notReady.getStatus().skippedWhileNotReady, true);
  } finally {
    await loaded.dispose();
  }
});

test("scheduler records a fire failure and keeps firing the remaining due rows", async () => {
  const loaded = await loadModule("source/host/extensions/automations/local-due-run-scheduler.ts");
  try {
    const { LocalDueRunScheduler } = loaded.module;
    const fired = [];
    const scheduler = new LocalDueRunScheduler({
      polling: { name: "test", start: () => ({ dispose: () => {} }) },
      listAutomations: async () => [row("a1", "boom", true, now - 10_000), row("a2", "fine", true, now - 5_000)],
      isReady: async () => true,
      hasCloudCredential: () => false,
      now: () => now,
      fire: async (args) => {
        if (args.automation.id === "boom") throw new Error("session gone");
        fired.push(args.agentId);
      },
    });
    await scheduler.pass();
    assert.deepEqual(fired, ["a2"]);
    assert.match(scheduler.getStatus().lastError, /session gone/);
    assert.equal(scheduler.getStatus().firedCount, 1);
  } finally {
    await loaded.dispose();
  }
});

test("scheduler stops invoking passes after stop()", async () => {
  const loaded = await loadModule("source/host/extensions/automations/local-due-run-scheduler.ts");
  try {
    const { LocalDueRunScheduler } = loaded.module;
    const fires = [];
    let tick;
    const scheduler = new LocalDueRunScheduler({
      polling: { name: "test", start: (fn) => { tick = fn; return { dispose: () => {} }; } },
      listAutomations: async () => [row("a1", "daily", true, now - 1_000)],
      isReady: async () => true,
      hasCloudCredential: () => false,
      now: () => now,
      fire: async (args) => { fires.push(args); },
    });
    scheduler.start();
    await tick();
    assert.equal(fires.length, 1);
    scheduler.stop();
    await tick();
    assert.equal(fires.length, 1);
  } finally {
    await loaded.dispose();
  }
});
