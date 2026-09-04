import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROUTER_SETTINGS = {
  version: 1, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false,
  webauthnProxyEnabled: true, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {},
  mcpDisabledToolsByServerId: {}, conciergeConsent: "unset", settingsMigrations: [],
  inferenceProvider: "openrouter",
};

async function loadRouter() {
  const cacheRoot = path.join(repoRoot, "node_modules/.cache");
  const temporary = await mkdtemp(path.join(cacheRoot, "grok-router-approvals-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, cleanup: () => rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) };
}

const ROSTER = [{ id: "agent-1", name: "Solo" }];

const COMPUTER_TOOL_NAME = "Computer";
const COMPUTER_TOOL_CALL = { name: COMPUTER_TOOL_NAME, args: {}, callId: "c1" };

async function makeApprovalHarness(module, dataDir, settings, options = {}) {
  const toolExecutions = [];
  const router = module.createCoordinatorInferenceRouter({
    dataDir,
    composingDelayMs: 0,
    now: () => 1_000,
    postEvent: () => {},
    dispatchRemote: async (method, args) => {
      if (method === "listAgents") return ROSTER.map(agent => ({ ...agent }));
      if (method === "getAgentTranscriptTail") return { entries: [] };
      if (method === "listRoutedMcpTools") return [{ name: "computer_screenshot", description: "screenshot", providerIdentifier: "computer", toolName: "computer_screenshot" }];
      if (method === "executeRoutedComputerTool") {
        toolExecutions.push(args);
        return { content: [{ type: "text", text: "screenshot ok" }] };
      }
      return options.dispatchRemote?.(method, args) ?? {};
    },
    runProviderText: async (_provider, _messages, hook) => {
      if (options.modelText != null) {
        if (options.modelText && options.onDelta) options.onDelta(hook);
        return options.modelText;
      }
      if (hook?.executeTool != null && options.triggerTool !== false) {
        await hook.executeTool({ name: COMPUTER_TOOL_NAME, toolName: COMPUTER_TOOL_NAME, providerIdentifier: "computer" }, COMPUTER_TOOL_CALL.args, COMPUTER_TOOL_CALL.callId);
      }
      return options.modelText ?? "done";
    },
  });
  return { router, toolExecutions };
}

async function waitFor(predicate, timeoutMs = 5000) {
  for (let i = 0; i < Math.ceil(timeoutMs / 25); i++) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

test("computer tools park on an approval widget and resume when approved", async () => {
  const { module, cleanup } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-approvals-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ ...ROUTER_SETTINGS, autoReviewInstructions: { isEnabled: true, allowInstructions: ["be careful with the computer"], blockInstructions: ["never delete files"] } }));
    const { router, toolExecutions } = await makeApprovalHarness(module, dataDir);
    const send = router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "take a screenshot", clientNonce: "n1" });

    let widgetEntry = null;
    assert.ok(await waitFor(async () => {
      const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
      widgetEntry = (tail.value?.entries ?? []).find(entry => entry.message?.type === "auto-review-approval") ?? null;
      return widgetEntry != null;
    }), "approval widget never rendered");
    assert.equal(widgetEntry.message.approval.status, "pending");
    assert.ok(widgetEntry.message.approval.requestId.length > 0);
    assert.equal(toolExecutions.length, 0, "the tool ran before approval");

    const resolved = await router.dispatch("resolveAutoReviewApproval", {
      agentId: "agent-1",
      entryId: widgetEntry.id,
      requestId: widgetEntry.message.approval.requestId,
      resolution: "approved",
    });
    assert.equal(resolved.handled, true);
    assert.equal(resolved.value, true);

    await send;
    assert.equal(toolExecutions.length, 1, "the tool never ran after approval");

    // the card settled to allowed
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
    const settled = (tail.value?.entries ?? []).find(entry => entry.message?.type === "auto-review-approval");
    assert.equal(settled.message.approval.status, "allowed");
  } finally {
    await cleanup();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("denied approvals refuse the tool", async () => {
  const { module, cleanup } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-approvals-deny-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ ...ROUTER_SETTINGS, autoReviewInstructions: { isEnabled: true, allowInstructions: ["be careful with the computer"], blockInstructions: ["never delete files"] } }));
    const { router, toolExecutions } = await makeApprovalHarness(module, dataDir);
    const send = router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "take a screenshot", clientNonce: "n1" });
    let widget = null;
    assert.ok(await waitFor(async () => {
      const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
      widget = (tail.value?.entries ?? []).find(entry => entry.message?.type === "auto-review-approval") ?? null;
      return widget != null;
    }), "widget missing");
    await router.dispatch("resolveAutoReviewApproval", { agentId: "agent-1", entryId: widget.id, requestId: widget.message.approval.requestId, resolution: "denied" });
    await send;
    assert.equal(toolExecutions.length, 0, "a denied tool must not run");
  } finally {
    await cleanup();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("block rules deny computer tools without a widget", async () => {
  const { module, cleanup } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-approvals-block-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ ...ROUTER_SETTINGS, autoReviewInstructions: { isEnabled: true, allowInstructions: [], blockInstructions: ["never open other websites"] } }));
    const { router, toolExecutions } = await makeApprovalHarness(module, dataDir);
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "take a screenshot", clientNonce: "n1" });
    await waitFor(async () => (await router.dispatch("getAgentTranscriptTail", { id: "agent-1" })).value?.entries?.length > 0);
    assert.equal(toolExecutions.length, 0);
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
    assert.ok(!((tail.value?.entries ?? []).some(entry => entry.message?.type === "auto-review-approval")), "no widget should render for blocked tools");
  } finally {
    await cleanup();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("auto-review disabled lets computer tools run directly", async () => {
  const { module, cleanup } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-approvals-off-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ ...ROUTER_SETTINGS, autoReviewInstructions: { isEnabled: false, allowInstructions: [], blockInstructions: [] } }));
    const { router, toolExecutions } = await makeApprovalHarness(module, dataDir);
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "take a screenshot", clientNonce: "n1" });
    assert.ok(await waitFor(() => toolExecutions.length > 0), "tool never ran with auto-review off");
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
    assert.ok(!((tail.value?.entries ?? []).some(entry => entry.message?.type === "auto-review-approval")));
  } finally {
    await cleanup();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});
