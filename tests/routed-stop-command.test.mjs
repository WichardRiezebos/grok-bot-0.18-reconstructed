import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const cacheRoot = path.join(repoRoot, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(cacheRoot, "routed-stop-command-"));
  const output = path.join(temporary, `${path.basename(entry)}.mjs`);
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, entry)],
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

test("isRoutedStopCommand matches only bare stop commands", async () => {
  const { module, dispose } = await loadModule("source/shared/routed-turn-abort.ts");
  try {
    for (const prompt of ["stop", "Stop", "STOP!", "stop.", "stop it", "stoppen", "annuleer", "nvm", "never mind", "  halt  ", "cancel…"]) {
      assert.equal(module.isRoutedStopCommand(prompt), true, `"${prompt}" should stop the turn`);
    }
    for (const prompt of ["stop the video at 2min", "can you stop", "please stop the music", "cancel my subscription", "stopped?", "how do I stop this", ""]) {
      assert.equal(module.isRoutedStopCommand(prompt), false, `"${prompt}" must reach the model normally`);
    }
  } finally {
    await dispose();
  }
});

test("a bare stop command aborts the running turn without an LLM call", async () => {
  const { module, dispose } = await loadModule("source/node-agent-coordinator/inference-router.ts");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-stop-command-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
    let releaseTurn;
    const turnGate = new Promise((resolve) => { releaseTurn = resolve; });
    const runCalls = [];
    const entries = [];
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
      runProviderText: async (_provider, _messages, options) => {
        runCalls.push(Date.now());
        await Promise.race([
          turnGate,
          new Promise((_, reject) => {
            options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal.reason), { once: true });
          }),
        ]);
        if (options.onTextDelta != null) options.onTextDelta("working", "working");
        return "working";
      },
    });

    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "go shopping", clientNonce: "n-run" });
    for (let i = 0; i < 200 && runCalls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runCalls.length, 1, "the first turn must be running");

    const stopReply = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "STOP!", clientNonce: "n-stop" });
    assert.equal(stopReply.handled, true);
    assert.equal(stopReply.value.accepted, true);

    releaseTurn();
    for (let i = 0; i < 200; i++) {
      const stop = await router.dispatch("getAgentTranscriptTail", { id: "agent-1", limit: 20 });
      const texts = (stop.value?.entries ?? []).map((entry) => entry?.message?.content ?? entry?.content ?? "");
      if (texts.some((text) => /Stopped\./.test(String(text)))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1", limit: 20 });
    const texts = (tail.value?.entries ?? []).map((entry) => entry?.message?.content ?? entry?.content ?? "");
    assert.ok(texts.some((text) => /Stopped\./.test(String(text))), `expected a Stopped. entry, got ${JSON.stringify(texts)}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runCalls.length, 1, "the stop command itself must not trigger a second LLM turn");
  } finally {
    await dispose();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});
