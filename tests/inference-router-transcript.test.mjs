import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-transcript-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("routed transcript preserves structured MCP mention rich text across reload", async () => {
  const loaded = await loadModule();
  try {
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "mcp:3213107", label: "Gmail" } },
        { type: "text", text: " what's new?" },
      ] }],
    });
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "user",
          content: "@Gmail what's new?",
          richText,
          id: "t1u",
          clientNonce: "nonce-1",
          timestampMs: 123,
        }],
      },
    });
    const projected = loaded.module.projectInferenceRouterTranscriptEntry(store.agents.agent[0]);
    assert.equal(projected.richText, richText);
    assert.deepEqual(JSON.parse(projected.richText).content[0].content[0], {
      type: "mention",
      attrs: { id: "mcp:3213107", label: "Gmail" },
    });
  } finally {
    await loaded.dispose();
  }
});

test("routed transcript rejects malformed rich text carriers", async () => {
  const loaded = await loadModule();
  try {
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "user", content: "@Gmail", richText: {}, id: "t1u", timestampMs: 123 }],
      },
    });
    assert.deepEqual(store.agents.agent, []);
  } finally {
    await loaded.dispose();
  }
});

test("routed turn error settles the in-flight assistant without a second bubble", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-settle-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
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
    }));
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        options.onTextDelta?.("Opened plus.nl", "Opened plus.nl");
        options.onProgress?.("Using Computer…");
        throw new Error("The operation was aborted due to timeout");
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hi", clientNonce: "n1" });
    let assistant = [];
    for (let i = 0; i < 80; i++) {
      assistant = events
        .filter((event) => event.family === "transcript" && event.payload?.entry?.kind === "send-message")
        .map((event) => event.payload.entry);
      if (assistant.some((entry) => entry.streaming === false && String(entry.message?.content).includes("aborted due to timeout"))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual([...new Set(assistant.map((entry) => entry.id))], ["t0s0"]);
    assert.equal(assistant.at(-1).streaming, false);
    assert.match(assistant.at(-1).message.content, /Opened plus\.nl/);
    assert.match(assistant.at(-1).message.content, /aborted due to timeout/);
    assert.equal(assistant.some((entry) => entry.streaming === true && String(entry.message.content).includes("Using Computer…")), true);
    const running = events
      .filter((event) => event.family === "agents")
      .flatMap((event) => event.payload.agents ?? [])
      .filter((agent) => agent.id === "agent-1" && agent.isRunning === true);
    assert.equal(running.some((agent) => agent.isComposingMessage === true && agent.currentActivity?.kind === "thinking"), true);
    assert.equal(running.some((agent) => agent.isComposingMessage === false && agent.currentActivity?.kind === "tool" && agent.currentActivity?.tool === "Computer"), true);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("routed turn settles the first acknowledgment and final text, not tool-step narration", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-steps-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
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
    }));
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools") {
          return [{ name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" }];
        }
        if (method === "listRoutedMcpTools") return [];
        if (method === "executeRoutedComputerTool") return { ok: true };
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        options.onTextDelta?.("I'll check plus.nl.", "I'll check plus.nl.");
        options.onStreamEvent?.({ type: "step-finish", elapsedMs: 12 });
        options.onTextDelta?.("Clicking lunch.", "Clicking lunch.");
        await options.executeTool(
          { name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" },
          { action: "click", x: 1, y: 2 },
          "call-1",
        );
        options.onStreamEvent?.({ type: "step-finish", elapsedMs: 34 });
        options.onTextDelta?.("Found the lunch deal.", "Found the lunch deal.");
        options.onStreamEvent?.({ type: "step-finish", elapsedMs: 56 });
        return "Found the lunch deal.";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "lunch", clientNonce: "n1" });
    let settled = [];
    for (let i = 0; i < 80; i++) {
      settled = events
        .filter((event) => event.family === "transcript" && event.payload?.entry?.kind === "send-message" && event.payload?.entry?.streaming === false)
        .map((event) => event.payload.entry);
      if (settled.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual([...new Set(settled.map((entry) => entry.id))], ["t0s0", "t0s2"]);
    assert.equal(settled[0].message.content, "I'll check plus.nl.");
    assert.equal(settled[1].message.content, "Found the lunch deal.");
    assert.equal(settled.some((entry) => String(entry.message?.content).includes("Clicking lunch")), false);
    assert.equal(settled.some((entry) => entry.id === "t0s1"), false);
    assert.deepEqual(
      loaded.module.coalesceRoutedProviderMessages([
        { role: "user", content: "lunch" },
        { role: "assistant", content: "Opening plus.nl." },
        { role: "assistant", content: "Clicked lunch." },
      ]),
      [{ role: "user", content: "lunch" }, { role: "assistant", content: "Opening plus.nl.\n\nClicked lunch." }],
    );
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("screenshot-only Computer loops stop before another desktop call", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-screenshot-loop-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
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
    }));
    const remoteCalls = [];
    const toolResults = [];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method, args) => {
        remoteCalls.push(method);
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools") {
          return [{ name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" }];
        }
        if (method === "listRoutedMcpTools") return [];
        if (method === "executeRoutedComputerTool") return { ok: true };
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        const definition = { name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" };
        for (let i = 0; i < 4; i++) {
          toolResults.push(await options.executeTool(definition, { action: "screenshot" }, `call-${i}`));
        }
        return "done";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "lunch", clientNonce: "n1" });
    for (let i = 0; i < 80; i++) {
      const done = events.some((event) => event.family === "transcript" && event.payload?.entry?.streaming === false);
      if (done && toolResults.length === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(remoteCalls.filter((method) => method === "executeRoutedComputerTool").length, 3);
    assert.match(JSON.stringify(toolResults.at(-1)), /Stop taking screenshots/);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("request_box_help emits a take-over card and blocks later Computer calls", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-box-help-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
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
    }));
    const remoteCalls = [];
    const toolResults = [];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        remoteCalls.push(method);
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools") {
          return [
            { name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" },
            { name: "request_box_help", providerIdentifier: "grok-bot-computer", toolName: "request_box_help" },
          ];
        }
        if (method === "listRoutedMcpTools") return [];
        if (method === "executeRoutedComputerTool") {
          return {
            result: {
              case: "success",
              value: {
                content: [{ content: { case: "text", value: { text: "Handed the box to the user." } } }],
                isError: false,
                handoff: { requestId: "help-1", instruction: "Sign in to Plus" },
              },
            },
          };
        }
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        const help = { name: "request_box_help", providerIdentifier: "grok-bot-computer", toolName: "request_box_help" };
        const computer = { name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" };
        toolResults.push(await options.executeTool(help, { instruction: "Sign in to Plus", reason: "auth" }, "call-help"));
        toolResults.push(await options.executeTool(computer, { action: "click", x: 10, y: 20 }, "call-click"));
        return "waiting";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "lunch", clientNonce: "n1" });
    for (let i = 0; i < 80; i++) {
      const done = events.some((event) => event.family === "transcript" && event.payload?.entry?.id === "t0s0" && event.payload?.entry?.streaming === false);
      if (done && toolResults.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(remoteCalls.filter((method) => method === "executeRoutedComputerTool").length, 1);
    assert.match(JSON.stringify(toolResults.at(-1)), /The user has the box/);
    const handoff = events
      .filter((event) => event.family === "transcript" && event.payload?.entry?.boxRequestId === "help-1")
      .map((event) => event.payload.entry);
    assert.equal(handoff.length, 1);
    assert.equal(handoff[0].id, "t0s1");
    assert.equal(handoff[0].boxInstruction, "Sign in to Plus");
    const projected = loaded.module.projectInferenceRouterTranscriptEntry({
      provider: "openrouter",
      role: "assistant",
      content: "Sign in to Plus",
      id: "t0s1",
      timestampMs: 1_000,
      boxRequestId: "help-1",
      boxInstruction: "Sign in to Plus",
    });
    assert.equal(projected.boxRequestId, "help-1");
    assert.equal(projected.boxInstruction, "Sign in to Plus");
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("routed turn retries transient no-progress errors before settling", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-retry-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
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
    }));
    const events = [];
    let attempts = 0;
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      retryBackoffMs: [0, 0],
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
        return {};
      },
      runProviderText: async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("Rate limited");
          error.statusCode = 429;
          throw error;
        }
        return "recovered";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hi", clientNonce: "n1" });
    let settled = [];
    for (let i = 0; i < 80; i++) {
      settled = events
        .filter((event) => event.family === "transcript" && event.payload?.entry?.kind === "send-message" && event.payload?.entry?.streaming === false)
        .map((event) => event.payload.entry);
      if (settled.some((entry) => entry.message?.content === "recovered")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(attempts, 3);
    assert.equal(settled.at(-1).message.content, "recovered");
    assert.equal(settled.some((entry) => String(entry.message?.content).includes("Router error")), false);
    assert.equal(loaded.module.isRoutedTransientProviderError(Object.assign(new Error("Rate limited"), { statusCode: 429 })), true);
    assert.equal(loaded.module.isRoutedPromptOverflowError(new Error("This model's maximum prompt length is 500000")), true);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("routed turn does not retry after streamed text, and retries overflow once", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-retry-progress-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
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
    }));
    const streamedEvents = [];
    let streamedAttempts = 0;
    const streamed = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      retryBackoffMs: [0, 0],
      now: () => 1_000,
      postEvent: (family, payload) => streamedEvents.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        streamedAttempts += 1;
        options.onTextDelta?.("hello", "hello");
        const error = new Error("Rate limited");
        error.statusCode = 429;
        throw error;
      },
    });
    await streamed.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hi", clientNonce: "n1" });
    let streamedSettled = [];
    for (let i = 0; i < 80; i++) {
      streamedSettled = streamedEvents
        .filter((event) => event.family === "transcript" && event.payload?.entry?.kind === "send-message" && event.payload?.entry?.streaming === false)
        .map((event) => event.payload.entry);
      if (streamedSettled.some((entry) => String(entry.message?.content).includes("Router error"))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(streamedAttempts, 1);
    assert.match(streamedSettled.at(-1).message.content, /hello/);
    assert.match(streamedSettled.at(-1).message.content, /Router error/);

    const overflowEvents = [];
    let overflowAttempts = 0;
    const overflow = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      retryBackoffMs: [0, 0],
      now: () => 2_000,
      postEvent: (family, payload) => overflowEvents.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-2" }];
        if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
        return {};
      },
      runProviderText: async () => {
        overflowAttempts += 1;
        throw new Error("Provider returned error: This model's maximum prompt length is 500000 but the request contains 567521 tokens.");
      },
    });
    await overflow.dispatch("sendPrompt", { agentId: "agent-2", prompt: "hi", clientNonce: "n2" });
    let overflowSettled = [];
    for (let i = 0; i < 80; i++) {
      overflowSettled = overflowEvents
        .filter((event) => event.family === "transcript" && event.payload?.entry?.kind === "send-message" && event.payload?.entry?.streaming === false)
        .map((event) => event.payload.entry);
      if (overflowSettled.some((entry) => String(entry.message?.content).includes("maximum prompt length"))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(overflowAttempts, 2);
    assert.match(overflowSettled.at(-1).message.content, /maximum prompt length/);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

function routerSettings() {
  return JSON.stringify({
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
  });
}

test("settled assistant emit happens only after persistence is visible in the tail", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-persist-emit-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), routerSettings());
    const events = [];
    const tailsAtEmit = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => {
        events.push({ family, payload });
        if (family === "transcript" && payload?.entry?.kind === "send-message" && payload?.entry?.streaming === false) {
          tailsAtEmit.push(router.dispatch("getAgentTranscriptTail", { id: "agent-1" }));
        }
      },
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        options.onTextDelta?.("hello there", "hello there");
        options.onStreamEvent?.({ type: "step-finish", elapsedMs: 8 });
        return "hello there";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hi", clientNonce: "n1" });
    for (let i = 0; i < 80; i++) {
      if (tailsAtEmit.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const tails = await Promise.all(tailsAtEmit);
    assert.equal(tails.length > 0, true);
    for (const tail of tails) {
      const entries = tail.value.entries ?? [];
      assert.equal(entries.some((entry) => entry.id === "t0s0" && entry.message?.content === "hello there"), true);
    }
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("tail merge includes the in-progress streaming entry and drops it after settle", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-live-merge-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), routerSettings());
    const events = [];
    let midTail;
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        options.onTextDelta?.("partial reply", "partial reply");
        midTail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
        options.onStreamEvent?.({ type: "step-finish", elapsedMs: 4 });
        return "partial reply";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hi", clientNonce: "n1" });
    for (let i = 0; i < 80; i++) {
      const done = events.some((event) => event.family === "transcript" && event.payload?.entry?.id === "t0s0" && event.payload?.entry?.streaming === false);
      if (done && midTail != null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const live = (midTail?.value.entries ?? []).find((entry) => entry.id === "t0s0");
    assert.equal(live?.streaming, true);
    assert.equal(live?.message?.content, "partial reply");
    const settled = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
    const after = (settled.value.entries ?? []).filter((entry) => entry.id === "t0s0");
    assert.equal(after.length, 1);
    assert.equal(after[0].streaming, undefined);
    assert.equal(after[0].message?.content, "partial reply");
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("sendPrompt replies with the generated clientNonce immediately", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-nonce-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
      version: 1,
      mcpBoxServers: [],
      autoUpdateWhenIdleOptIn: false,
      egressTunnelEnabled: false,
      webauthnProxyEnabled: true,
      mcpCustomInstructions: {},
      mcpCustomInstructionsByServerId: {},
      conciergeConsent: "unset",
      settingsMigrations: [],
      inferenceProvider: "openrouter",
    }));
    const events = [];
    let finished = false;
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
        return {};
      },
      runProviderText: async () => "done",
    });
    const result = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hi" });
    assert.equal(result.handled, true);
    assert.equal(result.value.accepted, true);
    assert.equal(typeof result.value.clientNonce, "string");
    assert.notEqual(result.value.clientNonce, "");
    for (let i = 0; i < 80; i++) {
      finished = events.some((event) => event.family === "transcript" && event.payload?.entry?.id === "t0s0" && event.payload?.entry?.streaming === false);
      if (finished) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(finished, true);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("first-step click narration is discarded when a tool ran in that step", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-discard-click-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), routerSettings());
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1" }];
        if (method === "listRoutedComputerTools") {
          return [{ name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" }];
        }
        if (method === "listRoutedMcpTools") return [];
        if (method === "executeRoutedComputerTool") return { ok: true };
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        options.onTextDelta?.("I've clicked the cheese.");
        await options.executeTool(
          { name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" },
          { action: "click", x: 1, y: 2 },
          "call-1",
        );
        options.onStreamEvent?.({ type: "step-finish", elapsedMs: 12 });
        options.onTextDelta?.("The product page is open.");
        options.onStreamEvent?.({ type: "step-finish", elapsedMs: 20 });
        return "The product page is open.";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "shop", clientNonce: "n1" });
    let settled = [];
    for (let i = 0; i < 80; i++) {
      settled = events
        .filter((event) => event.family === "transcript" && event.payload?.entry?.kind === "send-message" && event.payload?.entry?.streaming === false)
        .map((event) => event.payload.entry);
      if (settled.some((entry) => entry.message?.content === "The product page is open.")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(settled.some((entry) => String(entry.message?.content).includes("I've clicked")), false);
    assert.equal(settled.at(-1).message.content, "The product page is open.");
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("computer turns auto-open box Chrome when the user named a site", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-router-box-chrome-auto-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), routerSettings());
    const remoteCalls = [];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method, args) => {
        remoteCalls.push({ method, args });
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent-1", lastEntry: null }];
        if (method === "listRoutedComputerTools") {
          return [{ name: "Computer", providerIdentifier: "grok-bot-computer", toolName: "Computer" }];
        }
        if (method === "listRoutedMcpTools") return [];
        if (method === "executeRoutedComputerTool") return { ok: true };
        return {};
      },
      runProviderText: async () => "Looking at plus.nl.",
    });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "order cheese from plus.nl in basket", clientNonce: "n1" });
    for (let i = 0; i < 80; i++) {
      const done = events.some((event) => event.family === "transcript" && event.payload?.entry?.streaming === false);
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const auto = remoteCalls.find((call) => call.method === "executeRoutedComputerTool" && call.args?.name === "box_chrome");
    assert.equal(auto?.args?.args?.url, "https://plus.nl/");
    remoteCalls.length = 0;
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "keep going on plus.nl", clientNonce: "n2" });
    for (let i = 0; i < 80; i++) {
      const done = events.filter((event) => event.family === "transcript" && event.payload?.entry?.streaming === false).length >= 2;
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const secondAuto = remoteCalls.find((call) => call.method === "executeRoutedComputerTool" && call.args?.name === "box_chrome");
    assert.equal(secondAuto, undefined);
    const roster = await router.dispatch("listAgents", {});
    const row = roster.value.find((agent) => agent.id === "agent-1");
    assert.equal(row.lastEntry.kind, "text");
    assert.match(row.lastEntry.text, /plus\.nl|Looking at plus\.nl/);
  } finally {
    await loaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("overlay fills roster lastEntry from the routed store", async () => {
  const loaded = await loadModule();
  try {
    const overlaid = loaded.module.overlayRoutedRosterLastEntry(
      [{ id: "agent-1", lastEntry: null, lastMessagePreview: null }, { id: "agent-2" }],
      {
        agents: {
          "agent-1": [{ id: "t1u", content: "order cheese from plus.nl", timestampMs: 9_999 }],
        },
      },
    );
    assert.deepEqual(overlaid[0].lastEntry, { kind: "text", text: "order cheese from plus.nl" });
    assert.equal(overlaid[0].lastMessageId, "t1u");
    assert.equal(overlaid[0].lastMessagePreview, "order cheese from plus.nl");
    assert.equal(overlaid[0].updatedAt, 9_999);
    assert.equal(overlaid[1].lastEntry, undefined);
  } finally {
    await loaded.dispose();
  }
});