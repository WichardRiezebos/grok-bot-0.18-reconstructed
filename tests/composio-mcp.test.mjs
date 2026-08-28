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

async function loadModule() {
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-composio-mcp-"));
  const output = path.join(temporary, "module.cjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "source/shared/node/composio-mcp.ts")],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
  });
  return { module: require(output), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("Connect ck_ keys use the consumer MCP header", async () => {
  const loaded = await loadModule();
  try {
    const config = loaded.module.composioMcpRuntimeConfig("ck_example");
    assert.equal(config.mcpServers.composio.url, "https://connect.composio.dev/mcp");
    assert.equal(config.mcpServers.composio.headers["x-consumer-api-key"], "ck_example");
    const resolved = await loaded.module.resolveComposioMcpRuntimeConfig("ck_example");
    assert.deepEqual(resolved, config);
  } finally {
    await loaded.dispose();
  }
});

test("project ak_ keys open a tool-router MCP session with Gmail pinned", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("connected_accounts")) {
      return new Response(JSON.stringify({
        items: [{ id: "ca_gmail", status: "ACTIVE", user_id: "user-1", toolkit: { slug: "gmail" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      session_id: "trs_test",
      mcp: { type: "http", url: "https://backend.composio.dev/tool_router/trs_test/mcp" },
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    assert.deepEqual(loaded.module.composioMcpRuntimeConfig("ak_example"), { mcpServers: {} });
    const config = await loaded.module.resolveComposioMcpRuntimeConfig("ak_example");
    assert.equal(config.mcpServers.composio.url, "https://backend.composio.dev/tool_router/trs_test/mcp");
    assert.equal(config.mcpServers.composio.headers["x-api-key"], "ak_example");
    assert.ok(calls.some((call) => call.url.includes("/api/v3/connected_accounts")));
    assert.ok(calls.some((call) => call.body.includes("ca_gmail") && call.body.includes("user-1")));
    const again = await loaded.module.resolveComposioMcpRuntimeConfig("ak_example");
    assert.equal(again.mcpServers.composio.url, config.mcpServers.composio.url);
    assert.equal(calls.filter((call) => call.url.includes("tool_router/session")).length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});
