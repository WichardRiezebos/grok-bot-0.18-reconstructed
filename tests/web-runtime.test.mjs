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

test("control image ships the checksum-pinned renderer", async () => {
  const html = await readFile(path.join(repoRoot, "deploy/control/shipped-renderer/index.html"), "utf8");
  assert.match(html, /index-UbX-y3il\.js/);
  assert.match(html, /index-lCyB53CO\.css/);
  const entry = await readFile(path.join(repoRoot, "deploy/control/shipped-renderer/assets/index-UbX-y3il.js"), "utf8");
  assert.match(entry, /sand-/);
});

test("bundled CJS entrypoint still matches node server-main.cjs", async () => {
  const source = await readFile(path.join(repoRoot, "source", "server-main", "main.ts"), "utf8");
  assert.match(source, /function isDirectRun/);
  assert.match(source, /server-main\.cjs/);
});

test("Dokploy compose uses named volumes, env interpolation, and no host ports", async () => {
  const base = await readFile(path.join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
  const local = await readFile(path.join(repoRoot, "deploy", "docker-compose.local.yml"), "utf8");
  assert.match(base, /\$\{OPENROUTER_API_KEY\}/);
  assert.match(base, /\$\{SAND_GATEWAY_TOKEN\}/);
  assert.doesNotMatch(base, /RUNTIME_ACCESS_TOKEN/);
  assert.match(base, /\$\{PUBLIC_URL\}/);
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
    assert.deepEqual(await executors.listRoutedMcpTools(), []);
    await assert.rejects(() => executors.requestWebAuthnConsent(), /WebAuthn is unavailable/);
    await assert.rejects(() => executors.spawnLocalExecDaemon(), /local-exec/);
    const stubs = debug.stubs.snapshot().map((row) => row.method);
    assert.ok(stubs.includes("requestWebAuthnConsent"));
    assert.ok(stubs.includes("spawnLocalExecDaemon"));
    assert.ok(stubs.includes("listRoutedMcpTools"));
  } finally {
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
