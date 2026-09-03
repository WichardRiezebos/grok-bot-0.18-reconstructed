import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-deadline-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    absWorkingDir: repoRoot,
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

function createClient(module, overrides = {}) {
  return new module.CoordinatorGatewayClient({
    resolveConnection: async () => ({ baseUrl: "http://gateway.test" }),
    timing: module.createCoordinatorGatewayClientTiming(),
    onEvent: () => {},
    ...overrides,
  });
}

test("command() rejects with gateway-unreachable timeout when the gateway never answers", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/gateway/gateway-client.ts");
  const previousFetch = globalThis.fetch;
  const previousTimeout = process.env.SAND_GATEWAY_REQUEST_TIMEOUT_MS;
  process.env.SAND_GATEWAY_REQUEST_TIMEOUT_MS = "150";
  globalThis.fetch = () => new Promise(() => {});
  try {
    const client = createClient(loaded.module);
    const started = Date.now();
    await assert.rejects(
      client.command("listAgents", {}),
      (error) => error.name === "SandGatewayUnreachableError" && error.kind === "timeout" && /unreachable \(timeout\)/u.test(error.message),
    );
    assert.ok(Date.now() - started < 10_000, "the deadline fired instead of hanging");
    client.close();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTimeout === undefined) delete process.env.SAND_GATEWAY_REQUEST_TIMEOUT_MS;
    else process.env.SAND_GATEWAY_REQUEST_TIMEOUT_MS = previousTimeout;
    await loaded.dispose();
  }
});

test("command() honors the caller's abort signal even when fetch ignores it", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/gateway/gateway-client.ts");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const client = createClient(loaded.module);
    const controller = new AbortController();
    const pending = client.command("listAgents", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException("caller cancelled", "AbortError")), 30);
    await assert.rejects(pending, (error) => error.name === "AbortError" || error.name === "SandGatewayUnreachableError");
    client.close();
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});

test("command() still resolves normally for a healthy gateway", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/gateway/gateway-client.ts");
  const previousFetch = globalThis.fetch;
  let postedUrl = "";
  globalThis.fetch = async (input, init) => {
    postedUrl = String(input);
    return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = createClient(loaded.module);
    const result = await client.command("listAgents", {});
    assert.deepEqual(result, { agents: [] });
    assert.ok(postedUrl.startsWith("http://gateway.test/"), `unexpected request url ${postedUrl}`);
    client.close();
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});

test("command() surfaces non-5xx gateway errors as command errors, not timeouts", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/gateway/gateway-client.ts");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "nope" }), { status: 400 });
  try {
    const client = createClient(loaded.module);
    await assert.rejects(client.command("deleteAgent", {}), loaded.module.SandGatewayCommandError);
    client.close();
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});
