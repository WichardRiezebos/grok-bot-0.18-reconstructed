(() => {
  // Skip the shipped Electron Sentry renderer SDK. Its dummy DSN and IPC
  // transport throw in a browser and swallow/report unrelated page errors.
  window.__SENTRY__RENDERER_INIT__ = true;
  const sentryUrl = /sentry\.io|ingest\.sentry\.io|metrics\.cursor\.sh|dummy\.dsn/i;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (sentryUrl.test(String(url))) return Promise.resolve(new Response("", { status: 204 }));
    } catch {}
    return originalFetch(input, init);
  };

  const CHROME_CSS = `
html, :root {
  --sand-window-controls-block: 0px !important;
  --sand-window-controls-inset: 0px !important;
  --sand-titlebar-block: 0px !important;
}
html, body, #root, .sand-shell, #root > *, .sand-shell > *,
.sand-info-pane, .sand-computer-preview, .sand-computer-preview__frame,
.sand-box-vnc-pool, .sand-box-vnc-pool__layer { border-radius: 0 !important; }
.sand-window-controls, .sand-cover-drag { display: none !important; height: 0 !important; width: 0 !important; padding: 0 !important; }
.sand-empty { padding-top: 0 !important; }
.sand-agents-sidebar__header { height: auto !important; min-height: 0 !important; padding-top: 8px !important; }
webview { display: block !important; width: 100% !important; height: 100% !important; border: 0 !important; }
.sand-box-vnc-pool__layer:not(.sand-lshs6z) {
  visibility: visible !important;
  opacity: 1 !important;
  pointer-events: auto !important;
}
.sand-box-vnc-pool:has(webview[data-grok-bot-vnc-connected="1"]) .sand-box-vnc-pool__connecting {
  display: none !important;
}
.sand-virtual-transcript__inset:empty,
.sand-message-prose:empty,
.sand-message:empty { display: none !important; }
`;
  const chrome = document.createElement("style");
  chrome.dataset.testid = "grok-bot-chrome";
  chrome.textContent = CHROME_CSS;
  (document.head ?? document.documentElement).appendChild(chrome);

  function flattenWindowChrome() {
    const root = document.documentElement;
    if (root.style.getPropertyValue("--sand-window-controls-block") !== "0px") {
      root.style.setProperty("--sand-window-controls-block", "0px", "important");
    }
    if (root.style.getPropertyValue("--sand-window-controls-inset") !== "0px") {
      root.style.setProperty("--sand-window-controls-inset", "0px", "important");
    }
    if (root.style.getPropertyValue("--sand-titlebar-block") !== "0px") {
      root.style.setProperty("--sand-titlebar-block", "0px", "important");
    }
  }
  flattenWindowChrome();
  new MutationObserver(flattenWindowChrome).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });

  function rewriteLoopbackVncUrl(src) {
    let parsed;
    try { parsed = new URL(src, location.origin); } catch { return src; }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const port = Number.parseInt(parsed.port, 10);
    if (!loopback || (port !== 6080 && port !== 6081)) return src;
    const prefix = port === 6081 ? "/__grok_bot/vnc/fork" : "/__grok_bot/vnc/primary";
    const rawPath = parsed.searchParams.get("path");
    if (rawPath && !rawPath.includes("__grok_bot/vnc/")) {
      parsed.searchParams.set("path", `${prefix.replace(/^\//, "")}/${rawPath.replace(/^\//, "")}`);
    }
    return `${prefix}${parsed.pathname}${parsed.search}`;
  }

  const VNC_SESSION_CHANNEL = "sand:vnc-session";
  const VNC_VIEWER_VISIBLE_CHANNEL = "sand:vnc-viewer-visible";
  const NO_VNC_CHROME_HIDER_CSS = `
    #noVNC_control_bar,
    #noVNC_control_bar_handle,
    #noVNC_control_bar_anchor,
    #noVNC_status,
    .noVNC_logo {
      display: none !important;
      pointer-events: none !important;
      visibility: hidden !important;
    }
  `;

  function hideNoVncChrome(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (doc == null) return;
      let style = doc.getElementById("grok-bot-novnc-chrome");
      if (style == null) {
        style = doc.createElement("style");
        style.id = "grok-bot-novnc-chrome";
        style.textContent = NO_VNC_CHROME_HIDER_CSS;
        (doc.head ?? doc.documentElement).appendChild(style);
      }
      doc.getElementById("noVNC_control_bar")?.classList.remove("noVNC_open");
    } catch {}
  }

  function dispatchWebviewEvent(el, type, extra) {
    el.dispatchEvent(Object.assign(new Event(type), extra ?? {}));
  }

  function signalWebviewReady(el) {
    if (el.dataset.grokBotVncReady === "1") return;
    el.dataset.grokBotVncReady = "1";
    dispatchWebviewEvent(el, "dom-ready");
    dispatchWebviewEvent(el, "did-finish-load");
  }

  function iframeLooksConnected(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (doc == null) return false;
      if (doc.documentElement?.classList.contains("noVNC_connected")) return true;
      const status = doc.getElementById("noVNC_status");
      if (status != null && /connected/i.test(status.textContent ?? "")) return true;
      const canvas = doc.querySelector("canvas");
      return canvas != null && canvas.width > 0 && canvas.height > 0;
    } catch {
      return false;
    }
  }

  function refreshNoVncIframe(iframe) {
    try {
      const win = iframe.contentWindow;
      const rfb = win?.UI?.rfb ?? win?.rfb;
      if (rfb != null) {
        try {
          if (typeof rfb.scaleViewport === "boolean") rfb.scaleViewport = rfb.scaleViewport;
          rfb.focus?.();
        } catch {}
        return;
      }
    } catch {}
    const src = iframe.getAttribute("src") || "";
    if (src.length === 0 || iframe.dataset.grokBotVncRefreshing === "1") return;
    iframe.dataset.grokBotVncRefreshing = "1";
    const stripped = src.replace(/([?&])grokBotFb=\d+/g, "$1").replace(/[?&]$/, "");
    const join = stripped.includes("?") ? "&" : "?";
    iframe.setAttribute("src", `${stripped}${join}grokBotFb=${Date.now()}`);
    iframe.addEventListener("load", () => { delete iframe.dataset.grokBotVncRefreshing; }, { once: true });
  }

  function attachVncVisibility(el, iframe) {
    if (el.dataset.grokBotVncVisibility === "1") return;
    el.dataset.grokBotVncVisibility = "1";
    let hidden = true;
    el.send = (channel, value) => {
      try { iframe.contentWindow?.postMessage({ channel, value }, "*"); } catch {}
      if (channel === VNC_VIEWER_VISIBLE_CHANNEL && value === true) refreshNoVncIframe(iframe);
    };
    const show = () => {
      if (!hidden) return;
      hidden = false;
      el.send(VNC_VIEWER_VISIBLE_CHANNEL, true);
    };
    const hide = () => { hidden = true; };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) show();
      else hide();
    }, { threshold: 0.05 });
    observer.observe(el);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        hidden = true;
        show();
      } else hide();
    });
  }

  function watchAdoptedWebview(el, iframe) {
    const src = iframe.getAttribute("src") || "";
    if (el.dataset.grokBotVncWatchSrc === src && el.dataset.grokBotVncWatching === "1") return;
    el.dataset.grokBotVncWatchSrc = src;
    el.dataset.grokBotVncWatching = "1";
    delete el.dataset.grokBotVncReady;
    delete el.dataset.grokBotVncConnected;
    delete el.dataset.grokBotVncConnectedAt;

    const tick = () => {
      hideNoVncChrome(iframe);
      try {
        const doc = iframe.contentDocument;
        if (doc != null && (doc.readyState === "interactive" || doc.readyState === "complete")) {
          signalWebviewReady(el);
        }
      } catch {}
      if (!iframeLooksConnected(iframe)) return false;
      signalWebviewReady(el);
      el.dataset.grokBotVncConnected = "1";
      if (el.dataset.grokBotVncConnectedAt == null) el.dataset.grokBotVncConnectedAt = String(Date.now());
      dispatchWebviewEvent(el, "ipc-message", {
        channel: VNC_SESSION_CHANNEL,
        args: [JSON.stringify({ phase: "rfb_connect" })],
      });
      return Date.now() - Number(el.dataset.grokBotVncConnectedAt) > 4000;
    };

    iframe.addEventListener("load", () => {
      signalWebviewReady(el);
      tick();
    });
    if (tick()) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (tick() || Date.now() - started > 30_000) clearInterval(timer);
    }, 250);
  }

  function adoptWebview(el) {
    if (el.tagName !== "WEBVIEW") return;
    let iframe = el.shadowRoot?.querySelector("iframe");
    if (iframe == null) {
      try {
        const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
        const hostStyle = document.createElement("style");
        hostStyle.textContent = ":host { display: block; width: 100%; height: 100%; }";
        iframe = document.createElement("iframe");
        iframe.setAttribute("data-testid", "grok-bot-vnc-frame");
        iframe.setAttribute("title", "Grok's screen");
        iframe.setAttribute("allow", "fullscreen");
        iframe.style.cssText = "display:block;width:100%;height:100%;border:0;background:#111";
        shadow.append(hostStyle, iframe);
      } catch (error) {
        console.info("[grok-bot] webview iframe failed", error);
        return;
      }
    }
    const next = rewriteLoopbackVncUrl(el.getAttribute("src") || "");
    if (next.length > 0 && iframe.getAttribute("src") !== next) iframe.setAttribute("src", next);
    if (next.length > 0) {
      watchAdoptedWebview(el, iframe);
      attachVncVisibility(el, iframe);
    }
  }

  function scanWebviews(root) {
    if (root.tagName === "WEBVIEW") adoptWebview(root);
    if (root.querySelectorAll != null) for (const node of root.querySelectorAll("webview")) adoptWebview(node);
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target.tagName === "WEBVIEW") adoptWebview(record.target);
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) scanWebviews(node);
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  scanWebviews(document.documentElement);

  const log = (...args) => console.info("[grok-bot]", ...args);
  const rpcLog = [];
  const state = {
    connection: "connecting",
    lastError: null,
    debug: false,
    runtimeHealth: null,
    health: async () => {
      const token = new URLSearchParams(location.search).get("token");
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      return fetch(`/health${query}`, { credentials: "same-origin" }).then((r) => r.json());
    },
  };

  function probeRuntimeHealth() {
    void state.health().then((value) => {
      if (value == null || typeof value !== "object") return;
      state.runtimeHealth = value;
      window.dispatchEvent(new CustomEvent("grok-bot-runtime-health", { detail: value }));
      paintRuntimeHealthNotice();
      syncComputerRebuildSuppression(value);
    }, () => {});
  }

  // The 0.36 renderer latches its "Updating Grok Bot's Computer" pill from
  // host-update signals that do not apply to this runtime (the computer is the
  // fixed compose `box` service; image/host bundle updates are disabled). When
  // the box is verifiably healthy, hide the rebuild chrome; when it is not,
  // leave genuine recover/reset flows visible.
  function syncComputerRebuildSuppression(health) {
    const boxOk = health?.box?.ok === true;
    const styleId = "grok-bot-rebuild-suppression";
    let style = document.getElementById(styleId);
    if (boxOk) {
      if (style == null) {
        style = document.createElement("style");
        style.id = styleId;
        style.textContent = ".sand-computer-rebuild-banner,[aria-label*=\"Updating Grok Bot's Computer\"],[aria-label*=\"Resetting Grok Bot's Computer\"],[aria-label*=\"Recovering Grok Bot's Computer\"]{display:none!important}";
        document.head.appendChild(style);
      }
      return;
    }
    style?.remove();
  }

  function installRuntimeHealthNotice() {
    let notice = null;
    const ensureNotice = () => {
      if (notice != null) return notice;
      if (document.body == null) {
        // The shim loads in <head>; the health probe can resolve before <body> exists.
        document.addEventListener("DOMContentLoaded", () => {
          if (document.body != null) window.paintRuntimeHealthNotice?.();
        }, { once: true });
        return null;
      }
      notice = document.createElement("div");
      notice.dataset.testid = "grok-bot-runtime-health";
      notice.setAttribute("role", "status");
      notice.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10001;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;background:color-mix(in srgb, var(--cursor-bg-primary, #111) 92%, transparent);border:1px solid color-mix(in srgb, var(--cursor-text-primary, #eee) 18%, transparent);color:var(--cursor-text-primary, #eee);font:13px/1.35 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28)";
      const label = document.createElement("span");
      label.dataset.testid = "grok-bot-runtime-health-label";
      const detail = document.createElement("span");
      detail.dataset.testid = "grok-bot-runtime-health-detail";
      detail.style.cssText = "opacity:.72;font-size:12px";
      notice.append(label, detail);
      document.body.appendChild(notice);
      return notice;
    };
    window.paintRuntimeHealthNotice = () => {
      const health = state.runtimeHealth;
      if (health == null || typeof health !== "object") return;
      const coordinatorAlive = health.coordinator?.alive === true;
      const ok = health.ok === true;
      if (coordinatorAlive && ok) {
        notice?.remove();
        notice = null;
        return;
      }
      const node = ensureNotice();
      if (node == null) return;
      const label = node.querySelector("[data-testid='grok-bot-runtime-health-label']");
      const detail = node.querySelector("[data-testid='grok-bot-runtime-health-detail']");
      const reconnecting = !coordinatorAlive || state.connection === "reconnecting" || state.connection === "connecting";
      node.dataset.variant = reconnecting ? "reconnecting" : "unhealthy";
      if (label != null) {
        label.textContent = reconnecting ? "Reconnecting to your computer…" : "Runtime health check failed";
      }
      if (detail != null) {
        const parts = [];
        if (!coordinatorAlive) parts.push("coordinator down");
        if (health.box?.ok !== true) parts.push("box unreachable");
        if (health.wsListenerReady !== true) parts.push("websocket not ready");
        detail.textContent = parts.length > 0 ? parts.join(" · ") : "waiting for recovery";
      }
    };
    window.addEventListener("grok-bot-runtime-health", () => paintRuntimeHealthNotice());
    window.addEventListener("grok-bot-ws", () => paintRuntimeHealthNotice());
    const mount = () => paintRuntimeHealthNotice();
    if (document.body != null) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  }

  function paintRuntimeHealthNotice() {
    window.paintRuntimeHealthNotice?.();
  }

  function installToolSurfaceNotice() {
    let notice = null;
    const LOCAL_MACHINE_HINT = "local machine isn't connected";
    window.noteToolSurfaceError = (message) => {
      const text = String(message ?? "");
      if (!text.toLowerCase().includes(LOCAL_MACHINE_HINT)) return;
      if (notice == null) {
        notice = document.createElement("div");
        notice.dataset.testid = "grok-bot-tool-surface";
        notice.setAttribute("role", "status");
        notice.style.cssText = "position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:10000;max-width:min(560px,calc(100vw - 24px));padding:10px 14px;border-radius:12px;background:color-mix(in srgb, var(--cursor-bg-primary, #111) 94%, transparent);border:1px solid color-mix(in srgb, #f5a623 40%, transparent);color:var(--cursor-text-primary, #eee);font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.24)";
        notice.textContent = "Mac desktop tools are unavailable in this web runtime. Use Task → browserUse for browser work on the box.";
        document.body.appendChild(notice);
      }
      clearTimeout(notice._hideTimer);
      notice._hideTimer = setTimeout(() => { notice?.remove(); notice = null; }, 12_000);
    };
  }

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const token = new URLSearchParams(location.search).get("token");
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${proto}//${location.host}/ws${query}`;
  }

  let socket;
  let reconnectMs = 500;
  const pending = new Map();
  const outbound = [];
  const eventListeners = new Map();
  let coordinatorPort = null;
  let coordinatorMainPort = null;
  let owner = null;

  function emitEvent(channel, payload) {
    const set = eventListeners.get(channel);
    if (set == null) return;
    // Electron ipcRenderer.on listeners are (event, payload).
    for (const listener of set) {
      try { listener(undefined, payload); }
      catch (error) { console.error("[grok-bot] event listener failed", channel, error); }
    }
  }

  let noteRoutedSend = () => {};
  let noteRoutedAgents = () => {};
  let noteRoutedLine = () => {};
  const debugFrameLog = [];
  const noteDebugFrame = (method) => { if (!method.startsWith("main:") && !method.startsWith("data:update") && method !== "data:ensureForeverBox" && method !== "data:getForeverBoxStatus") return;
    debugFrameLog.push(`${Date.now() % 100000} ${method}`);
    if (debugFrameLog.length > 120) debugFrameLog.shift();
    if (socket != null && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ kind: "debug-note", text: debugFrameLog.join(" | ").slice(0, 1900) })); } catch {}
    }
  };

  function sendSocket(payload) {
    try {
      const parsed = typeof payload === "string" ? JSON.parse(payload) : null;
      if (parsed && parsed.kind === "coordinator" && parsed.frame && parsed.frame.kind === "request" && parsed.frame.method === "sendPrompt") {
        const agentId = parsed.frame.args && parsed.frame.args.agentId;
        if (typeof agentId === "string") noteRoutedSend(agentId);
      }
      if (parsed && parsed.kind === "coordinator-main" && parsed.frame && parsed.frame.kind === "request") {
        noteDebugFrame(parsed.frame.method);
      }
      if (parsed && parsed.kind === "coordinator" && parsed.frame && parsed.frame.kind === "request" && typeof parsed.frame.method === "string" && parsed.frame.method !== "sendPrompt") {
        noteDebugFrame(`data:${parsed.frame.method}`);
      }
    } catch {}
    if (socket != null && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
      return;
    }
    outbound.push(payload);
  }

  function rejectPending(reason) {
    for (const wait of pending.values()) wait.reject(new Error(reason));
    pending.clear();
  }

  function showSupersededNotice() {
    if (document.querySelector("[data-testid='grok-bot-superseded']")) return;
    const notice = document.createElement("div");
    notice.dataset.testid = "grok-bot-superseded";
    notice.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#111;color:#eee;font:14px/1.4 system-ui,sans-serif";
    const text = document.createElement("p");
    text.textContent = "This tab is no longer live. Another tab is talking to Grok.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Use here";
    button.style.cssText = "padding:8px 16px;color:#111;background:#eee;border:0;cursor:pointer";
    button.addEventListener("click", () => location.reload());
    notice.append(text, button);
    document.body.appendChild(notice);
  }

  function attachSocket() {
    socket = new WebSocket(wsUrl());
    socket.addEventListener("open", () => {
      reconnectMs = 500;
      state.connection = "connected";
      log("websocket open");
      paintRuntimeHealthNotice();
      for (const payload of outbound.splice(0)) socket.send(payload);
      owner?.onPort(coordinatorPort);
      window.dispatchEvent(new Event("grok-bot-ws"));
    });
    socket.addEventListener("error", () => {
      state.connection = "down";
      state.lastError = "websocket error";
      log("websocket error");
      paintRuntimeHealthNotice();
    });
    socket.addEventListener("close", (event) => {
      rejectPending("websocket closed");
      if (event.code === 4409) {
        state.connection = "superseded";
        state.lastError = "superseded by another tab";
        log("websocket superseded; waiting for Use here");
        showSupersededNotice();
        return;
      }
      if (event.code === 1012) {
        state.connection = "reconnecting";
        log("coordinator restarted; reconnecting");
        paintRuntimeHealthNotice();
        setTimeout(attachSocket, 0);
        return;
      }
      state.connection = "reconnecting";
      log("websocket closed; reconnecting");
      paintRuntimeHealthNotice();
      setTimeout(attachSocket, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, 8000);
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.kind === "hello-ok") {
        state.debug = message.debug === true;
        window.__grokBotInitialState = message.initialState;
        return;
      }
      if (message.kind === "rpc-ok") {
        const wait = pending.get(message.id);
        if (wait != null) { pending.delete(message.id); wait.resolve(message.value); }
        return;
      }
      if (message.kind === "rpc-err") {
        const wait = pending.get(message.id);
        if (wait != null) { pending.delete(message.id); wait.reject(Object.assign(new Error(message.failure.detail), { code: message.failure.code, detail: message.failure.detail })); }
        return;
      }
      if (message.kind === "event") {
        const channel = String(message.channel ?? "");
        emitEvent(channel.startsWith("sand-rpc:main:e:") ? channel : `sand-rpc:main:e:${channel}`, message.payload);
        return;
      }
      if (message.kind === "coordinator" && coordinatorPort != null) {
        try {
          if (message.frame && message.frame.kind === "event" && message.frame.family === "agents") {
            noteRoutedAgents(message.frame.payload);
          }
        } catch {}
        coordinatorPort._emit(message.frame);
      }
      if (message.kind === "coordinator-main" && coordinatorMainPort != null) coordinatorMainPort._emit(message.frame);
    });
  }

  function rpc(channel, payload) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const send = () => {
        sendSocket(JSON.stringify({ kind: "rpc", id, channel, payload }));
      };
      send();
    }).then((value) => {
      rpcLog.push({ method: channel, ok: true, durationMs: Date.now() - started });
      if (rpcLog.length > 100) rpcLog.shift();
      return value;
    }, (error) => {
      state.lastError = error.message;
      window.noteToolSurfaceError?.(error.message);
      rpcLog.push({ method: channel, ok: false, durationMs: Date.now() - started, error: error.message });
      if (rpcLog.length > 100) rpcLog.shift();
      console.group("[grok-bot] rpc failed");
      console.info(channel, error);
      console.groupEnd();
      throw error;
    });
  }

  function createPort(kind) {
    const listeners = { message: [], close: [] };
    return {
      postMessage(data) {
        sendSocket(JSON.stringify({ kind, frame: data }));
      },
      close() {
        listeners.message.length = 0;
        listeners.close.length = 0;
      },
      start() {},
      addEventListener(type, listener) {
        if (listeners[type] != null) listeners[type].push(listener);
      },
      _emit(data) {
        for (const listener of listeners.message) listener({ data });
      },
    };
  }

  coordinatorPort = createPort("coordinator");
  coordinatorMainPort = createPort("coordinator-main");

  const initial = () => window.__grokBotInitialState ?? {
    experimentSnapshot: { flags: {}, runtime: "docker" },
    themeState: { preference: "system", resolved: "dark", source: "docker" },
    egressTunnelEnabled: false,
    webauthnProxyEnabled: false,
    egressTunnelStatus: { state: "off", relayedStreams: 0, activeStreams: 0 },
  };

  const ipc = {
    invoke: (channel, payload) => rpc(channel, payload),
    sendSync(channel) {
      const snapshot = initial();
      if (channel === "sand:experiments-snapshot-sync") return snapshot.experimentSnapshot;
      if (channel === "sand:theme-get-sync") return snapshot.themeState;
      if (channel === "sand:egress-tunnel-get-sync") return snapshot.egressTunnelEnabled;
      if (channel === "sand:webauthn-proxy-get-sync") return snapshot.webauthnProxyEnabled;
      if (channel === "sand:egress-tunnel-status-get-sync") return snapshot.egressTunnelStatus;
      return null;
    },
    send() {},
    on(channel, listener) {
      const set = eventListeners.get(channel) ?? new Set();
      set.add(listener);
      eventListeners.set(channel, set);
    },
    off(channel, listener) {
      eventListeners.get(channel)?.delete(listener);
    },
  };

  function methodChannel(edge, method) { return `sand-rpc:${edge}:m:${method}`; }
  const mainMethods = [
    "openExternal", "submitFeedback", "getDesktopEnvironment", "getWindowState", "minimizeWindow", "toggleMaximizeWindow",
    "closeWindow", "resizeWindowWidth", "setTitleBarOverlayTone", "getThemeState", "setThemePreference",
    "getEgressTunnelEnabled", "setEgressTunnelEnabled", "getEgressTunnelStatus", "getWebauthnProxyEnabled", "setWebauthnProxyEnabled",
    "getUpdateStatus", "checkForUpdates", "setUpdateTrack", "quitAndInstallUpdate", "setAutoUpdateWhenIdleOptIn",
    "getBoxMigrationStatus", "markDeepLinksReady", "getOnboardingSeen", "setOnboardingSeen", "getTimeZone", "setTimeZoneOverride",
    "getAutoReviewInstructions", "setAutoReviewInstructions", "getLocalToolPermission", "getLocalToolPermissionCeiling",
    "setLocalToolPermission", "recordLocalToolApproval", "clearLocalToolApprovals", "getSidebarCollapsed", "setSidebarCollapsed",
    "pickAvatarSource", "pickAvatarFile", "generateAgentAvatarImage", "resolveAttachmentMedia", "readAttachmentText",
    "readAttachmentBytes", "stageAttachmentBytes", "downloadAttachment", "commitStagedAttachments", "discardStagedAttachment",
    "forceRecreateComputer", "updateComputer", "forceReconnectGateway", "getExperimentsSnapshot", "applyFeatureFlagOverride",
    "refreshFeatureFlags", "startRpcTraceWindow", "getAgentDefaultModel", "setAgentDefaultModel", "getComputerUseModel",
    "setComputerUseModel", "getHostPinnedAgents", "setHostPinnedAgents", "getHostSidebarSections", "setHostSidebarSections",
    "getAvailableModels", "getInferenceRouter", "setInferenceRouter", "listOpenRouterModels", "getBoxRuntime", "setBoxRuntime",
    "setBoxAutoSuspendIdleMs", "suspendBox", "resumeBox",
    "getLocalProfile", "updateLocalProfile",
    "transcribeAudio", "getCursorAuthStatus", "loginCursor", "cancelCursorLogin", "logoutCursor", "updateCursorAccountName",
    "getCursorAvatar", "getCursorWeeklyUsage", "getCursorUsageSummary", "getCursorPrReviewPreferences", "getCursorPrivacyModeEnabled",
    "getSandAccess", "getSandAccessFresh", "invokeCursorDashboardAction", "cancelCursorSandTrial", "reportAgentLoad",
    "reportAccessBlocked", "reportAgentsUnreachable", "reportRecoveryAction", "reportRebuildLifecycle", "reportReconciliation",
    "reportBoxVisibility", "reportSendLatency", "reportSendAck", "reportReactionAck", "reportRenderTtfr", "reportRenderStream",
    "reportVncSession", "reportVncLiveness", "reportOpenComputer", "reportUpdatePrompt", "reportSigninGate", "reportOnboardingStep",
    "reportClientFailure", "openCloudAgent", "getLinkMetadata", "listSecrets", "revealSecret", "upsertSecrets", "removeSecrets",
    "getMcpState", "getEffectivePlugins", "getMcpCatalog", "getMcpTeamPopularity", "getMcpPluginLogo", "installEntry",
    "updatePluginInstall", "removeMcpServer", "uninstallPlugin", "authenticateMcpServer", "renameMcpAccount", "removeMcpAccount",
    "setMcpCustomInstructions", "listMcpServerTools", "toggleMcpToolDisabled",
  ];
  const edge = {};
  for (const method of mainMethods) {
    edge[method] = (args) => rpc(methodChannel("main", method), args ?? {});
  }
  function bytesToBase64(bytes) {
    if (!(bytes instanceof Uint8Array)) return bytes;
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }
  edge.subscribe = (handlers) => {
    const unsubs = [];
    for (const [event, listener] of Object.entries(handlers)) {
      if (listener == null) continue;
      const channel = `sand-rpc:main:e:${event}`;
      const wrapped = (_evt, payload) => listener(payload);
      ipc.on(channel, wrapped);
      unsubs.push(() => ipc.off(channel, wrapped));
    }
    return () => { for (const unsub of unsubs) unsub(); };
  };

  const desktop = {
    platform: "linux",
    isDev: false,
    getZoomFactor: () => 1,
    resolveAttachmentMedia: (url) => edge.resolveAttachmentMedia({ source: url }),
    readAttachmentText: (path) => edge.readAttachmentText({ path }),
    readAttachmentBytes: (path, maxBytes) => edge.readAttachmentBytes({ path, maxBytes }),
    downloadAttachment: (path, suggestedName) => edge.downloadAttachment({ path, suggestedName }),
    getLinkMetadata: (url) => edge.getLinkMetadata({ url }),
    async openExternal(url) {
      const target = typeof url === "string" ? url : url?.url;
      if (typeof target === "string" && target.length > 0) {
        window.open(target, "_blank", "noopener,noreferrer");
      }
      await edge.openExternal(typeof url === "string" ? { url } : url ?? {});
    },
    async openCloudAgent(bcId) { await edge.openCloudAgent({ bcId }) },
    // The renderer's desktop bridge composes stageAttachmentFile(filename, File)
    // on top of the raw transport; the Electron preload provides it, so the web
    // shim has to too — without it every file-picker attach rejects with
    // "Couldn't attach" before any RPC fires.
    async stageAttachmentFile(filename, file) {
      if (typeof file?.arrayBuffer !== "function") return { ok: false, reason: "failed" };
      const bytes = new Uint8Array(await file.arrayBuffer());
      return edge.stageAttachmentBytes({ filename, bytes: bytesToBase64(bytes) });
    },
    // JSON RPC cannot carry a live Uint8Array (it stringifies into a numeric-key
    // object the control's byte normalizer rejects), so hand the bytes over as
    // base64 — the control's attachment handlers accept that shape directly.
    stageAttachmentBytes: (filename, bytes) => edge.stageAttachmentBytes({ filename, bytes: bytesToBase64(bytes) }),
    commitStagedAttachments: (paths, filenames) => {
      // The 0.36 renderer invokes this with a single payload object
      // ({ agentId, paths, filenames }); keep the positional form working too.
      const payload = paths != null && typeof paths === "object" && !Array.isArray(paths)
        ? paths
        : { paths, filenames };
      return edge.commitStagedAttachments(payload);
    },
    async discardStagedAttachment(path) { await edge.discardStagedAttachment({ path }); },
    mcp: {
      list: () => ipc.invoke("sand:mcp-list"),
      effectivePlugins: () => ipc.invoke("sand:mcp-effective-plugins"),
      catalog: () => ipc.invoke("sand:mcp-catalog"),
      teamPopularity: () => ipc.invoke("sand:mcp-team-popularity"),
      pluginLogo: (url) => ipc.invoke("sand:mcp-plugin-logo", { url }),
      install: async (request) => {
        const result = await ipc.invoke("sand:mcp-install", request);
        if (result != null && typeof result === "object" && typeof result.authorizationUrl === "string" && result.authorizationUrl.length > 0) {
          window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
        }
        if (result != null && typeof result === "object" && Array.isArray(result.servers)) return result;
        return result?.state ?? result;
      },
      updatePluginInstall: (request) => ipc.invoke("sand:mcp-update-plugin-install", request),
      remove: (serverId) => ipc.invoke("sand:mcp-remove", { serverId }),
      uninstallPlugin: (pluginId) => ipc.invoke("sand:mcp-uninstall-plugin", { pluginId }),
      authenticate: (serverId, accountKey, trigger) => ipc.invoke("sand:mcp-auth", { serverId, accountKey, trigger }),
      renameAccount: (args) => ipc.invoke("sand:mcp-rename-account", args),
      removeAccount: (args) => ipc.invoke("sand:mcp-remove-account", args),
      setCustomInstructions: (args) => ipc.invoke("sand:mcp-set-instructions", args),
      listServerTools: (serverId) => ipc.invoke("sand:mcp-list-server-tools", { serverId }),
      toggleToolDisabled: (args) => ipc.invoke("sand:mcp-toggle-tool-disabled", args),
      onAuthCompleted: (listener) => { ipc.on("sand:mcp-auth-event", listener); return () => ipc.off("sand:mcp-auth-event", listener); },
    },
    async forceGatewayReconnect() { await edge.forceReconnectGateway(); },
    pickAvatarSource: () => edge.pickAvatarSource(),
    pickAvatarFile: () => edge.pickAvatarFile(),
    generateAgentAvatarImage: (description) => edge.generateAgentAvatarImage({ description }),
    onFocusAgent: (listener) => edge.subscribe({ "focus-agent": listener }),
    onDeepLink: (listener) => edge.subscribe({ "deep-link": listener }),
    async deepLinksReady() { await edge.markDeepLinksReady(); },
    getBoxMigrationStatus: () => edge.getBoxMigrationStatus(),
    onBoxMigration: (listener) => edge.subscribe({ "box-migration": listener }),
    onBoxHostPhase: (listener) => edge.subscribe({ "box-host-phase": listener }),
    onDevBoxRebuild: (listener) => edge.subscribe({ "dev-box-rebuild": listener }),
    onOpenFeedback: (listener) => edge.subscribe({ "open-feedback": () => listener() }),
    onOpenAbout: (listener) => edge.subscribe({ "open-about": () => listener() }),
    onOpenSettings: (listener) => edge.subscribe({ "open-settings": () => listener() }),
    onWidgetGallery: (listener) => edge.subscribe({ "widget-gallery": listener }),
    onForceOnboarding: (listener) => edge.subscribe({ "force-onboarding": () => listener() }),
    submitFeedback: (payload) => edge.submitFeedback(payload),
    transcribeAudio: (audio, mimeType, language) => edge.transcribeAudio({ audio, mimeType, language }),
    cursorAccount: {
      getStatus: () => edge.getCursorAuthStatus(),
      login: () => edge.loginCursor(),
      cancelLogin: () => edge.cancelCursorLogin(),
      logout: () => edge.logoutCursor(),
      async updateName(name) {
        const status = await edge.updateCursorAccountName({ name });
        emitEvent("sand-rpc:main:e:cursor-auth-changed", status);
        return status;
      },
      getAvatar: () => edge.getCursorAvatar(),
      getWeeklyUsage: () => edge.getCursorWeeklyUsage(),
      getUsageSummary: () => edge.getCursorUsageSummary(),
      getPrReviewPreferences: () => edge.getCursorPrReviewPreferences(),
      getPrivacyModeEnabled: () => edge.getCursorPrivacyModeEnabled(),
      getSandAccess: () => edge.getSandAccess(),
      getSandAccessFresh: () => edge.getSandAccessFresh(),
      invokeDashboardAction: (request) => edge.invokeCursorDashboardAction(request),
      cancelTrial: () => edge.cancelCursorSandTrial(),
      getLoginFlight: () => ({ kind: "idle" }),
      onLoginFlightChanged: (listener) => edge.subscribe({ "cursor-login-flight-changed": listener }),
      onStatusChanged: (listener) => edge.subscribe({ "cursor-auth-changed": listener }),
    },
    experiments: {
      get initialSnapshot() { return initial().experimentSnapshot; },
      getSnapshot: () => edge.getExperimentsSnapshot(),
      async applyFeatureFlagOverride(command) { await edge.applyFeatureFlagOverride({ command }); },
      async refresh() { await edge.refreshFeatureFlags(); },
      async startRpcTraceWindow() { return await edge.startRpcTraceWindow() === true; },
      onChanged: (listener) => edge.subscribe({ "experiments-changed": listener }),
    },
    getWindowState: () => edge.getWindowState(),
    onWindowStateEvent: (listener) => edge.subscribe({ "window-state": listener }),
    onZoomFactorEvent: (listener) => edge.subscribe({ "zoom-factor-changed": ({ factor }) => listener(factor) }),
    windowControls: {
      async minimize() { await edge.minimizeWindow(); },
      async toggleMaximize() { await edge.toggleMaximizeWindow(); },
      async close() { await edge.closeWindow(); },
      async setTitleBarOverlayTone(isOverlayTone) { await edge.setTitleBarOverlayTone({ isOverlayTone }); },
      resizeWidth: (deltaWidth) => edge.resizeWindowWidth({ deltaWidth }),
    },
    foreverBox: {
      forceRecreate: () => edge.forceRecreateComputer(),
      update: (id, force = false) => edge.updateComputer({ id, force }),
      onVncUserPresence: (listener) => edge.subscribe({ "vnc-user-presence": ({ isPresent }) => listener(isPresent) }),
      onDevBoxPullProgress: (listener) => edge.subscribe({ "dev-box-pull-progress": listener }),
      onUpdateDispatched: (listener) => edge.subscribe({ "update-computer-dispatched": listener }),
      egressTunnel: {
        get initial() { return initial().egressTunnelEnabled; },
        get: async () => await edge.getEgressTunnelEnabled() === true,
        set: async (enabled) => await edge.setEgressTunnelEnabled({ enabled }) === true,
        onChanged: (listener) => edge.subscribe({ "egress-tunnel-changed": (enabled) => listener(enabled === true) }),
        get initialStatus() { return initial().egressTunnelStatus; },
        getStatus: () => edge.getEgressTunnelStatus(),
        onStatusChanged: (listener) => edge.subscribe({ "egress-tunnel-status-changed": listener }),
      },
      webauthnProxy: {
        get initial() { return initial().webauthnProxyEnabled; },
        get: async () => await edge.getWebauthnProxyEnabled() === true,
        set: async (enabled) => await edge.setWebauthnProxyEnabled({ enabled }) === true,
        onChanged: (listener) => edge.subscribe({ "webauthn-proxy-changed": (enabled) => listener(enabled === true) }),
      },
    },
    onboarding: {
      getSeen: () => edge.getOnboardingSeen(),
      async setSeen(seen) { await edge.setOnboardingSeen({ seen }); },
      onSkip: (listener) => edge.subscribe({ "skip-onboarding": () => listener() }),
    },
    telemetry: Object.fromEntries([
      "reportAgentLoad", "reportAccessBlocked", "reportAgentsUnreachable", "reportRecoveryAction",
      "reportRebuildLifecycle", "reportReconciliation", "reportBoxVisibility", "reportSendLatency",
      "reportHeapMetrics", "reportSendAck", "reportReactionAck", "reportRenderTtfr", "reportRenderStream",
      "reportVncSession", "reportVncLiveness", "reportOpenComputer", "reportUpdatePrompt",
      "reportSigninGate", "reportOnboardingStep", "reportClientFailure", "noteSentryConversation",
    ].map((method) => [method, () => {}])),
    timeZone: {
      get: () => edge.getTimeZone(),
      setOverride: (timeZone) => edge.setTimeZoneOverride({ timeZone }),
    },
    autoReviewInstructions: {
      get: () => edge.getAutoReviewInstructions(),
      set: (instructions) => edge.setAutoReviewInstructions({ instructions }),
    },
    localToolPermission: {
      get: () => edge.getLocalToolPermission(),
      set: (permission) => edge.setLocalToolPermission({ permission }),
      ceiling: () => edge.getLocalToolPermissionCeiling(),
      async recordApproval(approvalId, action, target) { await edge.recordLocalToolApproval({ approvalId, action, target }); },
      async clearApprovals() { await edge.clearLocalToolApprovals(); },
    },
    theme: {
      get initial() { return initial().themeState; },
      get: () => edge.getThemeState(),
      set: (preference) => edge.setThemePreference({ preference }),
      onChanged: (listener) => edge.subscribe({ "theme-changed": listener }),
    },
    language: {
      get initial() { return { preference: "system", resolved: "en" }; },
      get: () => edge.getLanguageState?.() ?? { preference: "system", resolved: "en" },
      set: (preference) => edge.setLanguagePreference?.({ preference }) ?? Promise.resolve(),
      onChanged: (listener) => edge.subscribe({ "language-changed": listener }),
    },
    botColorInChat: {
      get initial() { return false; },
      get: () => Promise.resolve(edge.getBotColorInChatEnabled?.() ?? false),
      set: (enabled) => edge.setBotColorInChatEnabled?.({ enabled }) ?? Promise.resolve(),
    },
    assistiveTech: {
      get initial() { return false; },
      get: () => Promise.resolve(false),
      onChanged: (listener) => edge.subscribe({ "assistive-tech-changed": (value) => listener(value === true) }),
    },
    secrets: {
      list: () => ipc.invoke("sand:secrets-list"),
      reveal: (key) => ipc.invoke("sand:secrets-reveal", { key }),
      upsert: (entries) => ipc.invoke("sand:secrets-upsert", { entries }),
      remove: (keys) => ipc.invoke("sand:secrets-delete", { keys }),
    },
    agent: {
      getPinnedAgents: () => edge.getHostPinnedAgents(),
      setPinnedAgents: (pinnedAgentIds) => edge.setHostPinnedAgents({ pinnedAgentIds }),
      getSidebarSections: () => edge.getHostSidebarSections(),
      setSidebarSections: (sections) => edge.setHostSidebarSections({ sections }),
      getDefaultModel: () => edge.getAgentDefaultModel(),
      setDefaultModel: (model) => edge.setAgentDefaultModel({ model }),
      getComputerUseModel: () => edge.getComputerUseModel(),
      setComputerUseModel: (model) => edge.setComputerUseModel({ model }),
      getAvailableModels: () => edge.getAvailableModels(),
      getInferenceRouter: () => edge.getInferenceRouter(),
      setInferenceRouter: (provider, extra) => edge.setInferenceRouter({ provider, ...extra }),
      getBoxRuntime: () => edge.getBoxRuntime(),
      setBoxRuntime: (mode) => edge.setBoxRuntime({ mode }),
      setBoxAutoSuspendIdleMs: (idleMs) => edge.setBoxAutoSuspendIdleMs({ idleMs }),
      suspendBox: () => edge.suspendBox(),
      resumeBox: () => edge.resumeBox(),
      getLocalProfile: () => edge.getLocalProfile(),
      async setLocalProfile(profile) {
        const status = await edge.updateLocalProfile(profile ?? {});
        emitEvent("sand-rpc:main:e:cursor-auth-changed", status);
        return status;
      },
      listOpenRouterModels: () => edge.listOpenRouterModels(),
      getDesktopEnvironment: () => edge.getDesktopEnvironment(),
      clientPersistence: {
        read: (key) => ipc.invoke("sand:client-persistence-read", { key }),
        async write(key, value) { await ipc.invoke("sand:client-persistence-write", { key, value }); },
        async remove(key) { await ipc.invoke("sand:client-persistence-remove", { key }); },
        listKeys: (prefix) => ipc.invoke("sand:client-persistence-list-keys", { prefix }),
        migrateFromLocalStorage: (entries) => ipc.invoke("sand:client-persistence-migrate", { entries }),
      },
    },
    update: {
      getStatus: () => edge.getUpdateStatus(),
      check: () => edge.checkForUpdates(),
      setTrack: (track) => edge.setUpdateTrack({ track }),
      async quitAndInstall() { await edge.quitAndInstallUpdate(); },
      setAutoUpdateWhenIdleOptIn: (enabled) => edge.setAutoUpdateWhenIdleOptIn({ enabled }),
      onStatusEvent: (listener) => edge.subscribe({ "update-status": listener }),
    },
    attachProdBox: {
      getStatus: async () => ({ enabled: false }),
      setEnabled: async () => ({ enabled: false }),
    },
  };

  function installTurnDebugOverlay() {
    const buffer = [];
    const limit = 320;
    let open = false;
    let lastEventAt = 0;
    let warningButton = null;
    const root = document.createElement("div");
    root.dataset.testid = "grok-bot-turn-debug";
    root.style.cssText = "display:none;position:fixed;left:10px;bottom:12px;z-index:10002;width:min(560px,calc(100vw - 20px));flex-direction:column;border-radius:10px;overflow:hidden;background:rgba(13,15,12,.95);color:#b7c4b0;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid rgba(214,226,208,.18);box-shadow:0 12px 32px rgba(0,0,0,.4)";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 10px;background:rgba(214,226,208,.06);border-bottom:1px solid rgba(214,226,208,.12)";
    const title = document.createElement("span");
    title.textContent = "live turns";
    title.style.cssText = "font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:10px;color:#d6e2d0";
    const status = document.createElement("span");
    status.style.cssText = "flex:1;opacity:.75;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "clear";
    clearButton.style.cssText = "border:0;background:transparent;color:#8fa286;cursor:pointer;font:inherit;padding:0";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.style.cssText = "border:0;background:transparent;color:#8fa286;cursor:pointer;font:inherit;padding:0 2px";
    head.append(title, status, clearButton, closeButton);
    const feed = document.createElement("div");
    feed.dataset.testid = "grok-bot-turn-debug-feed";
    feed.style.cssText = "overflow:auto;max-height:36vh;padding:8px 10px;white-space:pre-wrap;word-break:break-word";
    function paint(line, tone) {
      const row = document.createElement("div");
      row.textContent = line;
      row.style.color = tone != null ? tone : undefined;
      if (tone === "#ff7070" || tone === "#f5c14e") row.style.fontWeight = "600";
      feed.appendChild(row);
      while (feed.childElementCount > limit) feed.firstElementChild?.remove();
      feed.scrollTop = feed.scrollHeight;
      buffer.push(line);
      if (buffer.length > limit) buffer.shift();
    }
    const LINE_TONES = [
      [/turn-start/, "#7dd88f"],
      [/turn-finish/, "#6fae77"],
      [/turn-supersede/, "#f5c14e"],
      [/turn-stopp?/, "#ff7070"],
      [/turn-timeout|turn-error|Router error|abort/, "#ff7070"],
      [/turn-retry|turn-deadline/, "#f5c14e"],
      [/prompt-part/, "#c792ea"],
      [/tool-start|tool-finish|box-chrome|box-handoff|send-to-agent/, "#66d9ef"],
      [/stream /, "#7f917f"],
    ];
    const toneFor = (line) => LINE_TONES.find(([pattern]) => pattern.test(line))?.[1];
    function noteRoutedLineImpl(payload) {
      const line = typeof payload?.line === "string" ? payload.line : JSON.stringify(payload ?? {});
      const now = Date.now();
      if (lastEventAt !== 0 && now - lastEventAt > 5_000) {
        paint(`${new Date(now).toISOString()} -- gap ${((now - lastEventAt) / 1000).toFixed(1)}s without events --`, "#f5c14e");
      }
      lastEventAt = now;
      paint(line, toneFor(line));
      if (warningButton == null && /turn-timeout|turn-error.*timeout/i.test(line)) {
        warningButton = document.createElement("button");
        warningButton.type = "button";
        warningButton.dataset.testid = "grok-bot-turn-debug-dot";
        warningButton.title = "turn trouble — click for the live feed (Ctrl+Shift+D)";
        warningButton.textContent = "»";
        warningButton.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:10001;width:22px;height:22px;border-radius:50%;border:1px solid rgba(255,112,112,.5);background:rgba(13,15,12,.9);color:#ff7070;cursor:pointer;font:12px/1 monospace";
        warningButton.addEventListener("click", () => { toggle(); warningButton?.remove(); warningButton = null; });
        document.body.appendChild(warningButton);
      }
      renderStatus();
    }
    function renderStatus() {
      if (!open) return;
      const idle = lastEventAt === 0 ? "quiet" : `${((Date.now() - lastEventAt) / 1000).toFixed(0)}s since last event`;
      status.textContent = `${idle} · ${buffer.length} events`;
    }
    function toggle() {
      open = !open;
      root.style.display = open ? "flex" : "none";
      renderStatus();
    }
    clearButton.addEventListener("click", () => { buffer.length = 0; feed.replaceChildren(); renderStatus(); });
    closeButton.addEventListener("click", () => toggle());
    document.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
      if (key !== "d") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }, true);
    setInterval(() => { if (open) renderStatus(); }, 1000);
    const mount = () => { if (document.body != null) { document.body.appendChild(root); if (new URLSearchParams(location.search).has("turndebug")) toggle(); } else { setTimeout(mount, 50); } };
    mount();
    noteRoutedLine = noteRoutedLineImpl;
    window.__grokBotTurnDebug = {
      toggle,
      show: () => { if (!open) toggle(); },
      hide: () => { if (open) toggle(); },
      clear: () => { buffer.length = 0; feed.replaceChildren(); renderStatus(); },
      lines: () => buffer.slice(),
    };
  }

  function installComposerStop() {
    let lastAgentId = "";
    const running = new Set();
    const overlay = document.createElement("button");
    overlay.type = "button";
    overlay.setAttribute("aria-label", "Stop");
    overlay.dataset.testid = "grok-bot-composer-stop";
    overlay.style.cssText = "display:none;position:fixed;z-index:40;margin:0;border:0;border-radius:50%;background:#fff;color:#171914;width:30px;height:30px;padding:0;cursor:pointer";
    overlay.innerHTML = '<span aria-hidden="true" style="display:block;width:10px;height:10px;margin:10px auto;background:#171914;border-radius:2px"></span>';
    function stopNow() {
      const lastSent = lastAgentId;
      const agentId = (lastSent.length > 0 && running.has(lastSent)) ? lastSent : ([...running][0] || lastSent);
      if (!agentId || coordinatorPort == null) return;
      coordinatorPort.postMessage({
        kind: "request",
        requestId: "stop-" + Date.now() + "-" + Math.random().toString(16).slice(2),
        method: "stopRoutedTurn",
        args: { agentId },
      });
    }
    overlay.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      stopNow();
    });
    const mount = () => {
      if (document.body != null && overlay.parentNode == null) document.body.appendChild(overlay);
    };
    if (document.body != null) mount();
    else document.addEventListener("DOMContentLoaded", mount);
    noteRoutedSend = (agentId) => {
      lastAgentId = agentId;
      running.add(agentId);
      paint();
    };
    noteRoutedAgents = (payload) => {
      const agents = payload && Array.isArray(payload.agents) ? payload.agents : [];
      running.clear();
      for (const agent of agents) {
        if (agent && agent.isRunning === true && typeof agent.id === "string") running.add(agent.id);
      }
      if (typeof payload?.activeAgentId === "string" && payload.activeAgentId.length > 0) {
        lastAgentId = payload.activeAgentId;
      }
      paint();
    };
    const post = coordinatorPort.postMessage.bind(coordinatorPort);
    coordinatorPort.postMessage = (data) => {
      try {
        if (data && data.kind === "request" && data.method === "sendPrompt" && data.args && typeof data.args.agentId === "string") {
          lastAgentId = data.args.agentId;
          running.add(lastAgentId);
          paint();
        }
      } catch {}
      return post(data);
    };
    const emit = coordinatorPort._emit.bind(coordinatorPort);
    coordinatorPort._emit = (data) => {
      try {
        if (data && data.kind === "event" && data.family === "routed-log") {
          noteRoutedLine(data.payload);
        }
        if (data && data.kind === "event" && data.family === "agents") {
          const agents = data.payload && Array.isArray(data.payload.agents) ? data.payload.agents : [];
          running.clear();
          for (const agent of agents) {
            if (agent && agent.isRunning === true && typeof agent.id === "string") running.add(agent.id);
          }
          if (typeof data.payload?.activeAgentId === "string" && data.payload.activeAgentId.length > 0) {
            lastAgentId = data.payload.activeAgentId;
          }
          paint();
        }
      } catch {}
      return emit(data);
    };
    function nativeComposerStop() {
      return Array.from(document.querySelectorAll('[aria-label="Stop"]')).find((node) => node !== overlay) ?? null;
    }
    function paint() {
      if (nativeComposerStop() != null) {
        overlay.style.display = "none";
        return;
      }
      const send = document.querySelector('[aria-label="Send message"]')
        || document.querySelector(".sand-prompt-cta-cluster [aria-label=\"Start voice input\"]")
        || document.querySelector(".sand-prompt-actions-trailing button:last-of-type");
      const dictating = document.querySelector('[aria-label="Stop dictation"]') != null;
      const show = running.size > 0 && send != null && !dictating;
      if (!show) {
        overlay.style.display = "none";
        return;
      }
      const box = send.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.left = `${box.left}px`;
      overlay.style.top = `${box.top}px`;
      overlay.style.width = `${Math.max(30, box.width)}px`;
      overlay.style.height = `${Math.max(30, box.height)}px`;
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (running.size === 0 && lastAgentId.length === 0) return;
      if (document.querySelector('[aria-label="Stop dictation"]') != null) return;
      if (nativeComposerStop() != null) return;
      event.preventDefault();
      event.stopPropagation();
      stopNow();
    }, true);
    setInterval(paint, 400);
    new MutationObserver(paint).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label"] });
  }
  installComposerStop();
  installTurnDebugOverlay();

  window.desktop = desktop;
  window.coordinatorPort = {
    claim(consumer) {
      if (owner != null) return null;
      owner = consumer;
      log("coordinator port claimed");
      return {
        request() {
          if (owner !== consumer) return;
          owner.onPort(coordinatorPort);
        },
        release() {
          if (owner !== consumer) return;
          owner = null;
        },
      };
    },
  };
  window.__grokBotDebug = {
    get connection() { return state.connection; },
    get lastError() { return state.lastError; },
    get runtimeHealth() { return state.runtimeHealth; },
    get rpcLog() { return rpcLog.slice(); },
    health: state.health,
    turnDebug: window.__grokBotTurnDebug ?? null,
  };
  probeRuntimeHealth();
  setInterval(probeRuntimeHealth, 2_000);
  installRuntimeHealthNotice();
  installToolSurfaceNotice();
  attachSocket();

  try {
    const bootDeepLink = new URLSearchParams(location.search).get("deeplink");
    if (typeof bootDeepLink === "string" && bootDeepLink.length > 0) {
      window.addEventListener("grok-bot-ws", () => {
        setTimeout(() => emitEvent("deep-link", bootDeepLink), 150);
      }, { once: true });
    }
  } catch {}
})();
