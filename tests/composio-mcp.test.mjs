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

test("project ak_ keys keep a composio HTTP server when the tool-router session fails", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("connected_accounts")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("session down", { status: 503 });
  };
  try {
    const config = await loaded.module.resolveComposioMcpRuntimeConfig("ak_fallback");
    assert.equal(config.mcpServers.composio.url, loaded.module.COMPOSIO_TOOLS_URL);
    assert.equal(config.mcpServers.composio.headers["x-api-key"], "ak_fallback");
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});

test("capComposioModelTools prefers Gmail and respects the model limit", () => {
  return loadModule().then(async (loaded) => {
    try {
      const tools = [
        { name: "SLACK_SEND_MESSAGE", toolName: "SLACK_SEND_MESSAGE", providerIdentifier: "composio", description: "slack", inputSchema: {}, toolkit: "slack" },
        { name: "GMAIL_SETTINGS", toolName: "GMAIL_SETTINGS", providerIdentifier: "composio", description: "settings", inputSchema: {}, toolkit: "gmail" },
        { name: "GMAIL_FETCH_EMAILS", toolName: "GMAIL_FETCH_EMAILS", providerIdentifier: "composio", description: "fetch", inputSchema: {}, toolkit: "gmail" },
        { name: "GITHUB_CREATE_ISSUE", toolName: "GITHUB_CREATE_ISSUE", providerIdentifier: "composio", description: "gh", inputSchema: {}, toolkit: "github" },
      ];
      const capped = loaded.module.capComposioModelTools(tools, 2);
      assert.deepEqual(capped.map((tool) => tool.name), ["GMAIL_FETCH_EMAILS", "GITHUB_CREATE_ISSUE"]);
      const gmailOnly = loaded.module.capComposioModelTools(tools.filter((tool) => tool.toolkit === "gmail"), 2);
      assert.deepEqual(gmailOnly.map((tool) => tool.name), ["GMAIL_FETCH_EMAILS", "GMAIL_SETTINGS"]);
    } finally {
      await loaded.dispose();
    }
  });
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("project ak_ keys list Gmail REST tools and execute without Cursor", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url.includes("connected_accounts")) {
      return jsonResponse({
        items: [{ id: "ca_gmail", status: "ACTIVE", user_id: "user-1", toolkit: { slug: "gmail" } }],
      });
    }
    if (url.includes("/tools/execute/")) {
      return jsonResponse({ successful: true, data: { messages: 1 } });
    }
    if (url.includes("/api/v3.1/tools")) {
      return jsonResponse({
        items: [
          { slug: "GMAIL_FETCH_EMAILS", description: "Fetch Gmail threads", toolkit: { slug: "gmail" }, input_parameters: { type: "object", properties: { query: { type: "string" } } } },
          { slug: "GMAIL_SEND_EMAIL", description: "Send mail", toolkit: { slug: "gmail" } },
        ],
      });
    }
    return jsonResponse({}, 404);
  };
  try {
    loaded.module.resetComposioCachesForTests();
    const innerCalls = [];
    const wrapped = loaded.module.wrapBackendMcpExecWithComposio({
      async listTools(ids) {
        innerCalls.push(["list", ids]);
        if (ids.includes("composio")) throw new Error("Cursor dashboard should not list composio");
        return [];
      },
      async executeTool(args) {
        innerCalls.push(["execute", args]);
        throw new Error("Cursor dashboard should not execute composio");
      },
    }, () => "ak_gmail");
    const servers = await wrapped.listTools(["composio"]);
    assert.equal(innerCalls.length, 0);
    assert.equal(servers[0]?.status, "connected");
    assert.ok(servers[0]?.tools.some((tool) => tool.name === "GMAIL_FETCH_EMAILS"));
    assert.ok(calls.some((call) => call.url.includes("toolkit_slug=gmail") && !call.url.includes("/execute/")));
    const result = await wrapped.executeTool({
      serverIdentifier: "composio",
      toolName: "GMAIL_FETCH_EMAILS",
      args: { query: "in:inbox" },
    });
    assert.equal(innerCalls.length, 0);
    assert.equal(result.result.case, "success");
    const execute = calls.find((call) => call.url.includes("/tools/execute/GMAIL_FETCH_EMAILS"));
    assert.ok(execute);
    assert.match(execute.body, /user-1/);
    assert.match(execute.body, /ca_gmail/);
    await wrapped.listTools(["other"]);
    assert.deepEqual(innerCalls[0], ["list", ["other"]]);
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});

