import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
  const temporary = await mkdtemp(path.join(cacheRoot, "grok-inference-router-groups-"));
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

const MEMBER_ROSTER = [
  { id: "group-1", name: "Local, Alpha, Beta", isGroup: true, memberIds: ["alpha-1", "beta-1"] },
  { id: "alpha-1", name: "Alpha", description: "The alpha bot" },
  { id: "beta-1", name: "Beta", description: "The beta bot" },
];

function makeRouter(module, dataDir, overrides = {}) {
  const memberReplies = new Map([
    ["Alpha", "Hi, I am Alpha."],
    ["Beta", "(pass)"],
  ]);
  const seenMemberPrompts = [];
  return module.createCoordinatorInferenceRouter({
    dataDir,
    composingDelayMs: 0,
    now: () => 1_000,
    postEvent: () => {},
    dispatchRemote: async (method, args) => {
      if (method === "listAgents") return MEMBER_ROSTER.map(agent => ({ ...agent }));
      if (method === "getAgentTranscriptTail") return { entries: [] };
      return overrides.dispatchRemote?.(method, args) ?? {};
    },
    runProviderText: async (_provider, messages, options) => {
      const systemExtra = options?.systemExtra ?? "";
      const prompt = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
      seenMemberPrompts.push({ systemExtra, prompt });
      const memberName = /It's your turn, ([A-Za-z]+)\./.exec(prompt)?.[1]
        ?? (/You are ([A-Za-z]+), one participant/.exec(systemExtra)?.[1] ?? "Alpha");
      const base = overrides.reply?.(memberName, prompt, systemExtra) ?? memberReplies.get(memberName) ?? "ok";
      const reply = base === "(pass)" ? base : (/No new messages in the room since your last turn/.test(prompt) ? "(pass)" : base);
      if (options?.onTextDelta != null) options.onTextDelta(reply, reply);
      return reply;
    },
    ...overrides.router,
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  for (let i = 0; i < Math.ceil(timeoutMs / 25); i++) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

test("group sendPrompt runs member turns and posts attributed replies to the room", async () => {
  const { module, cleanup } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-groups-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
    const router = makeRouter(module, dataDir);
    const routed = await router.dispatch("sendPrompt", { agentId: "group-1", prompt: "introduce yourselves", clientNonce: "n1" });
    assert.deepEqual(routed, { handled: true, value: { accepted: true, clientNonce: "n1", provider: "openrouter" } });

    const tail = await router.dispatch("getAgentTranscriptTail", { id: "group-1" });
    const entries = tail.value?.entries ?? [];
    const userEntry = entries.find(entry => entry.role === "user");
    assert.ok(userEntry != null, "user entry missing from the room transcript");
    assert.equal(userEntry.fromUser?.name, "You");
    const memberReplies = entries.filter(entry => entry.author != null);
    assert.equal(memberReplies.length, 1, `expected only Alpha's reply, got ${JSON.stringify(entries)}`);
    assert.equal(memberReplies[0].author.id, "alpha-1");
    assert.equal(memberReplies[0].author.name, "Alpha");
    assert.equal(memberReplies[0].message.content, "Hi, I am Alpha.");
    assert.ok(!entries.some(entry => entry.author?.name === "Beta"), "passing member must not post");
  } finally {
    await cleanup();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("group member turns use the room system prompt and hide the exchange from the member transcript", async () => {
  const { module, cleanup } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-groups-sys-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
    const seen = [];
    const router = makeRouter(module, dataDir, {
      router: {
        // keep a hook: override after construction is impossible, so spy via runProviderText through closure
      },
      reply: (memberName, prompt, systemExtra) => {
        seen.push({ memberName, prompt, systemExtra });
        return `reply from ${memberName}`;
      },
    });
    await router.dispatch("sendPrompt", { agentId: "group-1", prompt: "hello room", clientNonce: "n1" });
    await waitFor(() => seen.length >= 1);
    const alpha = seen.find(entry => entry.memberName === "Alpha");
    assert.ok(alpha != null, "Alpha never ran");
    assert.ok(alpha.systemExtra.includes("You are Alpha, one participant in a group chat"), alpha.systemExtra.slice(0, 200));
    assert.ok(alpha.systemExtra.includes("Other participants in the room:"), "peers missing from the room system prompt");
    assert.ok(alpha.prompt.includes("[Group chat:"), "turn prompt missing the group tag");

    const memberTail = await router.dispatch("getAgentTranscriptTail", { id: "alpha-1" });
    const memberEntries = memberTail.value?.entries ?? [];
    assert.ok(!memberEntries.some(entry => entry.role === "user"), "hidden member turn must not append a user entry");
  } finally {
    await cleanup();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("group mentions target only the mentioned member", async () => {
  const { module, cleanup } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-groups-mention-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
    const ran = [];
    const router = makeRouter(module, dataDir, {
      reply: memberName => {
        ran.push(memberName);
        return memberName === "Beta" ? "hello from Beta" : "(pass)";
      },
    });
    await router.dispatch("sendPrompt", { agentId: "group-1", prompt: "@Beta say hi", clientNonce: "n1" });
    await waitFor(() => ran.length >= 1);
    assert.ok(ran.length >= 1 && ran.length <= 3, `unexpected member turn count: ${JSON.stringify(ran)}`);
    assert.ok(ran.every(name => name === "Beta"), `expected only Beta to run, got ${JSON.stringify(ran)}`);
  } finally {
    await cleanup();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test("projected group entries carry author and fromUser through the store", async () => {
  const { module, cleanup } = await loadRouter();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "routed-groups-proj-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(ROUTER_SETTINGS));
    const router = makeRouter(module, dataDir);
    await router.dispatch("sendPrompt", { agentId: "group-1", prompt: "round one", clientNonce: "n1" });
    await waitFor(async () => {
      const tail = await router.dispatch("getAgentTranscriptTail", { id: "group-1" });
      return (tail.value?.entries ?? []).some(entry => entry.author != null);
    });
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "group-1" });
    const reply = (tail.value?.entries ?? []).find(entry => entry.author != null);
    assert.ok(reply != null);
    assert.deepEqual(reply.author, { id: "alpha-1", name: "Alpha" });
    assert.equal(reply.streaming, undefined);
  } finally {
    await cleanup();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});
