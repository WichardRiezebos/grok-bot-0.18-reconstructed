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
  } finally {
    await loaded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