test("Connect ck_ keys list tools through local HTTP MCP, not Cursor", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    methods.push(body.method);
    assert.match(String(input), /connect\.composio\.dev\/mcp/);
    if (body.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }, 200, { "mcp-session-id": "sess-1" });
    }
    if (body.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "GMAIL_FETCH_EMAILS", description: "Fetch", inputSchema: { type: "object", properties: {} } },
            { name: "SLACK_SEND_MESSAGE", description: "Slack" },
          ],
        },
      });
    }
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: {} });
  };
  try {
    loaded.module.resetComposioCachesForTests();
    const tools = await loaded.module.listComposioConnectMcpTools("ck_example");
    assert.equal(tools[0]?.name, "GMAIL_FETCH_EMAILS");
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("tools/list"));
    const wrapped = loaded.module.wrapBackendMcpExecWithComposio({
      async listTools() { throw new Error("Cursor dashboard should not list composio"); },
      async executeTool() { throw new Error("Cursor dashboard should not execute composio"); },
    }, () => "ck_example");
    const servers = await wrapped.listTools(["composio"]);
    assert.equal(servers.length, 2);
    assert.equal(servers[0]?.serverIdentifier, "composio--gmail");
    assert.equal(servers[1]?.serverIdentifier, "composio--slack");
    assert.ok(servers[0]?.tools.some((tool) => tool.name === "GMAIL_FETCH_EMAILS"));
    assert.ok(servers[1]?.tools.some((tool) => tool.name === "SLACK_SEND_MESSAGE"));
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});

test("mergeInstalledMcpServers keeps Composio when the gateway is empty", async () => {
  const loaded = await loadModule();
  try {
    const local = loaded.module.toInstalledComposioServers([{
      serverIdentifier: "composio",
      rowServerIdentifier: "composio",
      accountLabel: "default",
      status: "connected",
      tools: [{ name: "GMAIL_FETCH_EMAILS", toolName: "GMAIL_FETCH_EMAILS", providerIdentifier: "composio", description: "Fetch", inputSchema: {} }],
    }]);
    const merged = loaded.module.mergeInstalledMcpServers([], local);
    assert.equal(merged[0].name, "Composio");
    assert.equal(merged[0].status, "connected");
    assert.equal(merged[0].toolCount, 1);
    const tools = loaded.module.toInstalledComposioServerTools([{
      serverIdentifier: "composio",
      rowServerIdentifier: "composio",
      accountLabel: "default",
      status: "connected",
      tools: [{ name: "GMAIL_FETCH_EMAILS", toolName: "GMAIL_FETCH_EMAILS", providerIdentifier: "composio", description: "Fetch", inputSchema: {} }],
    }]);
    assert.equal(tools[0].name, "GMAIL_FETCH_EMAILS");
    const routed = loaded.module.flattenComposioRoutedTools([{
      serverIdentifier: "composio",
      rowServerIdentifier: "composio",
      accountLabel: "default",
      status: "connected",
      tools: [{ name: "GMAIL_FETCH_EMAILS", toolName: "GMAIL_FETCH_EMAILS", providerIdentifier: "composio", description: "Fetch", inputSchema: {} }],
    }]);
    assert.equal(routed[0].providerIdentifier, "composio");
  } finally {
    await loaded.dispose();
  }
});

