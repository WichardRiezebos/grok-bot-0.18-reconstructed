import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-composio-triggers-"));
  const output = path.join(temporary, "module.cjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
  });
  return { module: require(output), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("composio routine triggers parse, describe, and match webhook events", async () => {
  const loaded = await loadModule("source/host/automations/automation-trigger.ts");
  const schedule = await loadModule("source/shared/automation-schedule.ts");
  try {
    const trigger = loaded.module.parseStoredTrigger({ type: "composio", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" });
    assert.deepEqual(trigger, { type: "composio", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" });
    assert.equal(schedule.module.describeTrigger(trigger), "When Composio GMAIL_NEW_GMAIL_MESSAGE fires");
    const event = { source: "composio", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", data: { id: "m1" } };
    assert.equal(loaded.module.triggerMatchesEvent(trigger, event), true);
    assert.equal(loaded.module.triggerMatchesEvent(trigger, { source: "composio", triggerSlug: "LINEAR_ISSUE_CREATED" }), false);
    assert.match(loaded.module.describeTriggerEvent(event), /GMAIL_NEW_GMAIL_MESSAGE/);
    assert.match(loaded.module.buildTriggerEventContextBlock(event), /<gmail_event>/);
  } finally {
    await loaded.dispose();
    await schedule.dispose();
  }
});

test("automations system prompt teaches the composio trigger shape", async () => {
  const loaded = await loadModule("source/host/automations/automation.ts");
  try {
    const prompt = loaded.module.renderAutomationsSystemPrompt([], "/home/box/routines");
    assert.match(prompt, /"type": "composio"/);
    assert.match(prompt, /GMAIL_NEW_GMAIL_MESSAGE/);
    assert.match(prompt, /<composio_event>/);
  } finally {
    await loaded.dispose();
  }
});
