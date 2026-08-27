import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const cacheRoot = path.join(repoRoot, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(cacheRoot, "grok-coordinator-inspect-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("coordinator inspect fork passes --inspect and pipes stdio only when enabled", async () => {
  const loaded = await loadModule("source/electron-main/coordinator/coordinator-inspect.ts");
  try {
    assert.equal(loaded.module.parseCoordinatorInspectPort(undefined), undefined);
    assert.equal(loaded.module.parseCoordinatorInspectPort("0"), undefined);
    assert.equal(loaded.module.parseCoordinatorInspectPort("1"), 9229);
    assert.equal(loaded.module.parseCoordinatorInspectPort("9230"), 9230);
    assert.deepEqual(loaded.module.coordinatorInspectForkOptions({}), {});
    assert.deepEqual(loaded.module.coordinatorInspectForkOptions({ GROK_BOT_INSPECT_COORDINATOR: "1" }), {
      execArgv: ["--inspect=9229"],
      stdio: "pipe",
      inspectPort: 9229,
    });
    const lines = [];
    loaded.module.attachCoordinatorStdio({
      stderr: {
        on(_event, listener) {
          listener("Debugger listening on ws://127.0.0.1:9229/abc\n2026-08-27T15:26:25.041Z openrouter agent-1 turn-error timeout\nnode-agent-coordinator: unhandledRejection: TimeoutError\n");
        },
      },
    }, line => lines.push(line), 9229);
    assert.match(lines[0], /coordinator inspector listening on 127\.0\.0\.1:9229/);
    assert.match(lines[1], /Debugger listening on ws:\/\/127\.0\.0\.1:9229/);
    assert.equal(lines.some((line) => line.includes("turn-error")), false);
    assert.match(lines.at(-1), /node-agent-coordinator: unhandledRejection/);
  } finally {
    await loaded.dispose();
  }
});

test("routed stream progress and router errors stay human-readable", async () => {
  const loaded = await loadModule("source/shared/routed-inference-log.ts");
  try {
    assert.equal(loaded.module.routedStreamProgressLine({ type: "tool-call", toolName: "Computer" }), "Using Computer…");
    assert.equal(loaded.module.routedStreamProgressLine({ type: "reasoning" }), "Thinking…");
    assert.equal(loaded.module.routedRouterErrorText(new Error("timed out")), "Router error: timed out");
    const retry = new Error("Failed after 3 attempts. Last error: Provider returned error");
    retry.errors = [Object.assign(new Error("Provider returned error"), {
      statusCode: 400,
      data: { error: { message: "x-ai/grok-latest is not a valid model ID" } },
    })];
    assert.match(loaded.module.routedRouterErrorText(retry), /x-ai\/grok-latest is not a valid model ID/);
    assert.equal(
      loaded.module.routedSettledAssistantContent("Opened plus.nl", new Error("The operation was aborted due to timeout")),
      "Opened plus.nl\n\nRouter error: The operation was aborted due to timeout",
    );
    assert.equal(loaded.module.isRoutedInferenceLogLine("2026-08-27T15:26:25.041Z openrouter agent-1 turn-error timeout"), true);
    assert.equal(loaded.module.isRoutedInferenceLogLine("Debugger listening on ws://127.0.0.1:9229/abc"), false);
    const rejections = [];
    const onUnhandled = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectWork;
      const work = new Promise((_, reject) => { rejectWork = reject; });
      const controller = new AbortController();
      const pending = loaded.module.awaitAbortRace(work, controller.signal, () => new Error("timed out"));
      controller.abort(new Error("timed out"));
      await assert.rejects(pending, /timed out/);
      rejectWork(new Error("late stream reject"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(rejections.length, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.match(loaded.module.formatRoutedInferenceLogLine("stream tool-call Computer 12ms"), /stream tool-call Computer 12ms/);
  } finally {
    await loaded.dispose();
  }
});

test("reconstructed packaged app allows DevTools unless explicitly disabled", async () => {
  const loaded = await loadModule("source/electron-main/devtools-gate.ts");
  try {
    assert.equal(loaded.module.reconstructedDevToolsAllowed({}, false), true);
    assert.equal(loaded.module.reconstructedDevToolsAllowed({}, true), true);
    assert.equal(loaded.module.reconstructedDevToolsAllowed({ GROK_BOT_DEVTOOLS: "1" }, true), true);
    assert.equal(loaded.module.reconstructedDevToolsAllowed({ GROK_BOT_DEVTOOLS: "0" }, true), false);
    const gate = loaded.module.createDevToolsGate({ isDevBuild: true });
    assert.equal(gate.isAllowed(), true);
    gate.setMembership("denied");
    assert.equal(gate.isAllowed(), true);
  } finally {
    await loaded.dispose();
  }
});
