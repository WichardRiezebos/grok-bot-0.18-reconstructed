import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-port-"));
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

test("repeated hello clears in-flight requests so the same requestId can be reused", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/renderer-port-server.ts");
  try {
    const posted = [];
    const server = loaded.module.createRendererPortServer({
      post(frame) { posted.push(frame); },
      close() {},
    }, {
      dispatchRequest(_method, _args, signal) {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const hello = { kind: "lifecycle", phase: "hello", protocolVersion: 1 };
    server.handleMessage(hello);
    server.handleMessage({ kind: "request", requestId: "r-1", method: "ping", args: {} });
    server.handleMessage(hello);
    server.handleMessage({ kind: "request", requestId: "r-1", method: "ping", args: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(posted.some((frame) => frame.kind === "lifecycle" && frame.phase === "shutdown"), false);
    assert.equal(posted.filter((frame) => frame.kind === "lifecycle" && frame.phase === "ready").length, 2);
    const settled = await Promise.race([
      server.settled.then((value) => value),
      new Promise((resolve) => setTimeout(() => resolve("still-open"), 30)),
    ]);
    assert.equal(settled, "still-open");
  } finally {
    await loaded.dispose();
  }
});
