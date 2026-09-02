import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const cacheRoot = path.join(repoRoot, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(cacheRoot, "grok-turn-debug-"));
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
  version: 1,
  mcpBoxServers: [],
  autoUpdateWhenIdleOptIn: false,
  egressTunnelEnabled: false,
  webauthnProxyEnabled: true,
  mcpCustomInstructions: {},
  mcpCustomInstructionsByServerId: {},
  mcpDisabledToolsByServerId: {},
  conciergeConsent: "unset",
  settingsMigrations: [],
  inferenceProvider: "openrouter",
};

async function writeRouterSettings(dataDir) {
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
}

function wiredRouter(loadedModule, dataDir, { events, turnTimeoutMs, runProviderText } = {}) {
  return loadedModule.createCoordinatorInferenceRouter({
    dataDir,
    composingDelayMs: 0,
    now: () => 1_000,
    ...(turnTimeoutMs == null ? {} : { turnTimeoutMs }),
    postEvent: (family, payload) => events.push({ family, payload }),
    dispatchRemote: async (method) => {
      if (method === "getAgentTranscriptTail") return { entries: [] };
      if (method === "listAgents") return [{ id: "agent-1" }];
      if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
      return {};
    },
    ...(runProviderText == null ? {} : { runProviderText }),
  });
}

async function routedLogLines(events, predicate, steps = 120) {
  for (let i = 0; i < steps; i++) {
    const lines = events
      .filter((event) => event.family === "routed-log")
      .map((event) => event.payload?.line ?? "");
    if (predicate(lines)) return lines;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return events.filter((event) => event.family === "routed-log").map((event) => event.payload?.line ?? "");
}

test("routed turns broadcast live routed-log events with prompt shape and deadlines", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-turn-debug-live-"));
  try {
    await writeRouterSettings(dataDir);
    const events = [];
    const router = wiredRouter(loaded.module, dataDir, { events, runProviderText: async () => "all set" });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "say hi back to me", clientNonce: "n1" });
    const lines = await routedLogLines(events, (lines) => lines.some((line) => /turn-finish/.test(line)));
    assert.ok(lines.some((line) => /openrouter agent-1 turn-start think \d+ msgs \d+ chars/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /turn-deadline 90s/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /turn-finish/.test(line)), lines.join("\n"));
    const idle = await router.dispatch("stopRoutedTurn", { agentId: "agent-1" });
    assert.deepEqual(idle.value, { stopped: false });
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a turn cut by the real deadline logs turn-timeout, not turn-stop", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-turn-debug-timeout-"));
  try {
    await writeRouterSettings(dataDir);
    const events = [];
    const router = wiredRouter(loaded.module, dataDir, {
      events,
      turnTimeoutMs: 120,
      runProviderText: async (_provider, _messages, options) => {
        options.onTextDelta?.("partial answer", "partial answer");
        await new Promise((_, reject) => {
          const signal = options.abortSignal;
          const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        });
        return "late";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "slow one", clientNonce: "n1" });
    const lines = await routedLogLines(events, (lines) => lines.some((line) => /turn-timeout/.test(line)));
    assert.ok(lines.some((line) => /turn-deadline 0\.1s/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /turn-timeout/.test(line)), lines.join("\n"));
    assert.ok(lines.every((line) => !/turn-stop /.test(line)), lines.join("\n"));
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GROK_BOT_ROUTED_TRACE=prompt previews the coalesced prompt parts", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-turn-debug-trace-"));
  try {
    await writeRouterSettings(dataDir);
    process.env.GROK_BOT_ROUTED_TRACE = "prompt";
    const events = [];
    const router = wiredRouter(loaded.module, dataDir, { events, runProviderText: async () => "traced" });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "trace me", clientNonce: "n1" });
    const lines = await routedLogLines(events, (lines) => lines.some((line) => /turn-finish/.test(line)));
    assert.ok(lines.some((line) => /prompt-part \d+\/\d+ user trace me/.test(line)), lines.join("\n"));
  } finally {
    delete process.env.GROK_BOT_ROUTED_TRACE;
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the web shim streams routed-log lines into a hotkey overlay", async () => {
  const shim = await readFile(path.join(repoRoot, "source", "server-main", "web-shim.js"), "utf8");
  assert.match(shim, /family === "routed-log"/);
  assert.match(shim, /grok-bot-turn-debug/);
  assert.match(shim, /installTurnDebugOverlay\(\)/);
  assert.match(shim, /__grokBotTurnDebug/);
  assert.match(shim, /turnDebug: window\.__grokBotTurnDebug/);
  assert.match(shim, /gap \$\{\(\(now - lastEventAt\) \/ 1000\)\.toFixed\(1\)\}s without events/);
});

test("turn-tail helpers parse and classify routed log lines", async () => {
  const { parseTurnLogLine, classifyTurnLogMessage, renderTurnLogLine } = await import(pathToFileURL(path.join(repoRoot, "scripts", "turn-tail.mjs")).href);
  const parsed = parseTurnLogLine("2026-08-27T15:26:25.041Z openrouter agent-1 turn-start think 2 msgs 120 chars");
  assert.ok(parsed != null);
  assert.equal(parsed.provider, "openrouter");
  assert.equal(parsed.agentId, "agent-1");
  assert.equal(parsed.message, "turn-start think 2 msgs 120 chars");
  assert.equal(classifyTurnLogMessage("turn-timeout content OpenRouter HTTP 504"), "turn-timeout");
  assert.equal(classifyTurnLogMessage("tool-start box_chrome call-1"), "tool-start");
  assert.equal(classifyTurnLogMessage("stream reasoning-delta 120ms"), "stream");
  const plain = renderTurnLogLine(parsed, new Date(), false);
  assert.match(plain, /agent-1 turn-start think/);
  const colored = renderTurnLogLine(parsed, new Date(), true);
  assert.notEqual(colored, plain);
});
