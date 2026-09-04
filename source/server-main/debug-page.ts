import type { RuntimeHealth } from "./health.js";
import type { DebugState } from "./debug-log.js";

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

function cell(testId: string, label: string, value: string): string {
  return `<div class="row" data-testid="${testId}"><span class="label">${htmlEscape(label)}</span><span class="value">${htmlEscape(value)}</span></div>`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function renderDebugPage(health: RuntimeHealth, debug: DebugState, debugEnabled: boolean): string {
  const logs = debug.logs.snapshot().map((line) => `${line.at} [${line.stream}] ${line.text}`).join("\n");
  const rpc = debug.rpc.snapshot().map((row) => `${row.at} ${row.ok ? "ok" : "ERR"} ${row.method} ${row.durationMs}ms${row.error != null ? ` ${row.error}` : ""}`).join("\n");
  const stubs = debug.stubs.snapshot().map((row) => `${row.at} ${row.method}: ${row.detail}`).join("\n");
  const boxDetail = health.box.ok ? `${health.box.latencyMs}ms${health.box.isBusy === true ? " busy" : ""}` : (health.box.error ?? "unreachable");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Grok Bot runtime debug</title>
  <style>
    :root { color-scheme: dark; }
    body { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 24px; background: #111; color: #eee; }
    a { color: #8cb4ff; }
    .grid { display: grid; gap: 12px; max-width: 960px; }
    .row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid #333; }
    .label { color: #aaa; }
    pre { background: #1c1c1c; padding: 12px; overflow: auto; max-height: 240px; border-radius: 8px; }
    button { margin-right: 8px; padding: 6px 12px; }
  </style>
</head>
<body>
  <h1>Grok Bot Docker runtime</h1>
  <p><a href="/" data-testid="debug-link-app">Open the app</a></p>
  <div class="grid">
    ${cell("health-ok", "ok", yesNo(health.ok))}
    ${cell("health-runtime", "runtime", health.runtime)}
    ${cell("health-pid", "control pid", String(health.pid))}
    ${cell("health-uptime", "uptime ms", String(health.uptimeMs))}
    ${cell("coordinator-alive", "coordinator alive", yesNo(health.coordinator.alive))}
    ${cell("coordinator-pid", "coordinator pid", health.coordinator.pid == null ? "none" : String(health.coordinator.pid))}
    ${cell("coordinator-exit", "coordinator last exit", health.coordinator.lastExit == null ? "none" : String(health.coordinator.lastExit))}
    ${cell("box-ok", "box reachable", yesNo(health.box.ok))}
    ${cell("box-detail", "box health", boxDetail)}
    ${cell("openrouter-configured", "OpenRouter configured", yesNo(health.openRouterConfigured))}
    ${cell("ws-ready", "WS listener ready", yesNo(health.wsListenerReady))}
    ${cell("ws-clients", "WS clients", String(debug.wsClients))}
    ${cell("ws-last-connect", "last WS connect", debug.lastWsConnectAt ?? "none")}
    ${cell("ws-last-disconnect", "last WS disconnect", debug.lastWsDisconnectAt ?? "none")}
    ${cell("runtime-debug", "RUNTIME_DEBUG", yesNo(debugEnabled))}
  </div>
  <p>
    <button type="button" data-testid="debug-probe-box" id="probe-box">Probe box /health</button>
    <button type="button" data-testid="debug-ping-rpc" id="ping-rpc">Send ping RPC</button>
    <button type="button" data-testid="debug-open-settings" id="open-settings">Open settings overlay</button>
  </p>
  <pre data-testid="debug-action-result" id="action-result">idle</pre>
  <h2>Bots</h2>
  <p><button type="button" data-testid="debug-refresh-bots" id="refresh-bots">Refresh bots</button></p>
  <pre data-testid="debug-bots" id="bots">loading…</pre>
  <h2>RPC</h2>
  <pre data-testid="debug-rpc">${htmlEscape(rpc.length > 0 ? rpc : "(empty)")}</pre>
  <h2>Stubs</h2>
  <pre data-testid="debug-stubs">${htmlEscape(stubs.length > 0 ? stubs : "(empty)")}</pre>
  <h2>Logs</h2>
  <pre data-testid="debug-logs">${htmlEscape(logs.length > 0 ? logs : "(empty)")}</pre>
  <script>
    const result = document.getElementById("action-result");
    document.getElementById("probe-box").onclick = async () => {
      result.textContent = "probing…";
      const response = await fetch("/debug/actions/probe-box", { method: "POST" });
      result.textContent = await response.text();
    };
    document.getElementById("ping-rpc").onclick = async () => {
      result.textContent = "pinging…";
      const response = await fetch("/debug/actions/ping-rpc", { method: "POST" });
      result.textContent = await response.text();
    };
    document.getElementById("open-settings").onclick = async () => {
      result.textContent = "broadcasting open-settings…";
      const response = await fetch("/debug/actions/open-settings", { method: "POST" });
      result.textContent = await response.text();
    };
    const bots = document.getElementById("bots");
    const renderBots = (payload) => {
      if (payload == null || payload.ok !== true) {
        bots.textContent = JSON.stringify(payload ?? { ok: false, reason: "no data" });
        return;
      }
      const inference = payload.inference ?? {};
      const models = inference.models ?? {};
      const lines = [
        "provider " + (inference.provider ?? "?")
          + " think=" + (models.think ?? "?")
          + " drive=" + (models.drive ?? "?")
          + " summarize=" + (models.summarize ?? "?"),
      ];
      const list = Array.isArray(payload.bots) ? payload.bots : [];
      if (list.length === 0) lines.push("(no bot activity yet)");
      for (const bot of list) {
        lines.push(String(bot.name) + " [" + String(bot.id) + "] " + String(bot.state)
          + (bot.slot == null ? "" : " slot=" + bot.slot)
          + " approvals=" + (bot.pendingApprovals ?? 0)
          + " last=" + (bot.lastActivityAt ?? "never"));
        if (bot.streamingPreview) lines.push("  streaming: " + bot.streamingPreview);
        for (const line of bot.recentLog ?? []) lines.push("  " + line.at + " " + line.text);
      }
      for (const line of payload.unassignedLog ?? []) lines.push("(unassigned) " + line.at + " " + line.text);
      bots.textContent = lines.join("\\n");
    };
    const loadBots = async () => {
      try {
        const response = await fetch("/debug/bots");
        renderBots(await response.json());
      } catch (error) {
        bots.textContent = "error " + error;
      }
    };
    document.getElementById("refresh-bots").onclick = loadBots;
    void loadBots();
  </script>
</body>
</html>`;
}

export function renderLoginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Grok Bot runtime</title>
<style>body{font:16px/1.4 system-ui;margin:48px auto;max-width:420px;color:#eee;background:#111}input,button{font:inherit;padding:8px;width:100%;margin:8px 0}label{color:#aaa}</style>
</head>
<body>
  <h1>Grok Bot</h1>
  <p>Enter the runtime access token to continue.</p>
  ${error != null ? `<p data-testid="login-error">${htmlEscape(error)}</p>` : ""}
  <form method="post" action="/login" data-testid="login-form">
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" required data-testid="login-token">
    <button type="submit" data-testid="login-submit">Continue</button>
  </form>
</body>
</html>`;
}

export function renderFallbackApp(debugEnabled: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Grok Bot</title>
  <script src="/__grok_bot/shim.js"></script>
  ${debugEnabled ? '<script src="/__grok_bot/overlay.js"></script>' : ""}
  <style>
    :root { color-scheme: dark; }
    body { font: 15px/1.45 system-ui; margin: 0; background: #111; color: #eee; }
    header { display: flex; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #333; }
    main { padding: 16px; max-width: 720px; }
    textarea { width: 100%; min-height: 80px; }
    #log { white-space: pre-wrap; background: #1c1c1c; padding: 12px; min-height: 200px; }
  </style>
</head>
<body>
  <header>
    <strong>Grok Bot web runtime</strong>
    <a href="/debug" data-testid="app-debug-link">Debug</a>
  </header>
  <main>
    <p data-testid="fallback-banner">Shipped renderer is not in this image. This shell talks to the same WebSocket control plane.</p>
    <p data-testid="ws-state">connecting…</p>
    <textarea id="prompt" data-testid="fallback-prompt" placeholder="Message"></textarea>
    <p><button type="button" id="send" data-testid="fallback-send">Send</button></p>
    <div id="log" data-testid="fallback-log"></div>
  </main>
  <script>
    const log = document.getElementById("log");
    const state = document.querySelector("[data-testid=ws-state]");
    const write = (text) => { log.textContent += text + "\\n"; };
    const waitDesktop = () => new Promise((resolve) => {
      if (window.desktop) return resolve();
      const timer = setInterval(() => { if (window.desktop) { clearInterval(timer); resolve(); } }, 20);
    });
    void waitDesktop().then(async () => {
      state.textContent = window.__grokBotDebug?.connection ?? "shim-ready";
      const env = await window.desktop.agent?.getInferenceRouter?.() ?? await window.desktop.getDesktopEnvironment?.();
      write("router " + JSON.stringify(env));
    });
    document.getElementById("send").onclick = async () => {
      const prompt = document.getElementById("prompt").value.trim();
      if (!prompt) return;
      write("you: " + prompt);
      const claim = window.coordinatorPort?.claim({ onPort(port) {
        port.addEventListener("message", (event) => write("coordinator: " + JSON.stringify(event.data)));
        port.start?.();
        port.postMessage({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
        port.postMessage({ kind: "request", requestId: "t" + Date.now(), method: "sendPrompt", args: { prompt, richText: prompt } });
      }});
      claim?.request();
    };
  </script>
</body>
</html>`;
}
