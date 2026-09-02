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
  const temporary = await mkdtemp(path.join(cacheRoot, "routed-agent-mgmt-"));
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

test("routed agents can create a bot that wakes with its brief, and rename themselves", async () => {
  const { module } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-agent-mgmt-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
    const events = [];
    const roster = [{ id: "agent-1", name: "Jarvis" }];
    const profileWrites = [];
    const toolCalls = [];
    const createdTurns = [];
    const router = module.createCoordinatorInferenceRouter({
      dataDir,
      composingDelayMs: 0,
      now: () => 1_000,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method, args) => {
        if (method === "listAgents") return roster.map((agent) => ({ ...agent }));
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "createAgent") {
          profileWrites.push({ method, args });
          const id = `agent-${roster.length + 1}`;
          roster.push({ id, name: args.name ?? "New bot", description: args.description });
          createdTurns.push(id);
          return { agent: { id, name: args.name ?? "New bot" } };
        }
        if (method === "updateAgent") profileWrites.push({ method, args });
        return {};
      },
      runProviderText: async (_provider, _messages, options) => {
        if (options.onTextDelta != null) options.onTextDelta("ok", "ok");
        if (toolCalls.length > 0) {
          const next = toolCalls.shift();
          await options.executeTool({ name: next.name, toolName: next.name, providerIdentifier: "grok-bot-agents" }, next.args, next.callId);
        }
        return "done";
      },
    });
    toolCalls.push({ name: "CreateAgent", args: { description: "Lunch companion bot who loves tacos." }, callId: "c1" });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "spawn a lunch bot", clientNonce: "n1" });
    for (let i = 0; i < 120; i++) {
      if (events.some((event) => event.family === "routed-log" && /create-agent agent-2/.test(event.payload?.line ?? ""))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const create = profileWrites.find((write) => write.method === "createAgent");
    assert.ok(create != null, "createAgent was not dispatched");
    assert.equal(create.args.description, "Lunch companion bot who loves tacos.");
    assert.ok(createdTurns.includes("agent-2"), "the new bot never got its introduction wake");
    const lines = events.filter((event) => event.family === "routed-log").map((event) => event.payload?.line ?? "");
    assert.ok(lines.some((line) => /create-agent agent-2/.test(line)), lines.join("\n"));

    toolCalls.push({ name: "UpdateAgent", args: { name: "Hunger", description: "You handle lunch plans with enthusiasm." }, callId: "c2" });
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "also handle dinner", clientNonce: "n2" });
    for (let i = 0; i < 120; i++) {
      if (profileWrites.some((write) => write.method === "updateAgent")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const update = profileWrites.find((write) => write.method === "updateAgent");
    assert.ok(update != null, "updateAgent was not dispatched");
    assert.equal(update.args.id, "agent-1");
    assert.equal(update.args.name, "Hunger");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
