import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-sand-settings-store-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("settings store drops the leftover qwen computer model so Computer inherits chat", async () => {
  const loaded = await loadModule();
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-settings-qwen-"));
  const settingsPath = path.join(directory, "settings.json");
  try {
    await writeFile(settingsPath, JSON.stringify({
      version: 1,
      mcpBoxServers: [],
      autoUpdateWhenIdleOptIn: false,
      egressTunnelEnabled: false,
      webauthnProxyEnabled: true,
      mcpCustomInstructions: {},
      mcpCustomInstructionsByServerId: {},
      mcpDisabledToolsByServerId: {},
      conciergeConsent: "unset",
      settingsMigrations: ["downgrade-persisted-max-fast"],
      openRouterModel: "anthropic/claude-sonnet-4.5",
      openRouterComputerModel: "qwen/qwen3.7-flash",
    }));
    const store = new loaded.module.SandSettingsStore(settingsPath);
    assert.equal(store.getOpenRouterComputerModel(), undefined);
    assert.equal(store.getOpenRouterModel(), "anthropic/claude-sonnet-4.5");
    const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(persisted.openRouterComputerModel, undefined);
    assert.equal(persisted.settingsMigrations.includes(loaded.module.SAND_DROP_QWEN_COMPUTER_MODEL_MIGRATION_ID), true);

    store.setOpenRouterComputerModel("qwen/qwen3.7-flash");
    assert.equal(store.getOpenRouterComputerModel(), "qwen/qwen3.7-flash");
    assert.equal(store.getOpenRouterSummarizeModel(), undefined);
    store.setOpenRouterSummarizeModel("google/gemini-2.5-flash");
    assert.equal(store.getOpenRouterSummarizeModel(), "google/gemini-2.5-flash");
    store.setOpenRouterSummarizeModel(undefined);
    assert.equal(store.getOpenRouterSummarizeModel(), undefined);
  } finally {
    await loaded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings store clamps boxAutoSuspendIdleMs to the idle presets", async () => {
  const loaded = await loadModule();
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-settings-idle-"));
  const settingsPath = path.join(directory, "settings.json");
  try {
    const store = new loaded.module.SandSettingsStore(settingsPath);
    assert.equal(store.getBoxAutoSuspendIdleMs(), 30 * 60_000);

    store.setBoxAutoSuspendIdleMs(0);
    assert.equal(store.getBoxAutoSuspendIdleMs(), 0);
    store.setBoxAutoSuspendIdleMs(15 * 60_000);
    assert.equal(store.getBoxAutoSuspendIdleMs(), 15 * 60_000);
    store.setBoxAutoSuspendIdleMs(60 * 60_000);
    assert.equal(store.getBoxAutoSuspendIdleMs(), 60 * 60_000);
    store.setBoxAutoSuspendIdleMs(2 * 60 * 60_000);
    assert.equal(store.getBoxAutoSuspendIdleMs(), 2 * 60 * 60_000);
    store.setBoxAutoSuspendIdleMs(20 * 60_000);
    assert.equal(store.getBoxAutoSuspendIdleMs(), 15 * 60_000);
    store.setBoxAutoSuspendIdleMs(-1);
    assert.equal(store.getBoxAutoSuspendIdleMs(), 30 * 60_000);
    store.setBoxAutoSuspendIdleMs(Number.NaN);
    assert.equal(store.getBoxAutoSuspendIdleMs(), 30 * 60_000);

    await writeFile(settingsPath, JSON.stringify({
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
      boxAutoSuspendIdleMs: 45 * 60_000,
    }));
    const reloaded = new loaded.module.SandSettingsStore(settingsPath);
    assert.equal(reloaded.getBoxAutoSuspendIdleMs(), 30 * 60_000);
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).boxAutoSuspendIdleMs, 30 * 60_000);
  } finally {
    await loaded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recordInferenceUsage re-reads settings before persisting the increment", async () => {
  const loaded = await loadModule();
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-settings-usage-"));
  const settingsPath = path.join(directory, "settings.json");
  try {
    const store = new loaded.module.SandSettingsStore(settingsPath);
    store.setLocalProfileName("Ada");
    store.recordInferenceUsage("openrouter", { inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
    const other = new loaded.module.SandSettingsStore(settingsPath);
    other.setLocalProfileEmail("ada@example.com");
    store.recordInferenceUsage("openrouter", { inputTokens: 5, outputTokens: 1, costUsd: 0.02 });
    const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(persisted.localProfileName, "Ada");
    assert.equal(persisted.localProfileEmail, "ada@example.com");
    assert.equal(persisted.inferenceRouterUsage.providers.openrouter.requests, 2);
    assert.equal(persisted.inferenceRouterUsage.providers.openrouter.inputTokens, 15);
    assert.equal(persisted.inferenceRouterUsage.providers.openrouter.costUsd, 0.03);
  } finally {
    await loaded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
