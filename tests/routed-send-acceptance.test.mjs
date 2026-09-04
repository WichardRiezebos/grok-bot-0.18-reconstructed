import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRouter() {
  const cacheRoot = path.join(repoRoot, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(cacheRoot, "routed-send-acceptance-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const ROUTER_SETTINGS = {
  version: 1, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false,
  webauthnProxyEnabled: true, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {},
  mcpDisabledToolsByServerId: {}, conciergeConsent: "unset", settingsMigrations: [],
  inferenceProvider: "openrouter",
};

test("routed sends answer promptAcceptanceStatus so the composer's waiting-to-send notice retires", async () => {
  const { module, dispose } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-send-acceptance-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
    const roster = [{ id: "agent-1", name: "Jarvis" }];
    const router = module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: () => {},
      dispatchRemote: async (method) => {
        if (method === "listAgents") return roster.map((agent) => ({ ...agent }));
        if (method === "getAgentTranscriptTail") return { entries: [] };
        return {};
      },
      runProviderText: async () => "done",
    });

    const unknown = await router.dispatch("promptAcceptanceStatus", { accountSlot: "host", clientNonce: "never-seen" });
    assert.deepEqual(unknown, { handled: false }, "unknown nonces must fall through to the box ledger");

    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello", clientNonce: "nonce-1" });
    for (let i = 0; i < 200; i++) {
      const accepted = await router.dispatch("promptAcceptanceStatus", { accountSlot: "host", clientNonce: "nonce-1", agentId: "agent-1" });
      if (accepted.handled === true && accepted.value?.record?.echoEntryId != null) {
        assert.equal(accepted.value.outcome, "found");
        assert.equal(accepted.value.record.status, "accepted");
        assert.equal(accepted.value.record.accountSlot, "host");
        assert.equal(accepted.value.record.echoEntryId, "t0u");
        assert.equal(accepted.value.record.rejectionCode, null);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const last = await router.dispatch("promptAcceptanceStatus", { accountSlot: "host", clientNonce: "nonce-1", agentId: "agent-1" });
    assert.fail(`acceptance never gained an echoEntryId: ${JSON.stringify(last)}`);
  } finally {
    await dispose();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("the acceptance answer exists the moment sendPrompt is accepted, before the turn runs", async () => {
  const { module, dispose } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-send-acceptance-2-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
    let releaseTurn;
    const turnGate = new Promise((resolve) => { releaseTurn = resolve; });
    const roster = [{ id: "agent-1", name: "Jarvis" }];
    const router = module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: () => {},
      dispatchRemote: async (method) => {
        if (method === "listAgents") return roster.map((agent) => ({ ...agent }));
        if (method === "getAgentTranscriptTail") return { entries: [] };
        return {};
      },
      runProviderText: async () => {
        await turnGate;
        return "done";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello", clientNonce: "nonce-early" });
    const pending = await router.dispatch("promptAcceptanceStatus", { accountSlot: "host", clientNonce: "nonce-early", agentId: "agent-1" });
    assert.equal(pending.handled, true);
    assert.equal(pending.value.outcome, "found");
    assert.equal(pending.value.record.status, "accepted");
    assert.equal(pending.value.record.echoEntryId, null);
    releaseTurn();
  } finally {
    await dispose();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});
