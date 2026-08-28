import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_INTERVAL_MS = 15_000;
const IDLE_MS = 30_000;

async function loadModule() {
  const temporary = await mkdtemp(join(tmpdir(), "grok-box-idle-suspend-"));
  const output = join(temporary, "module.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(repoRoot, "source/electron-main/box/box-idle-suspend.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${output}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function createFakeClock(start = 0) {
  let now = start;
  const timers = [];
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    now: () => now,
    monotonicNow: () => now,
    schedule(delayMs, callback) {
      const timer = { at: now + delayMs, callback, disposed: false };
      timers.push(timer);
      return { dispose() { timer.disposed = true; } };
    },
    async settle() { await flush(); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await flush();
        const due = timers.filter((timer) => !timer.disposed && timer.at <= target).sort((left, right) => left.at - right.at);
        if (due.length === 0) {
          now = target;
          await flush();
          return;
        }
        const next = due[0];
        now = next.at;
        next.disposed = true;
        next.callback();
      }
    },
  };
}

test("idle service stops a quiet box, ignores SSE reconnect, and wakes on demand", async () => {
  const loaded = await loadModule();
  const clock = createFakeClock();
  let idleMs = IDLE_MS;
  let health = { running: true, ready: true, isBusy: true, lastBusyAtMs: 0 };
  let stops = 0;
  let starts = 0;
  let restarts = 0;
  let connectCalls = 0;
  const service = loaded.module.createBoxIdleSuspendService({
    getIdleMs: () => idleMs,
    probe: async () => health.isBusy ? { ...health, lastBusyAtMs: clock.now() } : health,
    isMigrating: () => false,
    stop: async () => {
      stops += 1;
      health = { running: false, ready: false, isBusy: false, lastBusyAtMs: health.lastBusyAtMs };
    },
    start: async () => {
      starts += 1;
      health = { running: true, ready: true, isBusy: false, lastBusyAtMs: clock.now() };
    },
    restartCoordinator: () => { restarts += 1; },
    clock,
  });
  const connect = async () => {
    connectCalls += 1;
    return { ok: true };
  };
  try {
    service.start();
    await clock.advance(IDLE_MS + PROBE_INTERVAL_MS);
    assert.equal(stops, 0, "busy health must reset the idle timer");

    health = { running: true, ready: true, isBusy: false, lastBusyAtMs: clock.now() };
    await clock.advance(IDLE_MS + PROBE_INTERVAL_MS);
    assert.equal(stops, 1);
    assert.equal(service.isSuspended(), true);

    await assert.rejects(() => service.guardConnect(false, connect), (error) => {
      assert.equal(error?.name, "BoxSuspendedError");
      return true;
    });
    assert.equal(connectCalls, 0);

    await service.suspend();
    assert.equal(stops, 1, "a second suspend is a no-op");

    const demanded = await service.guardConnect(true, connect);
    assert.deepEqual(demanded, { ok: true });
    assert.equal(connectCalls, 1);
    assert.equal(service.isSuspended(), false);

    health = { running: true, ready: true, isBusy: false, lastBusyAtMs: clock.now() };
    await service.suspend();
    assert.equal(stops, 2);
    await service.resume();
    assert.equal(starts, 1);
    assert.equal(restarts, 1);
    assert.equal(service.isSuspended(), false);
    await service.guardConnect(false, connect);
    assert.equal(connectCalls, 2);
  } finally {
    service.dispose();
    await loaded.dispose();
  }
});
