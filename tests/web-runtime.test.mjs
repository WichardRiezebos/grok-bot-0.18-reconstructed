import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WebSocket } from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-web-runtime-"));
  const output = path.join(temporary, "module.cjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    define: { "import.meta.url": "__cleanImportMetaUrl" },
    banner: { js: "const __cleanImportMetaUrl = require(\"node:url\").pathToFileURL(__filename + \".bundled\").href;\n" },
  });
  return { module: require(output), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function mockFork(_config, debug) {
  debug.coordinatorAlive = true;
  debug.coordinatorPid = 4242;
  return {
    child: { pid: 4242 },
    postData() {},
    postMainData() {},
    dispose() {
      debug.coordinatorAlive = false;
      debug.coordinatorPid = null;
    },
    onData() {
      return () => {};
    },
    onMainData() {
      return () => {};
    },
  };
}

test("web runtime host bundle inlines jsonc-parser instead of UMD relative requires", async () => {
  const script = await readFile(path.join(repoRoot, "scripts/build-web-runtime.mjs"), "utf8");
  assert.match(script, /mainFields:\s*\["module", "main"\]/);
  assert.match(script, /startProductionHost/);
  assert.match(script, /bindRecoveredProductionExtensions/);
  assert.match(script, /deploy\/control\/shipped-renderer/);
  assert.match(script, /GROK_BOT_REQUIRE_RENDERER/);
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-jsonc-bundle-"));
  const output = path.join(temporary, "jsonc.cjs");
  try {
    await build({
      absWorkingDir: repoRoot,
      stdin: {
        contents: 'import { parse } from "jsonc-parser"; export { parse };\n',
        loader: "ts",
        resolveDir: repoRoot,
        sourcefile: "tests/jsonc-bundle-entry.ts",
      },
      outfile: output,
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      mainFields: ["module", "main"],
    });
    const bundled = await readFile(output, "utf8");
    assert.doesNotMatch(bundled, /jsonc-parser\/lib\/umd/);
    assert.doesNotMatch(bundled, /require\(["']\.\/impl\/format["']\)/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("control image ships the checksum-pinned 0.36 renderer", async () => {
  const html = await readFile(path.join(repoRoot, "deploy/control/shipped-renderer/index.html"), "utf8");
  assert.match(html, /index-Dl1Aho6j\.js/);
  assert.match(html, /index-FcTs3Vos\.css/);
  const entry = await readFile(path.join(repoRoot, "deploy/control/shipped-renderer/assets/index-Dl1Aho6j.js"), "utf8");
  assert.match(entry, /sand-/);
  const provenance = JSON.parse(await readFile(path.join(repoRoot, "deploy/control/shipped-renderer-provenance.json"), "utf8"));
  assert.equal(provenance.version, "0.36.0");
  assert.equal(provenance.upstreamAsarSha256, "2ae381b92f9f19dd33b2404b512cedaa3d2e1b4a08640be088dc6a06b1cf98d3");
  assert.equal(provenance.dmgSha256, "5aacc48244fea0a99d56d5d0a0748a71de5514cf2e0e11b4934f56aae53b48a6");
  assert.equal(provenance.patchMode, "unpatched-stock-renderer");
  assert.equal(provenance.entryAssets.entryChunk, "assets/index-Dl1Aho6j.js");
  assert.equal(provenance.entryAssets.entryCss, "assets/index-FcTs3Vos.css");
  const { stat } = await import("node:fs/promises");
  const stats = await stat(path.join(repoRoot, "deploy/control/shipped-renderer"));
  assert.ok(stats.isDirectory());
  const buildScript = await readFile(path.join(repoRoot, "scripts/build-web-runtime.mjs"), "utf8");
  const shippedIndex = buildScript.indexOf("deploy/control/shipped-renderer");
  const bootstrappedIndex = buildScript.indexOf("src/app/dist/renderer");
  assert.ok(shippedIndex >= 0 && bootstrappedIndex > shippedIndex, "committed 0.36 renderer wins over any bootstrapped desktop payload");
});

test("bundled CJS entrypoint still matches node server-main.cjs", async () => {
  const source = await readFile(path.join(repoRoot, "source", "server-main", "main.ts"), "utf8");
  assert.match(source, /function isDirectRun/);
  assert.match(source, /server-main\.cjs/);
});

test("Dokploy compose uses named volumes, env_file secrets, and no host ports", async () => {
  const base = await readFile(path.join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
  const local = await readFile(path.join(repoRoot, "deploy", "docker-compose.local.yml"), "utf8");
  assert.match(base, /env_file:\n\s+- deploy\/\.env/);
  assert.doesNotMatch(base, /\$\{OPENROUTER_API_KEY\}/);
  assert.doesNotMatch(base, /RUNTIME_ACCESS_TOKEN/);
  assert.match(local, /\$\{PUBLIC_URL:-http:\/\/127\.0\.0\.1:8080\}/);
  assert.match(base, /box-workspace:/);
  assert.match(base, /box-data:/);
  assert.match(base, /control-data:/);
  assert.match(base, /expose:\n\s+- "1340"/);
  assert.match(base, /expose:\n\s+- "8080"/);
  assert.match(base, /dockerfile: deploy\/Dockerfile/);
  assert.match(base, /target: box/);
  assert.match(base, /target: control/);
  assert.doesNotMatch(base, /deploy\/box\/Dockerfile/);
  assert.doesNotMatch(base, /deploy\/control\/Dockerfile/);
  assert.doesNotMatch(base, /^\s+ports:/m);
  assert.doesNotMatch(base, /caddy/i);
  assert.doesNotMatch(base, /dokploy-network/);
  assert.doesNotMatch(base, /traefik/i);
  assert.doesNotMatch(base, /\/var\/run\/docker\.sock/);
  assert.match(local, /127\.0\.0\.1:8080:8080/);
});

test("secret redaction keeps only the last four characters", async () => {
  const loaded = await loadModule("source/server-main/redact.ts");
  try {
    const { lastFour, redactSecret, redactValue } = loaded.module;
    assert.equal(lastFour("abcd"), "****");
    assert.equal(lastFour("token-9999"), "…9999");
    assert.equal(redactSecret("sk-or-v1-secret9999"), "…9999");
    const redacted = redactValue({ OPENROUTER_API_KEY: "sk-or-v1-secret9999", nested: { authorization: "Bearer 1234abcd" } });
    assert.equal(redacted.OPENROUTER_API_KEY, "…9999");
    assert.equal(redacted.nested.authorization, "…abcd");
  } finally {
    await loaded.dispose();
  }
});

test("headless executors point at the box gateway and record stubs", async () => {
  const loaded = await loadModule("source/server-main/executors.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const debugLoaded = await loadModule("source/server-main/debug-log.ts");
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  const gatewayCalls = [];
  globalThis.fetch = async (input, init) => {
    gatewayCalls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify([{ name: "GMAIL_SEND_EMAIL" }]), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { resolveRuntimeConfig } = configLoaded.module;
    const { createDebugState } = debugLoaded.module;
    const { createHeadlessExecutors } = loaded.module;
    const config = resolveRuntimeConfig({
      RUNTIME_ACCESS_TOKEN: "access-token",
      SAND_HOST_GATEWAY_URL: "http://box:1340",
      SAND_GATEWAY_TOKEN: "gate-9999",
    });
    const debug = createDebugState();
    const executors = createHeadlessExecutors(config, debug);
    assert.deepEqual(executors.resolveGatewayConnection(), { baseUrl: "http://box:1340", token: "gate-9999" });
    const tools = await executors.listRoutedMcpTools();
    assert.equal(tools[0]?.name, "GMAIL_SEND_EMAIL");
    assert.ok(gatewayCalls.some((call) => call.url === "http://box:1340/api/listRoutedMcpTools"));
    await assert.rejects(() => executors.requestWebAuthnConsent(), /WebAuthn is unavailable/);
    await assert.rejects(() => executors.spawnLocalExecDaemon(), /local-exec/);
    const stubs = debug.stubs.snapshot().map((row) => row.method);
    assert.ok(stubs.includes("requestWebAuthnConsent"));
    assert.ok(stubs.includes("spawnLocalExecDaemon"));
    assert.equal(stubs.includes("listRoutedMcpTools"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    await loaded.dispose();
    await configLoaded.dispose();
    await debugLoaded.dispose();
  }
});

test("listRoutedMcpTools includes Gmail from control Composio without the box", async () => {
  const loaded = await loadModule("source/server-main/executors.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const debugLoaded = await loadModule("source/server-main/debug-log.ts");
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY = "ak_control_gmail";
  const gatewayCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    gatewayCalls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("listSandMcpTools")) {
      throw new Error("Cursor dashboard should not list composio");
    }
    if (url.includes("/api/listRoutedMcpTools")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("connected_accounts")) {
      return new Response(JSON.stringify({
        items: [{ id: "ca_gmail", status: "ACTIVE", user_id: "user-1", toolkit: { slug: "gmail" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/tools/execute/")) {
      return new Response(JSON.stringify({ successful: true, data: { messages: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/v3.1/tools")) {
      return new Response(JSON.stringify({
        items: [{ slug: "GMAIL_FETCH_EMAILS", description: "Fetch Gmail threads", toolkit: { slug: "gmail" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { resolveRuntimeConfig } = configLoaded.module;
    const { createDebugState } = debugLoaded.module;
    const { createHeadlessExecutors } = loaded.module;
    const executors = createHeadlessExecutors(resolveRuntimeConfig({
      SAND_HOST_GATEWAY_URL: "http://box:1340",
      SAND_GATEWAY_TOKEN: "gate-9999",
    }), createDebugState());
    const tools = await executors.listRoutedMcpTools();
    assert.ok(tools.some((tool) => tool.name === "GMAIL_FETCH_EMAILS"));
    assert.equal(tools.find((tool) => tool.name === "GMAIL_FETCH_EMAILS")?.providerIdentifier, "composio--gmail");
    assert.equal(gatewayCalls.some((call) => call.url.includes("listSandMcpTools")), false);
    const executed = await executors.executeRoutedMcpTool({
      providerIdentifier: "composio",
      toolName: "GMAIL_FETCH_EMAILS",
      args: { query: "in:inbox" },
    });
    assert.equal(executed.result.case, "success");
    assert.equal(gatewayCalls.some((call) => call.url.includes("/api/executeRoutedMcpTool")), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    await loaded.dispose();
    await configLoaded.dispose();
    await debugLoaded.dispose();
  }
});

test("runtime health JSON has the stable docker shape", async () => {
  const loaded = await loadModule("source/server-main/health.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const debugLoaded = await loadModule("source/server-main/debug-log.ts");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
  try {
    const { resolveRuntimeConfig } = configLoaded.module;
    const { createDebugState } = debugLoaded.module;
    const { buildRuntimeHealth } = loaded.module;
    const debug = createDebugState();
    debug.coordinatorAlive = true;
    debug.coordinatorPid = 7;
    debug.wsListenerReady = true;
    const health = await buildRuntimeHealth(resolveRuntimeConfig({
      RUNTIME_ACCESS_TOKEN: "access-token",
      OPENROUTER_API_KEY: "sk-or-v1-not-leaked",
      SAND_HOST_GATEWAY_URL: "http://box:1340",
    }), debug);
    assert.equal(health.ok, true);
    assert.equal(health.runtime, "docker");
    assert.equal(health.coordinator.alive, true);
    assert.equal(health.box.ok, true);
    assert.equal(health.box.isBusy, false);
    assert.equal(health.openRouterConfigured, true);
    assert.equal(health.wsListenerReady, true);
    assert.equal(JSON.stringify(health).includes("sk-or-v1-not-leaked"), false);
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
    await configLoaded.dispose();
    await debugLoaded.dispose();
  }
});

test("updateComputer posts to the box gateway without restarting the coordinator", async () => {
  const loaded = await loadModule("source/server-main/rpc.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const debugLoaded = await loadModule("source/server-main/debug-log.ts");
  const settingsLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-rpc-update-"));
  const previousFetch = globalThis.fetch;
  const gatewayCalls = [];
  globalThis.fetch = async (input, init) => {
    const headers = init?.headers ?? {};
    gatewayCalls.push({
      url: String(input),
      body: String(init?.body ?? ""),
      auth: headers.authorization ?? headers.Authorization,
    });
    return new Response(JSON.stringify({ agentId: "agent-1", state: "running", started: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let restarted = 0;
  try {
    const { resolveRuntimeConfig } = configLoaded.module;
    const { createDebugState } = debugLoaded.module;
    const debug = createDebugState();
    const dispatch = loaded.module.createRpcDispatcher({
      config: resolveRuntimeConfig({
        SAND_HOST_GATEWAY_URL: "http://box:1340",
        SAND_GATEWAY_TOKEN: "gate-9999",
      }),
      debug,
      settings: new settingsLoaded.module.SandSettingsStore(path.join(dataDir, "settings.json")),
      secretsPath: path.join(dataDir, "box-secrets.json"),
      persistencePath: path.join(dataDir, "client-persistence.json"),
      restartCoordinator: () => { restarted += 1; },
    });
    const result = await dispatch("sand-rpc:main:m:updateComputer", { id: "agent-1", force: false });
    assert.deepEqual(result, { status: "dev-fallback-finished" });
    assert.equal(restarted, 0);
    assert.ok(gatewayCalls.some((call) => call.url === "http://box:1340/api/updateForeverBox"));
    assert.ok(gatewayCalls.some((call) => call.auth === "Bearer gate-9999"));
    assert.equal(debug.stubs.snapshot().some((row) => row.method === "updateComputer"), false);
    await dispatch("sand-rpc:main:m:forceReconnectGateway", {});
    assert.equal(restarted, 1);
    await assert.rejects(
      () => dispatch("sand-rpc:main:m:forceRecreateComputer", {}),
      /Reset the box container from your host instead/,
    );
    assert.ok(debug.stubs.snapshot().some((row) => row.method === "forceRecreateComputer"));
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
    await configLoaded.dispose();
    await debugLoaded.dispose();
    await settingsLoaded.dispose();
  }
});

test("updateComputer answers over websocket without a coordinator-restart close", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-update-ws-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/updateForeverBox")) {
      return new Response(JSON.stringify({ started: true, agentId: "agent-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    RUNTIME_ACCESS_TOKEN: "secret-token",
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    SAND_HOST_GATEWAY_URL: "http://box:1340",
  }), { fork: mockFork });
  try {
    await server.ready;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws?token=secret-token`);
      const timer = setTimeout(() => reject(new Error("updateComputer websocket timeout")), 5_000);
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.kind === "hello-ok") {
          ws.send(JSON.stringify({
            kind: "rpc",
            id: "upd",
            channel: "sand-rpc:main:m:updateComputer",
            payload: { id: "agent-1", force: false },
          }));
          return;
        }
        if (message.kind === "rpc-ok") {
          clearTimeout(timer);
          try {
            assert.deepEqual(message.value, { status: "dev-fallback-finished" });
            assert.equal(ws.readyState, WebSocket.OPEN);
            ws.close();
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      });
      ws.on("close", (code) => {
        if (code === 1012) {
          clearTimeout(timer);
          reject(new Error("updateComputer should not close the websocket with 1012"));
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("renderer assets load without a site access token", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-web-"));
  const rendererRoot = path.join(dataDir, "renderer");
  await mkdir(path.join(rendererRoot, "assets"), { recursive: true });
  await writeFile(path.join(rendererRoot, "index.html"), `<!doctype html><html><head>
    <script type="module" crossorigin src="./assets/app.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/app.css">
  </head><body><div id="root"></div></body></html>`);
  await writeFile(path.join(rendererRoot, "assets", "app.js"), "window.__app = true;\n");
  await writeFile(path.join(rendererRoot, "assets", "app.css"), "body{color:#111}\n");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/health") && url.includes("box")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    RUNTIME_ACCESS_TOKEN: "secret-token",
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    GROK_BOT_RENDERER_ROOT: rendererRoot,
    SAND_HOST_GATEWAY_URL: "http://box:1340",
    OPENROUTER_API_KEY: "sk-or-v1-not-leaked",
    RUNTIME_DEBUG: "1",
  }), { fork: mockFork });
  try {
    await server.ready;
    const page = await fetch(`${server.url}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null);
    const html = await page.text();
    assert.doesNotMatch(html, /crossorigin/);
    assert.match(html, /__grok_bot\/shim\.js/);
    const asset = await fetch(`${server.url}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "window.__app = true;\n");
    const css = await fetch(`${server.url}/assets/app.css`);
    assert.equal(css.status, 200);
    const again = await fetch(`${server.url}/`);
    assert.equal(again.status, 200);
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ungated /health, /debug, and websocket RPC", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-web-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/health") && url.includes("box")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    RUNTIME_ACCESS_TOKEN: "secret-token",
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    SAND_HOST_GATEWAY_URL: "http://box:1340",
    OPENROUTER_API_KEY: "sk-or-v1-not-leaked",
    RUNTIME_DEBUG: "1",
  }), { fork: mockFork });
  try {
    await server.ready;
    const unauth = await fetch(`${server.url}/debug`);
    assert.equal(unauth.status, 200);
    const loopbackHealth = await fetch(`${server.url}/health`);
    assert.equal(loopbackHealth.status, 200);
    const health = await loopbackHealth.json();
    assert.equal(health.runtime, "docker");
    assert.equal(health.coordinator.alive, true);
    assert.equal(health.ok, true);
    const debugPage = await fetch(`${server.url}/debug`, { headers: { authorization: "Bearer secret-token" } });
    assert.equal(debugPage.status, 200);
    const html = await debugPage.text();
    for (const testId of [
      "health-ok", "health-runtime", "coordinator-alive", "box-ok",
      "openrouter-configured", "ws-ready", "debug-probe-box", "debug-ping-rpc",
      "debug-rpc", "debug-stubs", "debug-logs",
    ]) {
      assert.match(html, new RegExp(`data-testid="${testId}"`));
    }
    assert.equal(html.includes("sk-or-v1-not-leaked"), false);

    const unauthVnc = await fetch(`${server.url}/__grok_bot/vnc/fork/vnc.html`);
    assert.notEqual(unauthVnc.status, 401);

    const ping = await fetch(`${server.url}/debug/actions/ping-rpc`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
    });
    const pingBody = await ping.json();
    assert.equal(pingBody.ok, true);
    assert.equal(pingBody.value.runtime, "docker");

    const app = await fetch(`${server.url}/`, { headers: { authorization: "Bearer secret-token" } });
    const appHtml = await app.text();
    assert.match(appHtml, /__grok_bot\/shim\.js/);
    assert.match(appHtml, /__grok_bot\/overlay\.js/);

    const shim = await fetch(`${server.url}/__grok_bot/shim.js`);
    assert.equal(shim.status, 200);
    const shimSource = await shim.text();
    assert.match(shimSource, /onForceOnboarding/);
    assert.match(shimSource, /onWidgetGallery/);
    assert.match(shimSource, /reportAgentLoad/);
    assert.match(shimSource, /sand-window-controls/);
    assert.match(shimSource, /sand-window-controls-inset/);
    assert.match(shimSource, /sand-titlebar-block/);
    assert.match(shimSource, /flattenWindowChrome/);
    assert.match(shimSource, /grok-bot-vnc-frame/);
    assert.match(shimSource, /rewriteLoopbackVncUrl/);
    assert.match(shimSource, /sand:vnc-session/);
    assert.match(shimSource, /rfb_connect/);
    assert.match(shimSource, /watchAdoptedWebview/);
    assert.match(shimSource, /attachVncVisibility/);
    assert.match(shimSource, /refreshNoVncIframe/);
    assert.match(shimSource, /sand:vnc-viewer-visible/);
    assert.match(shimSource, /IntersectionObserver/);
    assert.match(shimSource, /:not\(\.sand-lshs6z\)/);
    assert.match(shimSource, /iframeLooksConnected/);
    assert.doesNotMatch(shimSource, /layer:has\(webview\[data-grok-bot-vnc-connected/);
    assert.match(shimSource, /dom-ready/);
    assert.match(shimSource, /did-finish-load/);
    assert.match(shimSource, /sand-box-vnc-pool__connecting/);
    assert.match(shimSource, /hideNoVncChrome/);
    assert.match(shimSource, /#noVNC_control_bar/);
    assert.match(shimSource, /#noVNC_control_bar_handle/);
    assert.match(shimSource, /noVNC_logo/);
    assert.match(shimSource, /__grok_bot\/vnc\//);
    assert.match(shimSource, /prefix\.replace/);
    assert.match(shimSource, /rawPath\.replace/);
    assert.match(shimSource, /rejectPending/);
    assert.match(shimSource, /4409/);
    assert.match(shimSource, /grok-bot-superseded/);
    assert.match(shimSource, /1012/);
    assert.match(shimSource, /coordinator restarted; reconnecting/);
    assert.match(shimSource, /noteToolSurfaceError/);
    assert.match(shimSource, /grok-bot-tool-surface/);
    assert.match(shimSource, /browserUse/);
    assert.doesNotMatch(shimSource, /coordinator restarted; reloading/);
    assert.match(shimSource, /owner\?\.onPort\(coordinatorPort\)/);
    assert.match(shimSource, /__SENTRY__RENDERER_INIT__/);
    assert.match(shimSource, /dummy\\.dsn/);
    assert.match(shimSource, /listener\(undefined, payload\)/);
    assert.match(shimSource, /sand-rpc:main:e:cursor-auth-changed/);
    const gatedApp = await fetch(`${server.url}/`);
    assert.equal(gatedApp.status, 200);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws?token=secret-token`);
      const timer = setTimeout(() => reject(new Error("websocket timeout")), 5_000);
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.kind === "hello-ok") {
          ws.send(JSON.stringify({ kind: "rpc", id: "1", channel: "sand-rpc:main:m:getDesktopEnvironment", payload: {} }));
          return;
        }
        if (message.kind === "rpc-ok") {
          clearTimeout(timer);
          assert.equal(message.value.runtime, "docker");
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("loopback noVNC URLs rewrite onto the same-origin VNC proxy", async () => {
  const loaded = await loadModule("source/server-main/vnc-proxy.ts");
  try {
    const { rewriteLoopbackVncUrl, vncProxyMatch, boxVncOrigin, VNC_FORK_PREFIX, VNC_PRIMARY_PREFIX } = loaded.module;
    const src = "http://127.0.0.1:6081/vnc.html?path=websockify%3Ftoken%3D2&autoconnect=true";
    const rewritten = rewriteLoopbackVncUrl(src);
    assert.equal(rewritten.startsWith(`${VNC_FORK_PREFIX}/vnc.html?`), true);
    assert.match(rewritten, /path=__grok_bot%2Fvnc%2Ffork%2Fwebsockify%3Ftoken%3D2/);
    assert.doesNotMatch(rewritten, /path=%2F__grok_bot/);
    assert.equal(rewriteLoopbackVncUrl("http://127.0.0.1:6080/vnc.html").startsWith(`${VNC_PRIMARY_PREFIX}/vnc.html`), true);
    assert.equal(rewriteLoopbackVncUrl("http://example.test:6081/vnc.html"), "http://example.test:6081/vnc.html");
    assert.deepEqual(vncProxyMatch("/__grok_bot/vnc/fork/websockify"), {
      prefix: VNC_FORK_PREFIX,
      port: 6081,
      rest: "/websockify",
    });
    assert.equal(boxVncOrigin("http://box:1340", 6081), "http://box:6081");
    const { normalizeRequestUrl } = loaded.module;
    assert.equal(normalizeRequestUrl("//__grok_bot/vnc/fork/websockify?token=2"), "/__grok_bot/vnc/fork/websockify?token=2");
    assert.equal(normalizeRequestUrl("/__grok_bot/vnc/fork/websockify"), "/__grok_bot/vnc/fork/websockify");
    assert.equal(normalizeRequestUrl(undefined), "/");
    const collapsed = new URL(normalizeRequestUrl("//__grok_bot/vnc/fork/websockify?token=2"), "http://127.0.0.1");
    assert.deepEqual(vncProxyMatch(collapsed.pathname), {
      prefix: VNC_FORK_PREFIX,
      port: 6081,
      rest: "/websockify",
    });
    assert.equal(vncProxyMatch(new URL("//__grok_bot/vnc/fork/websockify", "http://127.0.0.1").pathname), null);
  } finally {
    await loaded.dispose();
  }
});

test("VNC HTTP proxy forwards to the box noVNC origin", async () => {
  const loaded = await loadModule("source/server-main/vnc-proxy.ts");
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`vnc:${req.url}`);
  });
  const proxy = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    loaded.module.proxyVncHttp(req, res, "http://127.0.0.1:9", { port: upstreamPort, rest: url.pathname }, url.search);
  });
  let upstreamPort = 0;
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = upstream.address().port;
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const address = proxy.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/vnc.html?autoconnect=true`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "vnc:/vnc.html?autoconnect=true");
  } finally {
    await new Promise((resolve, reject) => proxy.close((error) => error != null ? reject(error) : resolve()));
    await new Promise((resolve, reject) => upstream.close((error) => error != null ? reject(error) : resolve()));
    await loaded.dispose();
  }
});

function waitHello(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hello-ok timeout")), 5_000);
    ws.on("message", function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (message.kind === "hello-ok") {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(message);
      }
    });
    ws.on("error", reject);
  });
}

test("dead coordinator postData does not kill the runtime server", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-web-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/health") && url.includes("box")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    RUNTIME_ACCESS_TOKEN: "secret-token",
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    SAND_HOST_GATEWAY_URL: "http://box:1340",
  }), {
    fork(_config, debug) {
      debug.coordinatorAlive = true;
      debug.coordinatorPid = 9;
      return {
        child: { pid: 9 },
        postData() { throw new Error("ipc closed"); },
        postMainData() { throw new Error("ipc closed"); },
        dispose() { debug.coordinatorAlive = false; debug.coordinatorPid = null; },
        onData() { return () => {}; },
        onMainData() { return () => {}; },
      };
    },
  });
  try {
    await server.ready;
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws?token=secret-token`);
    await waitHello(ws);
    ws.send(JSON.stringify({ kind: "coordinator", frame: { kind: "lifecycle", phase: "hello", protocolVersion: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    ws.close();
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a second tab takes coordinator ownership and the first is superseded", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-web-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/health") && url.includes("box")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  const dataListeners = new Set();
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    RUNTIME_ACCESS_TOKEN: "secret-token",
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    SAND_HOST_GATEWAY_URL: "http://box:1340",
  }), {
    fork(_config, debug) {
      debug.coordinatorAlive = true;
      debug.coordinatorPid = 11;
      return {
        child: { pid: 11 },
        postData() {},
        postMainData() {},
        dispose() { debug.coordinatorAlive = false; debug.coordinatorPid = null; },
        onData(listener) { dataListeners.add(listener); return () => dataListeners.delete(listener); },
        onMainData() { return () => {}; },
      };
    },
  });
  const firstFrames = [];
  const secondFrames = [];
  let firstClose = null;
  try {
    await server.ready;
    const first = new WebSocket(`${server.url.replace("http", "ws")}/ws?token=secret-token`);
    const second = new WebSocket(`${server.url.replace("http", "ws")}/ws?token=secret-token`);
    first.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.kind === "coordinator") firstFrames.push(message.frame);
    });
    second.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.kind === "coordinator") secondFrames.push(message.frame);
    });
    first.on("close", (code) => { firstClose = code; });
    await Promise.all([waitHello(first), waitHello(second)]);
    first.send(JSON.stringify({ kind: "coordinator", frame: { kind: "lifecycle", phase: "hello", protocolVersion: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const listener of dataListeners) listener({ owner: "first" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    second.send(JSON.stringify({ kind: "coordinator", frame: { kind: "lifecycle", phase: "hello", protocolVersion: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(firstClose, 4409);
    for (const listener of dataListeners) listener({ owner: "second" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(firstFrames, [{ owner: "first" }]);
    assert.deepEqual(secondFrames, [{ owner: "second" }]);
    first.close();
    second.close();
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("double-slash VNC upgrade paths are normalized onto the proxy", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-web-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/health") && url.includes("box")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    RUNTIME_ACCESS_TOKEN: "secret-token",
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    SAND_HOST_GATEWAY_URL: "http://127.0.0.1:9",
  }), { fork: mockFork });
  try {
    await server.ready;
    const port = Number(new URL(server.url).port);
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "//__grok_bot/vnc/fork/vnc.html",
        headers: { authorization: "Bearer secret-token" },
      }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.notEqual(status, 404);
    assert.notEqual(status, 401);
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("malformed percent-encoded static paths do not crash the runtime", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-web-"));
  const rendererRoot = path.join(dataDir, "renderer");
  await mkdir(path.join(rendererRoot, "assets"), { recursive: true });
  await writeFile(path.join(rendererRoot, "index.html"), "<!doctype html><html><body>ok</body></html>");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/health") && url.includes("box")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    GROK_BOT_RENDERER_ROOT: rendererRoot,
    SAND_HOST_GATEWAY_URL: "http://box:1340",
  }), { fork: mockFork });
  try {
    await server.ready;
    const port = Number(new URL(server.url).port);
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path: "/%zz.js" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.ok(status === 400 || status === 404);
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("/health returns 503 when the coordinator is dead", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-web-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/health") && url.includes("box")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    SAND_HOST_GATEWAY_URL: "http://box:1340",
  }), { fork: mockFork });
  try {
    await server.ready;
    server.debug.coordinatorAlive = false;
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).ok, false);
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("coordinator exit does not clobber a newer child's health flags", async () => {
  const loaded = await loadModule("source/server-main/coordinator-parent.ts");
  const debugLoaded = await loadModule("source/server-main/debug-log.ts");
  try {
    const debug = debugLoaded.module.createDebugState();
    debug.coordinatorAlive = true;
    debug.coordinatorPid = 20;
    loaded.module.noteCoordinatorExit(debug, 19, 0);
    assert.equal(debug.coordinatorAlive, true);
    assert.equal(debug.coordinatorPid, 20);
    assert.equal(debug.coordinatorLastExit, 0);
    loaded.module.noteCoordinatorExit(debug, 20, 1);
    assert.equal(debug.coordinatorAlive, false);
    assert.equal(debug.coordinatorPid, null);
    assert.equal(debug.coordinatorLastExit, 1);
  } finally {
    await loaded.dispose();
    await debugLoaded.dispose();
  }
});

test("VNC HTTP proxy aborts upstream when the client disconnects", async () => {
  const loaded = await loadModule("source/server-main/vnc-proxy.ts");
  let aborted = false;
  const upstream = createServer((req) => {
    req.on("aborted", () => { aborted = true; });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const proxy = createServer((req, res) => {
    loaded.module.proxyVncHttp(req, res, `http://127.0.0.1:${upstreamPort}`, { port: upstreamPort, rest: "/" }, "");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;
  try {
    await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: proxyPort, path: "/" }, () => {});
      req.on("error", () => resolve());
      req.on("close", resolve);
      req.on("socket", () => setTimeout(() => req.destroy(), 40));
      req.end();
      setTimeout(() => reject(new Error("client destroy timeout")), 2_000);
    });
    for (let i = 0; i < 40 && !aborted; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(aborted, true);
  } finally {
    await new Promise((resolve, reject) => proxy.close((error) => error != null ? reject(error) : resolve()));
    await new Promise((resolve, reject) => upstream.close((error) => error != null ? reject(error) : resolve()));
    await loaded.dispose();
  }
});

test("updateLocalProfile persists and broadcasts cursor-auth-changed", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-bot-profile-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/health") && url.includes("box")) {
      return new Response(JSON.stringify({ ok: true, isBusy: false }), { status: 200 });
    }
    return previousFetch(input, init);
  };
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    RUNTIME_ACCESS_TOKEN: "secret-token",
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    SAND_HOST_GATEWAY_URL: "http://box:1340",
    OPENROUTER_API_KEY: "sk-or-v1-not-leaked",
  }), { fork: mockFork });
  try {
    await server.ready;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws?token=secret-token`);
      const timer = setTimeout(() => reject(new Error("websocket timeout")), 5_000);
      let phase = "hello";
      let gotStatus = null;
      let gotEvent = null;
      const finish = (error) => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (error) reject(error);
        else resolve();
      };
      const maybeReadBack = () => {
        if (gotStatus == null || gotEvent == null || phase !== "update") return;
        try {
          assert.equal(gotStatus.kind, "logged-in");
          assert.equal(gotStatus.displayName, "Ada Lovelace");
          assert.equal(gotStatus.email, "ada@example.com");
          assert.equal(gotEvent.displayName, "Ada Lovelace");
          assert.equal(gotEvent.email, "ada@example.com");
        } catch (error) {
          finish(error);
          return;
        }
        phase = "get";
        ws.send(JSON.stringify({ kind: "rpc", id: "profile-2", channel: "sand-rpc:main:m:getLocalProfile", payload: {} }));
      };
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (phase === "hello" && message.kind === "hello-ok") {
          phase = "update";
          ws.send(JSON.stringify({
            kind: "rpc",
            id: "profile-1",
            channel: "sand-rpc:main:m:updateLocalProfile",
            payload: { name: "  Ada Lovelace  ", email: "Ada@Example.COM" },
          }));
          return;
        }
        if (phase === "update") {
          if (message.kind === "rpc-ok" && message.id === "profile-1") gotStatus = message.value;
          if (message.kind === "event" && message.channel === "sand-rpc:main:e:cursor-auth-changed") gotEvent = message.payload;
          maybeReadBack();
          return;
        }
        if (phase === "get" && message.kind === "rpc-ok" && message.id === "profile-2") {
          try {
            assert.equal(message.value.name, "Ada Lovelace");
            assert.equal(message.value.email, "ada@example.com");
            assert.match(String(message.value.gravatarUrl), /gravatar\.com\/avatar\//);
            finish();
          } catch (error) {
            finish(error);
          }
        }
      });
      ws.on("error", (error) => finish(error));
    });
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("getMcpState and listMcpServerTools proxy the host gateway", async () => {
  const loaded = await loadModule("source/server-main/rpc.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const debugLoaded = await loadModule("source/server-main/debug-log.ts");
  const settingsLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-rpc-mcp-"));
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  const gatewayCalls = [];
  globalThis.fetch = async (input, init) => {
    gatewayCalls.push({ url: String(input), body: String(init?.body ?? "") });
    const url = String(input);
    if (url.endsWith("/api/listInstalledMcpServers")) {
      return new Response(JSON.stringify({ servers: [{ id: "1", name: "Composio", status: "connected", toolCount: 2 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/listMcpServerTools")) {
      return new Response(JSON.stringify([{ name: "GMAIL_FETCH_EMAILS", isDisabled: false }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { resolveRuntimeConfig } = configLoaded.module;
    const { createDebugState } = debugLoaded.module;
    const dispatch = loaded.module.createRpcDispatcher({
      config: resolveRuntimeConfig({
        SAND_HOST_GATEWAY_URL: "http://box:1340",
        SAND_GATEWAY_TOKEN: "gate-9999",
      }),
      debug: createDebugState(),
      settings: new settingsLoaded.module.SandSettingsStore(path.join(dataDir, "settings.json")),
      secretsPath: path.join(dataDir, "box-secrets.json"),
      persistencePath: path.join(dataDir, "client-persistence.json"),
      restartCoordinator: () => {},
    });
    const state = await dispatch("sand-rpc:main:m:getMcpState", {});
    assert.deepEqual(state, { servers: [{ id: "1", name: "Composio", status: "connected", toolCount: 2 }] });
    const listed = await dispatch("sand:mcp-list", {});
    assert.equal(listed.servers[0].name, "Composio");
    const tools = await dispatch("sand-rpc:main:m:listMcpServerTools", { serverId: "1" });
    assert.equal(tools[0].name, "GMAIL_FETCH_EMAILS");
    const ipcTools = await dispatch("sand:mcp-list-server-tools", { serverId: "1" });
    assert.equal(ipcTools[0].name, "GMAIL_FETCH_EMAILS");
    assert.ok(gatewayCalls.some((call) => call.url === "http://box:1340/api/listInstalledMcpServers"));
    assert.ok(gatewayCalls.some((call) => call.url === "http://box:1340/api/listMcpServerTools" && call.body.includes("\"serverId\":\"1\"")));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
    await configLoaded.dispose();
    await debugLoaded.dispose();
    await settingsLoaded.dispose();
  }
});

test("getMcpState returns local Composio when the gateway is empty", async () => {
  const loaded = await loadModule("source/server-main/rpc.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const debugLoaded = await loadModule("source/server-main/debug-log.ts");
  const settingsLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-rpc-mcp-local-"));
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY = "ak_control_gmail";
  const gatewayCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    gatewayCalls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("listSandMcpTools")) {
      throw new Error("Cursor dashboard should not list composio");
    }
    if (url.endsWith("/api/listInstalledMcpServers")) {
      return new Response(JSON.stringify({ servers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("connected_accounts")) {
      return new Response(JSON.stringify({
        items: [{ id: "ca_gmail", status: "ACTIVE", user_id: "user-1", toolkit: { slug: "gmail" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/v3.1/tools")) {
      return new Response(JSON.stringify({
        items: [{ slug: "GMAIL_FETCH_EMAILS", description: "Fetch Gmail threads", toolkit: { slug: "gmail" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { resolveRuntimeConfig } = configLoaded.module;
    const { createDebugState } = debugLoaded.module;
    const dispatch = loaded.module.createRpcDispatcher({
      config: resolveRuntimeConfig({
        SAND_HOST_GATEWAY_URL: "http://box:1340",
        SAND_GATEWAY_TOKEN: "gate-9999",
      }),
      debug: createDebugState(),
      settings: new settingsLoaded.module.SandSettingsStore(path.join(dataDir, "settings.json")),
      secretsPath: path.join(dataDir, "box-secrets.json"),
      persistencePath: path.join(dataDir, "client-persistence.json"),
      restartCoordinator: () => {},
    });
    const state = await dispatch("sand-rpc:main:m:getMcpState", {});
    assert.equal(state.servers[0].name, "Gmail");
    assert.equal(state.servers[0].status, "connected");
    assert.equal(state.servers[0].serverIdentifier, "composio--gmail");
    assert.ok(state.servers[0].toolCount > 0);
    const tools = await dispatch("sand-rpc:main:m:listMcpServerTools", { serverId: state.servers[0].id });
    assert.ok(tools.some((tool) => tool.name === "GMAIL_FETCH_EMAILS"));
    assert.equal(gatewayCalls.some((call) => call.url.includes("listSandMcpTools")), false);
    assert.equal(gatewayCalls.some((call) => call.url.includes("/api/listMcpServerTools")), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
    await configLoaded.dispose();
    await debugLoaded.dispose();
    await settingsLoaded.dispose();
  }
});

test("getMcpCatalog returns Composio marketplace entries in the web runtime", async () => {
  const loaded = await loadModule("source/server-main/rpc.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const debugLoaded = await loadModule("source/server-main/debug-log.ts");
  const settingsLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-rpc-mcp-catalog-"));
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY = "ak_web_catalog";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/v3.1/toolkits")) {
      return new Response(JSON.stringify({
        items: [
          { slug: "gmail", name: "Gmail", meta: { description: "Gmail", logo: "https://cdn.example/gmail.png", categories: ["Communication"] } },
          { slug: "slack", name: "Slack", meta: { description: "Slack", logo: "https://cdn.example/slack.png", categories: ["Communication"] } },
        ],
        next_cursor: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/listInstalledMcpServers")) {
      return new Response(JSON.stringify({ servers: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const dispatch = loaded.module.createRpcDispatcher({
      config: configLoaded.module.resolveRuntimeConfig({
        SAND_HOST_GATEWAY_URL: "http://box:1340",
        SAND_GATEWAY_TOKEN: "gate-9999",
      }),
      debug: debugLoaded.module.createDebugState(),
      settings: new settingsLoaded.module.SandSettingsStore(path.join(dataDir, "settings.json")),
      secretsPath: path.join(dataDir, "box-secrets.json"),
      persistencePath: path.join(dataDir, "client-persistence.json"),
      restartCoordinator: () => {},
    });
    const catalog = await dispatch("sand-rpc:main:m:getMcpCatalog", {});
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0].id, "composio-toolkit:gmail");
    const effective = await dispatch("sand-rpc:main:m:getEffectivePlugins", {});
    assert.equal(effective.every((entry) => entry.isEnabled === false), true);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v3.1/auth_configs")) {
        return new Response(JSON.stringify({ items: [{ id: "ac_gmail", status: "ENABLED" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v3.1/connected_accounts/link") && init?.method === "POST") {
        return new Response(JSON.stringify({ redirect_url: "https://connect.composio.dev/link/ln_gmail" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v3.1/toolkits")) {
        return new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/listInstalledMcpServers")) {
        return new Response(JSON.stringify({ servers: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const install = await dispatch("sand-rpc:main:m:installEntry", { id: "composio-toolkit:gmail" });
    assert.equal(install.authorizationUrl, "https://connect.composio.dev/link/ln_gmail");
    assert.ok(Array.isArray(install.servers));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
    await configLoaded.dispose();
    await debugLoaded.dispose();
    await settingsLoaded.dispose();
  }
});

test("POST /webhooks/composio verifies HMAC and forwards fireComposioTrigger", async () => {
  const loaded = await loadModule("source/server-main/http-server.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-composio-hook-"));
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  const gatewayCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("box:1340") || url.includes("/api/fireComposioTrigger")) {
      gatewayCalls.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ fired: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return previousFetch(input, init);
  };
  const secret = "whsec_hook";
  await writeFile(path.join(dataDir, "box-secrets.json"), JSON.stringify({ version: 1, secrets: { COMPOSIO_WEBHOOK_SECRET: secret } }));
  const { createHmac } = await import("node:crypto");
  const { resolveRuntimeConfig } = configLoaded.module;
  const { startRuntimeServer } = loaded.module;
  const server = startRuntimeServer(resolveRuntimeConfig({
    GROK_BOT_LISTEN_HOST: "127.0.0.1",
    GROK_BOT_LISTEN_PORT: "0",
    GROK_BOT_DATA_DIR: dataDir,
    GROK_BOT_STATIC_ROOT: path.join(repoRoot, "source", "server-main"),
    SAND_HOST_GATEWAY_URL: "http://box:1340",
  }), { fork: mockFork });
  try {
    await server.ready;
    const payload = JSON.stringify({ metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" }, data: { id: "m1" } });
    const webhookId = "msg_hook";
    const webhookTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v1,${createHmac("sha256", secret).update(`${webhookId}.${webhookTimestamp}.${payload}`).digest("base64")}`;
    const denied = await fetch(`${server.url}/webhooks/composio`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`${server.url}/webhooks/composio`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": webhookTimestamp,
        "webhook-signature": signature,
      },
      body: payload,
    });
    assert.equal(accepted.status, 200);
    assert.ok(gatewayCalls.some((call) => call.url === "http://box:1340/api/fireComposioTrigger" && call.body.includes("GMAIL_NEW_GMAIL_MESSAGE")));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey == null) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousKey;
    await server.close();
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("web attachment handlers stage, commit via gateway, and read bytes", async () => {
  const loaded = await loadModule("source/server-main/web-attachments.ts");
  const configLoaded = await loadModule("source/server-main/config.ts");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-web-attachments-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/uploadAttachment")) {
      return new Response(JSON.stringify({ path: "/attachments/note.txt" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/readAttachmentChunk")) {
      return new Response(JSON.stringify({
        totalSize: 5,
        bytesBase64: Buffer.from("hello").toString("base64"),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const config = configLoaded.module.resolveRuntimeConfig({
      GROK_BOT_DATA_DIR: dataDir,
      GROK_BOT_PUBLIC_URL: "http://127.0.0.1:8080",
      SAND_HOST_GATEWAY_URL: "http://box:1340",
      SAND_GATEWAY_TOKEN: "gate-9999",
    });
    const handlers = loaded.module.createWebAttachmentHandlers(config);
    const staged = await handlers.stageAttachmentBytes({
      filename: "note.txt",
      bytes: [...Buffer.from("hello")],
    });
    assert.equal(staged.ok, true);
    assert.match(String(staged.path), /attachment-staging/);
    const committed = await handlers.commitStagedAttachments({
      paths: [staged.path],
      filenames: ["note.txt"],
    });
    assert.deepEqual(committed, ["/attachments/note.txt"]);
    const bytes = await handlers.readAttachmentBytes({ path: "/attachments/note.txt", maxBytes: 100 });
    assert.deepEqual(bytes, { kind: "bytes", bytes: [...Buffer.from("hello")] });
    assert.equal(
      await handlers.commitStagedAttachments({ paths: ["/etc/passwd"], filenames: ["note.txt"] }),
      null,
    );
  } finally {
    globalThis.fetch = previousFetch;
    await loaded.dispose();
    await configLoaded.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("live docker stack exposes coordinator and box health when running", async () => {
  let response;
  try {
    response = await fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(2_000) });
  } catch {
    return;
  }
  if (!response.ok) return;
  const health = await response.json();
  assert.equal(typeof health.coordinator?.alive, "boolean");
  assert.equal(typeof health.box?.ok, "boolean");
  if (health.coordinator?.alive === true && health.box?.ok === true) {
    assert.equal(health.ok, true);
    assert.equal(health.wsListenerReady, true);
  }
});

test("live docker stack exposes coordinator and box health when running", async () => {
  let response;
  try {
    response = await fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(2_000) });
  } catch {
    return;
  }
  if (!response.ok) return;
  const health = await response.json();
  assert.equal(typeof health.coordinator?.alive, "boolean");
  assert.equal(typeof health.box?.ok, "boolean");
  if (health.coordinator?.alive === true && health.box?.ok === true) {
    assert.equal(health.ok, true);
    assert.equal(health.wsListenerReady, true);
  }
});
