import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-retry-jitter-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "source/internal/scheduling.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function recordingClock() {
  const scheduled = [];
  return {
    scheduled,
    now: () => 0,
    monotonicNow: () => 0,
    schedule(delayMs, _callback) {
      scheduled.push(delayMs);
      return { dispose() {} };
    },
  };
}

test("jitterRatio 0 keeps the exact deterministic backoff", async (t) => {
  const loaded = await loadModule();
  try {
    const clock = recordingClock();
    const policy = loaded.module.createRetryPolicy(clock, { name: "plain", maxAttempts: 10, initialDelayMs: 100, maxDelayMs: 10_000, backoffFactor: 2 });
    for (const attempt of [1, 2, 3, 4]) policy.schedule(attempt);
    assert.deepEqual(clock.scheduled, [100, 200, 400, 800]);
  } finally {
    await loaded.dispose();
  }
});

test("jittered delays stay within ±ratio of the un-jittered backoff", async (t) => {
  const loaded = await loadModule();
  try {
    const clock = recordingClock();
    const policy = loaded.module.createRetryPolicy(clock, { name: "jittery", maxAttempts: 10, initialDelayMs: 100, maxDelayMs: 10_000, backoffFactor: 2, jitterRatio: 0.2 });
    for (let index = 0; index < 100; index += 1) {
      policy.schedule(1);
      policy.schedule(3);
    }
    assert.equal(clock.scheduled.length, 200);
    for (const delay of clock.scheduled) {
      const base = delay < 250 ? 100 : 400;
      assert.ok(delay >= base * 0.8 && delay <= base * 1.2, `delay ${delay} outside ±20% of ${base}`);
    }
    assert.ok(clock.scheduled.some((delay) => delay !== 100) && clock.scheduled.some((delay) => delay !== 400), "jitter actually varies the delays");
  } finally {
    await loaded.dispose();
  }
});

test("jitter never exceeds maxDelayMs", async (t) => {
  const loaded = await loadModule();
  try {
    const clock = recordingClock();
    const policy = loaded.module.createRetryPolicy(clock, { name: "capped", maxAttempts: 10, initialDelayMs: 1_000, maxDelayMs: 1_500, backoffFactor: 2, jitterRatio: 0.2 });
    for (let index = 0; index < 20; index += 1) policy.schedule(9);
    assert.deepEqual(clock.scheduled, new Array(20).fill(1_500));
  } finally {
    await loaded.dispose();
  }
});

test("jitterRatio must be a finite number in [0, 1)", async (t) => {
  const loaded = await loadModule();
  try {
    for (const invalid of [1, 1.5, -0.1, Number.NaN]) {
      assert.throws(
        () => loaded.module.createRetryPolicy(recordingClock(), { name: "bad", maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 100, jitterRatio: invalid }),
        RangeError,
      );
    }
  } finally {
    await loaded.dispose();
  }
});
