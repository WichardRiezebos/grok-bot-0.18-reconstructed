import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-openrouter-models-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("OpenRouter catalog pins recommended models first and keeps the current selection", async () => {
  const loaded = await loadModule("source/shared/openrouter-models.ts");
  try {
    const models = loaded.module.parseOpenRouterCatalog({
      data: [
        { id: "openai/gpt-4.1", name: "GPT-4.1", architecture: { output_modalities: ["text"] } },
        { id: "acme/image-only", name: "Image Only", architecture: { output_modalities: ["image"] } },
        { id: "z-vendor/zeta", name: "Zeta", architecture: { output_modalities: ["text"] } },
        { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", architecture: { output_modalities: ["text"] } },
        { id: "a-vendor/alpha", name: "Alpha", architecture: { output_modalities: ["text"] } },
        { id: "x-ai/grok-4", name: "Grok 4", architecture: { output_modalities: ["text"] } },
      ],
    }, "Mu");
    assert.deepEqual(models.map((model) => model.id), [
      "x-ai/grok-4",
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4.1",
      "a-vendor/alpha",
      "Mu",
      "z-vendor/zeta",
    ]);
    assert.equal(models[0].recommended, true);
    assert.equal(models.find((model) => model.id === "a-vendor/alpha").recommended, false);
    assert.equal(models.some((model) => model.id === "acme/image-only"), false);
    assert.equal(loaded.module.openRouterModelLabel(models[1]), "Recommended · Claude Sonnet 4.5");
    assert.equal(loaded.module.DEFAULT_OPENROUTER_MODEL, "openai/gpt-4.1");
    assert.equal(loaded.module.DEFAULT_OPENROUTER_COMPUTER_MODEL, undefined);
    assert.equal(loaded.module.resolveOpenRouterModel(undefined, ""), "openai/gpt-4.1");
    assert.equal(loaded.module.resolveOpenRouterModel("stored/model", " env/model "), "env/model");
    assert.equal(loaded.module.resolveOpenRouterComputerModel(undefined, "chat/model"), "chat/model");
    assert.equal(loaded.module.resolveOpenRouterComputerModel("computer/model", "chat/model"), "computer/model");
    assert.equal(loaded.module.resolveOpenRouterComputerModel("stored/computer", "chat/model", " env/computer "), "env/computer");
    assert.equal(loaded.module.DEFAULT_OPENROUTER_REASONING_EFFORT, "medium");
    assert.equal(loaded.module.DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT, "low");
    assert.equal(loaded.module.isOpenRouterReasoningEffort("xhigh"), true);
    assert.equal(loaded.module.isOpenRouterReasoningEffort("max"), false);
    assert.equal(loaded.module.resolveOpenRouterReasoningEffort(undefined, "medium"), "medium");
    assert.equal(loaded.module.resolveOpenRouterReasoningEffort("high", "medium"), "high");
    assert.equal(loaded.module.resolveOpenRouterReasoningEffort("high", "medium", "low"), "low");
    assert.deepEqual(loaded.module.openRouterReasoningRequest("high"), { effort: "high", exclude: false });
    assert.equal(loaded.module.openRouterReasoningRequest("none"), undefined);
    assert.equal(loaded.module.normalizeOpenRouterModelId("~x-ai/grok-latest"), "x-ai/grok-latest");
    assert.equal(loaded.module.injectOpenRouterReasoningIntoBody(undefined, "low"), undefined);
    assert.deepEqual(JSON.parse(loaded.module.injectOpenRouterReasoningIntoBody(JSON.stringify({ model: "qwen/qwen3.7-flash" }), "low")).reasoning, { effort: "low", exclude: false });
    assert.equal(JSON.parse(loaded.module.injectOpenRouterReasoningIntoBody(JSON.stringify({ model: "qwen/qwen3.7-flash", reasoning: { effort: "low" } }), "none")).reasoning, undefined);
    assert.deepEqual(loaded.module.parseOpenRouterCatalog({ data: [{ id: "openai/gpt-4.1", architecture: { output_modalities: ["text"] } }] }, ["openai/gpt-4.1", "qwen/qwen3.7-flash"]).map((model) => model.id).sort(), ["openai/gpt-4.1", "qwen/qwen3.7-flash"]);
  } finally {
    await loaded.dispose();
  }
});
