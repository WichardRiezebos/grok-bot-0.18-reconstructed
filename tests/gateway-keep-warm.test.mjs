import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-keep-warm-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/gateway/host-supervisor.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function createSupervisor(module, options = {}) {
  const resolveCalls = [];
  return {
    resolveCalls,
    supervisor: new module.SandHostSupervisor({
      resolveGatewayConnection: async () => {
        resolveCalls.push(1);
        return { baseUrl: "http://gateway.test" };
      },
      timing: module.createCoordinatorHostSupervisorTiming(),
      isTransportLive: () => false,
      ...options,
    }),
  };
}

test("refreshCachedConnectionHealth is a no-op without a cached connection", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  let healthCalls = 0;
  globalThis.fetch = async () => {
    healthCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const { supervisor } = createSupervisor(loaded.module);
    assert.equal(await supervisor.refreshCachedConnectionHealth(), false);
    assert.equal(healthCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});

test("a successful warm-up lets ensureConnection skip the health probe", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  let healthCalls = 0;
  globalThis.fetch = async () => {
    healthCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const { supervisor, resolveCalls } = createSupervisor(loaded.module);
    const first = await supervisor.ensureConnection();
    assert.equal(first.baseUrl, "http://gateway.test");
    assert.equal(healthCalls, 0);
    assert.equal(await supervisor.refreshCachedConnectionHealth(), true);
    assert.equal(healthCalls, 1);
    const second = await supervisor.ensureConnection();
    assert.equal(second.baseUrl, "http://gateway.test");
    assert.equal(healthCalls, 1, "no extra probe while the warmed TTL is fresh");
    assert.equal(resolveCalls.length, 1, "warm-up never starts a resolve attempt");
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});

test("a failed warm-up leaves the supervisor probing on the next ensureConnection", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  let healthCalls = 0;
  globalThis.fetch = async () => {
    healthCalls += 1;
    return new Response("nope", { status: 503 });
  };
  try {
    const { supervisor, resolveCalls } = createSupervisor(loaded.module);
    await supervisor.ensureConnection();
    assert.equal(await supervisor.refreshCachedConnectionHealth(), false);
    assert.equal(healthCalls, 1);
    await supervisor.ensureConnection();
    assert.equal(healthCalls, 2, "stale TTL still triggers the send-time probe");
    assert.ok(resolveCalls.length >= 1);
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});
