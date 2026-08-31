import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-openrouter-prompt-budget-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/openrouter-prompt-budget.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function imagePart(id) {
  return { type: "image_url", image_url: { url: `data:image/webp;base64,${id.repeat(24)}` } };
}

test("OpenRouter prompt budget keeps the newest screenshots and trims older history", async () => {
  const loaded = await loadModule();
  try {
    assert.equal(loaded.module.OPENROUTER_PROMPT_KEEP_RECENT_IMAGES, 3);
    assert.equal(loaded.module.OPENROUTER_PROMPT_CHAR_BUDGET, 1_200_000);
    assert.equal(loaded.module.boundOpenRouterRequestBody(undefined), undefined);
    assert.equal(loaded.module.boundOpenRouterRequestBody("{"), "{");

    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "one" },
      { role: "tool", content: [imagePart("aaaa"), { type: "text", text: "shot-1" }] },
      { role: "tool", content: [imagePart("bbbb"), { type: "text", text: "shot-2" }] },
      { role: "tool", content: [imagePart("cccc"), { type: "text", text: "shot-3" }] },
      { role: "tool", content: [imagePart("dddd"), { type: "text", text: "shot-4" }] },
      { role: "user", content: "now" },
    ];
    const bounded = JSON.parse(loaded.module.boundOpenRouterRequestBody(JSON.stringify({
      model: "openai/gpt-4.1",
      messages,
    })));
    assert.equal(bounded.model, "openai/gpt-4.1");
    assert.equal(bounded.messages[2].content[0].text, loaded.module.OPENROUTER_PROMPT_REMOVED_IMAGE_TEXT);
    assert.equal(bounded.messages[3].content[0].image_url.url.includes("bbbb"), true);
    assert.equal(bounded.messages[5].content[0].image_url.url.includes("dddd"), true);

    const bulky = [
      { role: "system", content: "keep-system" },
      { role: "user", content: "old-turn ".repeat(40) },
      { role: "assistant", content: "old-answer ".repeat(40) },
      { role: "tool", content: [{ type: "text", text: "tool-blob ".repeat(80) }] },
      { role: "user", content: "latest" },
    ];
    const trimmed = loaded.module.boundOpenRouterMessages(bulky, { charBudget: 180, keepRecentImages: 3 });
    assert.equal(trimmed[0].content, "keep-system");
    assert.equal(trimmed.at(-1).content, "latest");
    assert.equal(trimmed.some((message) => message.role === "user" && message.content.includes("old-turn")), false);
    const leftoverTool = trimmed.find((message) => message.role === "tool");
    if (leftoverTool != null) {
      assert.match(leftoverTool.content[0].text, /\[truncated\]/);
    }
  } finally {
    await loaded.dispose();
  }
});

test("OpenRouter prompt budget keeps assistant tool_calls paired with tool replies", async () => {
  const loaded = await loadModule();
  try {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "calling", tool_calls: [{ id: "call-1", type: "function", function: { name: "Computer" } }] },
      { role: "tool", tool_call_id: "call-1", content: "ok ".repeat(80) },
      { role: "user", content: "latest" },
    ];
    const trimmed = loaded.module.boundOpenRouterMessages(messages, { charBudget: 120, keepRecentImages: 3 });
    const roles = trimmed.map((message) => message.role);
    assert.equal(roles[0], "system");
    assert.equal(roles.at(-1), "user");
    const toolIndex = roles.lastIndexOf("tool");
    if (toolIndex >= 0) {
      assert.equal(roles[toolIndex - 1], "assistant");
      assert.ok(Array.isArray(trimmed[toolIndex - 1].tool_calls));
    }
  } finally {
    await loaded.dispose();
  }
});

test("OpenRouter prompt budget never leaves an orphan tool reply when the transcript ends with one", async () => {
  const loaded = await loadModule();
  try {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "calling", tool_calls: [{ id: "call-1", type: "function", function: { name: "Computer" } }] },
      { role: "tool", tool_call_id: "call-1", content: "ok ".repeat(80) },
    ];
    const trimmed = loaded.module.boundOpenRouterMessages(messages, { charBudget: 120, keepRecentImages: 3 });
    const roles = trimmed.map((message) => message.role);
    for (let index = 0; index < roles.length; index += 1) {
      if (roles[index] !== "tool") continue;
      assert.equal(roles[index - 1], "assistant", "tool reply must be preceded by its assistant tool_calls message");
      assert.ok(Array.isArray(trimmed[index - 1].tool_calls));
    }
  } finally {
    await loaded.dispose();
  }
});
