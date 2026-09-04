import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    assert.equal(schedule.module.describeTrigger(trigger), "When new Gmail arrives");
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

test("routine editor maps Gmail into the trigger picker shape", async () => {
  const loaded = await loadModule("frontend/src/recovered/features/automations/routines/trigger-schema.ts");
  try {
    const form = loaded.module.createRoutineTriggerForm("composio");
    assert.deepEqual(form, { platform: "composio", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" });
    assert.deepEqual(loaded.module.routineTriggerFormToListener(form), { type: "composio", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" });
    assert.deepEqual(loaded.module.routineTriggerToForms({ type: "composio", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" }), [form]);
    assert.deepEqual(loaded.module.describeRoutineTrigger(form), { lead: "New", rest: "Gmail messages" });
  } finally {
    await loaded.dispose();
  }
});

test("shipped renderer patch adds Gmail to Add trigger on the 0.39 web renderer", async () => {
  const { cp, mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
  const stage = await mkdtemp(path.join(tmpdir(), "grok-composio-triggers-stage-"));
  try {
    await cp(path.join(repoRoot, "deploy/control/shipped-renderer"), path.join(stage, "dist/renderer"), { recursive: true });
    const { applyOriginalRendererRouterPatch } = await import("../scripts/lib/router-renderer-patch.mjs");
    const record = await applyOriginalRendererRouterPatch({ stageRoot: stage });
    assert.equal(record.mode, "original-renderer-039-settings-extension");
    const assets = path.join(stage, "dist/renderer/assets");
    const files = await readdir(assets);
    const mainName = files.find((name) => name.startsWith("index-") && name.endsWith(".js"));
    assert.ok(mainName != null, "main chunk is staged");
    const main = await readFile(path.join(assets, mainName), "utf8");
    assert.match(main, /\{id:"router",label:\{id:"Router"\},icon:"git-branch"/);
    assert.match(main, /case"composio":return\{platform:"composio",triggerSlug:"GMAIL_NEW_GMAIL_MESSAGE"\}/);
    assert.ok(main.includes('if(t.platform==="composio"){const i=String(t.triggerSlug??"").trim();return i.length===0?null:{type:"composio",triggerSlug:i}}'));
    const automation = await readFile(path.join(assets, "chunk-automation-detail-panel-CHAr4QC1.js"), "utf8");
    assert.match(automation, /onSelect:\(\)=>Z\("composio"\)/);
    assert.match(automation, /children:"New Gmail message"/);
    assert.match(automation, /case"composio":return t\.jsx\(Ae,\{name:"mail",size:"md"\}\)/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
