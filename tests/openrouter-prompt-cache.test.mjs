import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-openrouter-prompt-cache-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/openrouter-prompt-cache.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("OpenRouter stream usage is requested for every model and parsed from SSE", async () => {
  const loaded = await loadModule();
  try {
    const openaiBody = loaded.module.injectOpenRouterStreamUsageIntoBody(JSON.stringify({
      model: "openai/gpt-4.1",
      messages: [{ role: "user", content: "hi" }],
    }));
    assert.equal(JSON.parse(openaiBody).stream_options.include_usage, true);

    const claudeBody = loaded.module.injectOpenRouterCacheControlIntoBody(JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: "hi" }],
    }), "anthropic/claude-sonnet-4.5");
    const withUsage = loaded.module.injectOpenRouterStreamUsageIntoBody(claudeBody);
    assert.equal(JSON.parse(withUsage).stream_options.include_usage, true);

    const usage = { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    loaded.module.applyOpenRouterSseUsage("data: {\"id\":\"1\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n", usage);
    assert.equal(usage.costUsd, 0);
    loaded.module.applyOpenRouterSseUsage("data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"cost\":0.0123,\"prompt_tokens_details\":{\"cached_tokens\":8},\"cache_creation_input_tokens\":2}}\n", usage);
    assert.equal(usage.costUsd, 0.0123);
    assert.equal(usage.cacheReadTokens, 8);
    assert.equal(usage.cacheWriteTokens, 2);

    const observed = { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    const sse = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
      "data: {\"usage\":{\"cost\":1.5,\"prompt_tokens_details\":{\"cached_tokens\":3}}}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const wrapped = loaded.module.observeOpenRouterSseUsage(new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }), observed);
    assert.equal(await wrapped.text(), sse);
    assert.equal(observed.costUsd, 1.5);
    assert.equal(observed.cacheReadTokens, 3);
  } finally {
    await loaded.dispose();
  }
});

test("OpenRouter cache control never exceeds four breakpoints", async () => {
  const loaded = await loadModule();
  try {
    const messages = [
      { role: "system", content: "sys-1" },
      { role: "system", content: "sys-2" },
      { role: "system", content: "sys-3" },
      { role: "user", content: "old" },
      { role: "assistant", content: "mid" },
      { role: "tool", content: "tool-out" },
      { role: "user", content: "latest" },
    ];
    const body = JSON.parse(loaded.module.injectOpenRouterCacheControlIntoBody(JSON.stringify({
      model: "anthropic/claude-sonnet-4",
      system: "top-system",
      tools: [{ name: "Computer", description: "d" }],
      messages,
    }), "anthropic/claude-sonnet-4"));
    let markers = 0;
    if (body.system?.some?.((part) => part.cache_control != null) || body.system?.cache_control != null) markers += 1;
    if (Array.isArray(body.tools) && body.tools.at(-1)?.cache_control != null) markers += 1;
    for (const message of body.messages) {
      const content = Array.isArray(message.content) ? message.content : [];
      if (content.some((part) => part.cache_control != null)) markers += 1;
    }
    assert.equal(markers <= 4, true, `expected at most 4 cache_control breakpoints, found ${markers}`);
  } finally {
    await loaded.dispose();
  }
});
