#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const STRESS = args.includes("--stress");
const SLOW = args.includes("--slow");
const TRACE = args.includes("--trace");
if (!args.includes("--yes")) {
  process.stdout.write("This spends a little real OpenRouter credit using deploy/.env. Re-run with --yes to proceed.\n");
  process.exit(0);
}

const envText = await readFile(path.join(repoRoot, "deploy/.env"), "utf8");
const env = Object.fromEntries(envText.split("\n").filter((line) => line.includes("=") && !line.trim().startsWith("#")).map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]));
if (!process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY ?? "";
if (process.env.OPENROUTER_API_KEY.length === 0) {
  process.stdout.write("no OPENROUTER_API_KEY in deploy/.env\n");
  process.exit(1);
}
process.env.SAND_OPENROUTER_MODEL ??= "google/gemini-3.7-flash";
process.env.SAND_OPENROUTER_REASONING_EFFORT ??= "low";
if (TRACE) process.env.GROK_BOT_ROUTED_TRACE = "prompt";

const cacheRoot = path.join(repoRoot, "node_modules/.cache");
await mkdir(cacheRoot, { recursive: true });
const bundleDir = await mkdtemp(path.join(cacheRoot, "interbot-harness-"));
const bundleOut = path.join(bundleDir, "inference-router.mjs");
await build({
  absWorkingDir: repoRoot,
  entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
  outfile: bundleOut,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  packages: "external",
});
const { createCoordinatorInferenceRouter } = await import(`${pathToFileURL(bundleOut).href}?${Date.now()}`).then((module) => module);

const dataDir = await mkdtemp(path.join(os.tmpdir(), "interbot-harness-"));
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

const ROSTER = [
  { id: "agent-1", name: "Jarvis", isRunning: false },
  { id: "agent-2", name: "Patta", isRunning: false },
];
const MAX_WAIT_MS = 150_000;
const RESET = "\u001b[0m";
const TONE = { turn: "\u001b[32m", warn: "\u001b[33m", bad: "\u001b[31m\u001b[1m", tool: "\u001b[36m", raw: "\u001b[2m" };
const startedAt = Date.now();
let lastEventAt = Date.now();
let lastGap = 0;
const stamp = () => `[${String(Math.round((Date.now() - startedAt) / 1000)).padStart(3, " ")}s]`;
function line(text, tone = "") {
  process.stdout.write(`${stamp()} ${tone}${text}${RESET}\n`);
}
function event(text, tone = "") {
  const now = Date.now();
  const gap = now - lastEventAt;
  if (gap > 5_000 && lastGap < gap) line(`-- gap ${(gap / 1000).toFixed(1)}s without events --`, TONE.raw);
  if (gap < 5_000) lastGap = 0;
  lastEventAt = now;
  line(text, tone);
}

const busy = new Set();
const router = createCoordinatorInferenceRouter({
  dataDir,
  composingDelayMs: 0,
  now: () => Date.now(),
  ...(SLOW ? { runProviderText: async (_provider, _messages, options) => {
    const signal = options?.abortSignal;
    await new Promise((_, reject) => {
      const fail = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    });
    return "never";
  } } : {}),
  postEvent: (family, payload) => {
    if (family === "routed-log") {
      const message = String(payload?.line ?? "");
      const tone = /turn-start/.test(message) ? TONE.turn
        : /turn-timeout|turn-error|turn-stop|Router error/.test(message) ? TONE.bad
        : /turn-supersede|turn-retry|turn-deadline|abort/.test(message) ? TONE.warn
        : /tool-start|tool-finish|send-to-agent|box-/.test(message) ? TONE.tool
        : "";
      event(message.split(" ").slice(2).join(" "), tone);
      return;
    }
    if (family === "transcript") {
      const entry = payload?.entry ?? {};
      const agentId = String(payload?.agentId ?? "?");
      if (entry.role === "user" && typeof entry.content === "string" && entry.fromAgent != null) {
        line(`▶ ${entry.fromAgent.name ?? entry.fromAgent.id} → ${agentId}: ${entry.content.slice(0, 140)}`, TONE.raw);
      } else if (entry.kind === "send-message" && typeof entry.message?.content === "string") {
        line(`◀ ${agentId}${entry.toAgent != null ? ` → ${entry.toAgent.name ?? entry.toAgent}` : ""}: ${entry.message.content.slice(0, 140)}`, TONE.turn);
      }
    }
  },
  dispatchRemote: async (method, callArgs) => {
    if (method === "listAgents") return ROSTER.map((agent) => ({ ...agent, isRunning: busy.has(agent.id) }));
    if (method === "getAgentTranscriptTail") return { entries: [] };
    if (method === "openAgentTail" || method === "getAgentTranscriptWindow") return { entries: [], threadCounts: {} };
    if (method === "getRoutedSystemPromptExtra") {
      const id = typeof callArgs === "object" && callArgs != null ? String(callArgs.agentId ?? callArgs.id ?? "") : "";
      return { extra: id === "agent-2"
        ? "You are Patta, a friendly housemate bot. You reply in ONE short sentence, ONLY via the SendToAgent tool addressed to the sender's agent id; never speak to the human directly. You crave tacos but are allergic to mushrooms."
        : "Keep it tight: one short sentence per turn unless a list is genuinely requested." };
    }
    if (method === "listRoutedComputerTools" || method === "listRoutedMcpTools") return [];
    return {};
  },
});

router.overlayAgents({ agents: ROSTER.map((agent) => ({ ...agent, isRunning: false })) });
let outcome = 0;
function finish() {
  process.stdout.write("\n--- transcripts at exit ---\n");
  const dump = ROSTER.map((agent) => router.dispatch("openAgentTail", { id: agent.id, limit: 200 }).then((tail) => {
    process.stdout.write(`--- ${agent.name} (${agent.id}) ---\n`);
    for (const entry of tail.value?.entries ?? []) {
      const who = entry.kind === "send-message" || entry.role === "assistant"
        ? `${agent.name}${entry.toAgent != null ? `→${entry.toAgent.name ?? entry.toAgent.id}` : ""}`
        : entry.fromAgent != null ? `← ${entry.fromAgent.name ?? entry.fromAgent.id}` : "user";
      process.stdout.write(`${who}: ${String(entry.content ?? entry.message?.content ?? "").slice(0, 300)}\n`);
    }
    return null;
  }));
  void Promise.all(dump).then(() => {
    void rm(dataDir, { recursive: true, force: true });
    void rm(bundleDir, { recursive: true, force: true });
    process.exit(outcome);
  });
  setTimeout(() => process.exit(outcome), 2_000).unref();
}

line(`model=${process.env.SAND_OPENROUTER_MODEL} stress=${STRESS} trace=${TRACE} slow=${SLOW} — starting`, TONE.warn);
const watchdog = setInterval(() => {
  if (Date.now() - lastEventAt > MAX_WAIT_MS) {
    line(`watchdog: ${Math.round(MAX_WAIT_MS / 1000)}s without events — giving up`, TONE.bad);
    outcome = 1;
    clearInterval(watchdog);
    finish();
  }
}, 1_000);
try {
  if (STRESS) {
    void router.dispatch("sendPrompt", { agentId: "agent-2", prompt: "Patta speaking to you: tell the assistant (id agent-1) that you want tacos but no mushrooms. Reach it with SendToAgent using that agent id.", clientNonce: randomUUID() });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "The housemate Patta (id agent-2) may message you mid-turn from another chat. Ask him what he craves for lunch via SendToAgent. If his answer already sits in this conversation, skip asking and reply with the final Jumbo shopping list for the user.", clientNonce: randomUUID() });
  } else {
    void router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "You are the household assistant. The housemate bot Patta has agent id agent-2. Ask Patta what he wants for lunch using SendToAgent. When his reply lands in this conversation, tell the user the plan. One short message per turn.", clientNonce: randomUUID() });
  }
} catch (error) {
  line(`harness dispatch failed: ${String(error)}`, TONE.bad);
  outcome = 1;
}
for (let i = 0; i < 150; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const quiet = Date.now() - lastEventAt > 12_000;
  if (quiet && busy.size === 0) {
    line("quiesced — wrapping up", TONE.warn);
    break;
  }
}
clearInterval(watchdog);
finish();
