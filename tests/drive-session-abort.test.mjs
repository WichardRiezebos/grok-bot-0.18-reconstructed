import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let agentInstances = [];
let promptImpl = null;

const canModuleMock = typeof mock.module === "function";
const moduleTest = canModuleMock ? test : test.skip;
if (canModuleMock) {
  mock.module("@earendil-works/pi-agent-core", {
    exports: {
      Agent: class FakeAgent {
        constructor(options) {
          this.options = options;
          this.tools = options.initialState.tools;
          this.subscribers = [];
          agentInstances.push(this);
        }
        subscribe(listener) {
          this.subscribers.push(listener);
        }
        abort() {}
        async prompt(text) {
          if (promptImpl != null) await promptImpl(text);
        }
        get state() {
          return { errorMessage: "", messages: [] };
        }
      },
    },
  });
}

async function loadDriveSessionModule() {
  const cacheRoot = path.join(repoRoot, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(cacheRoot, "grok-drive-session-abort-"));
  const output = path.join(temporary, "pi-drive-session.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/pi-drive-session.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function routedStopErrorStub() {
  return Object.assign(new Error("Stopped."), { name: "RoutedTurnAbortError", kind: "stop" });
}

const SESSION = {
  messages: [{ role: "user", content: "order lunch from Jumbo" }],
  tools: [{ name: "observe_ui", description: "outline the page", inputSchema: { type: "object", properties: {} } }],
  executeTool: async () => ({ ok: true }),
  modelId: "z-ai/glm-5.3-flash",
  apiKey: "test-key",
};

moduleTest("a Drive tool aborted by a reasonless stall surfaces the routed timeout error, not a fabricated Stopped.", async () => {
  const loaded = await loadDriveSessionModule();
  try {
    promptImpl = async () => undefined;
    agentInstances = [];
    await loaded.module.runPiDriveSession({ ...SESSION, abortSignal: new AbortController().signal });
    const tool = agentInstances.at(-1)?.tools?.at(-1);
    assert.ok(tool != null, "drive tools were not registered");
    const stalled = new AbortController();
    stalled.abort("service stalled");
    await assert.rejects(
      () => tool.execute("call-1", {}, stalled.signal),
      (error) => error.message === "The routed request timed out.",
    );
  } finally {
    await loaded.dispose();
  }
});

moduleTest("a Drive tool abort on a real user stop keeps the routed stop error", async () => {
  const loaded = await loadDriveSessionModule();
  try {
    promptImpl = async () => undefined;
    agentInstances = [];
    await loaded.module.runPiDriveSession({ ...SESSION, abortSignal: new AbortController().signal });
    const tool = agentInstances.at(-1)?.tools?.at(-1);
    assert.ok(tool != null, "drive tools were not registered");
    const stopped = new AbortController();
    stopped.abort(routedStopErrorStub());
    await assert.rejects(
      () => tool.execute("call-1", {}, stopped.signal),
      (error) => error.name === "RoutedTurnAbortError" && error.kind === "stop",
    );
  } finally {
    await loaded.dispose();
  }
});

moduleTest("a Drive prompt throw that races a stall is classified as the routed abort, not the raw provider error", async () => {
  const loaded = await loadDriveSessionModule();
  try {
    const controller = new AbortController();
    promptImpl = async () => {
      controller.abort("service stalled");
      throw new Error("Stopped. tool pipeline blew up");
    };
    await assert.rejects(
      () => loaded.module.runPiDriveSession({ ...SESSION, abortSignal: controller.signal }),
      (error) => error.message === "The routed request timed out.",
    );
  } finally {
    await loaded.dispose();
  }
});

moduleTest("a Drive prompt throw that races a real user stop propagates the routed stop error", async () => {
  const loaded = await loadDriveSessionModule();
  try {
    const controller = new AbortController();
    const stopError = routedStopErrorStub();
    promptImpl = async () => {
      controller.abort(stopError);
      throw new Error("Stopped. tool pipeline blew up");
    };
    await assert.rejects(
      () => loaded.module.runPiDriveSession({ ...SESSION, abortSignal: controller.signal }),
      (error) => error.name === "RoutedTurnAbortError" && error.kind === "stop",
    );
  } finally {
    await loaded.dispose();
  }
});

moduleTest("a provider failure without an abort still surfaces the raw error from the Drive session", async () => {
  const loaded = await loadDriveSessionModule();
  try {
    promptImpl = async () => {
      throw new Error("OpenRouter HTTP 502");
    };
    await assert.rejects(
      () => loaded.module.runPiDriveSession({ ...SESSION, abortSignal: new AbortController().signal }),
      (error) => error.message === "OpenRouter HTTP 502",
    );
  } finally {
    await loaded.dispose();
  }
});