test("listComposioBackendServers unpacks Gmail and Linear rows", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("connected_accounts")) {
      return jsonResponse({
        items: [
          { id: "ca_gmail", status: "ACTIVE", user_id: "user-1", toolkit: { slug: "gmail" } },
          { id: "ca_linear", status: "ACTIVE", user_id: "user-1", toolkit: { slug: "linear" } },
        ],
      });
    }
    if (url.includes("toolkit_slug=linear")) {
      return jsonResponse({ items: [{ slug: "LINEAR_CREATE_ISSUE", description: "Create", toolkit: { slug: "linear" } }] });
    }
    if (url.includes("/api/v3.1/tools")) {
      return jsonResponse({ items: [{ slug: "GMAIL_FETCH_EMAILS", description: "Fetch", toolkit: { slug: "gmail" } }] });
    }
    return jsonResponse({}, 404);
  };
  try {
    loaded.module.resetComposioCachesForTests();
    const servers = await loaded.module.listComposioBackendServers("ak_unpack");
    const installed = loaded.module.toInstalledComposioServers(servers);
    assert.deepEqual(installed.map((row) => row.name), ["Gmail", "Linear"]);
    assert.deepEqual(installed.map((row) => row.serverIdentifier), ["composio--gmail", "composio--linear"]);
    const gmailTools = loaded.module.toInstalledComposioServerTools(servers.filter((server) => server.serverIdentifier === "composio--gmail"));
    const linearTools = loaded.module.toInstalledComposioServerTools(servers.filter((server) => server.serverIdentifier === "composio--linear"));
    assert.equal(gmailTools[0].name, "GMAIL_FETCH_EMAILS");
    assert.equal(linearTools[0].name, "LINEAR_CREATE_ISSUE");
    const routed = loaded.module.flattenComposioRoutedTools(servers);
    assert.equal(routed.find((tool) => tool.name === "GMAIL_FETCH_EMAILS")?.providerIdentifier, "composio--gmail");
    const wrapped = loaded.module.wrapBackendMcpExecWithComposio({
      async listTools() { throw new Error("Cursor dashboard should not list composio"); },
      async executeTool() { throw new Error("Cursor dashboard should not execute composio"); },
    }, () => "ak_unpack");
    const listed = await wrapped.listTools(["composio"]);
    assert.equal(listed.length, 2);
    const gmailOnly = await wrapped.listTools(["composio--gmail"]);
    assert.equal(gmailOnly.length, 1);
    assert.equal(gmailOnly[0].serverIdentifier, "composio--gmail");
    const gateway = [{ id: "9", name: "Composio", serverIdentifier: "composio", status: "error" }];
    const merged = loaded.module.mergeInstalledMcpServers(gateway, installed);
    assert.equal(merged.some((row) => row.name === "Composio"), false);
    assert.equal(merged.some((row) => row.name === "Gmail"), true);
    assert.equal(merged.some((row) => row.name === "Linear"), true);
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});

test("Composio webhook HMAC and payload parse", async () => {
  const loaded = await loadModule();
  try {
    const { createHmac } = await import("node:crypto");
    const payload = JSON.stringify({ metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" }, data: { id: "msg-1" } });
    const webhookId = "msg_1";
    const webhookTimestamp = String(Math.floor(Date.now() / 1000));
    const secret = "whsec_test";
    const signature = `v1,${createHmac("sha256", secret).update(`${webhookId}.${webhookTimestamp}.${payload}`).digest("base64")}`;
    assert.equal(loaded.module.verifyComposioWebhookSignature({
      payload, signature, webhookId, webhookTimestamp, secret,
    }), true);
    assert.equal(loaded.module.verifyComposioWebhookSignature({
      payload, signature: "v1,nope", webhookId, webhookTimestamp, secret,
    }), false);
    assert.deepEqual(loaded.module.parseComposioWebhookPayload(payload), {
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      data: { id: "msg-1" },
    });
    assert.deepEqual(loaded.module.composioRoutineEvent("GMAIL_NEW_GMAIL_MESSAGE", { id: "msg-1" }), {
      source: "composio",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      data: { id: "msg-1" },
    });
  } finally {
    await loaded.dispose();
  }
});

test("ensureComposioWebhookAndTriggers subscribes and upserts Gmail", async () => {
  const loaded = await loadModule();
  const previousFetch = globalThis.fetch;
  const calls = [];
  let stored;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url.includes("/org/webhooks") && (init?.method ?? "GET") === "GET") {
      return jsonResponse({ items: [] });
    }
    if (url.includes("/org/webhooks")) {
      return jsonResponse({ secret: "whsec_saved", webhook_url: "https://bot.example/webhooks/composio" });
    }
    if (url.includes("connected_accounts")) {
      return jsonResponse({
        items: [{ id: "ca_gmail", status: "ACTIVE", user_id: "user-1", toolkit: { slug: "gmail" } }],
      });
    }
    if (url.includes("trigger_instances") && url.includes("upsert")) {
      return jsonResponse({ id: "ti_1" });
    }
    if (url.includes("trigger_instances")) {
      return jsonResponse({ items: [] });
    }
    return jsonResponse({}, 404);
  };
  try {
    loaded.module.resetComposioCachesForTests();
    const result = await loaded.module.ensureComposioWebhookAndTriggers({
      apiKey: "ak_triggers",
      webhookUrl: "https://bot.example/webhooks/composio",
      persistSecret: (secret) => { stored = secret; },
    });
    assert.equal(result.enabled, true);
    assert.equal(stored, "whsec_saved");
    assert.ok(calls.some((call) => call.url.includes("/org/webhooks") && call.method === "POST"));
    assert.ok(calls.some((call) => call.url.includes("GMAIL_NEW_GMAIL_MESSAGE") && call.url.includes("upsert")));
    const skipped = await loaded.module.ensureComposioWebhookAndTriggers({
      apiKey: "ak_triggers",
      webhookUrl: "http://127.0.0.1:8080/webhooks/composio",
    });
    assert.equal(skipped.enabled, false);
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
  }
});
