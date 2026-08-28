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
.sand-box-vnc-pool__layer:has(webview[data-grok-bot-vnc-connected="1"]) {
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
    if (next.length > 0) watchAdoptedWebview(el, iframe);
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
    health: async () => {
      const token = new URLSearchParams(location.search).get("token");
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      return fetch(`/health${query}`, { credentials: "same-origin" }).then((r) => r.json());
    },
  };

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

  function sendSocket(payload) {
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
      for (const payload of outbound.splice(0)) socket.send(payload);
      window.dispatchEvent(new Event("grok-bot-ws"));
    });
    socket.addEventListener("error", () => {
      state.connection = "down";
      state.lastError = "websocket error";
      log("websocket error");
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
        log("coordinator restarted; reloading");
        location.reload();
        return;
      }
      state.connection = "reconnecting";
      log("websocket closed; reconnecting");
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
        emitEvent(message.channel, message.payload);
        return;
      }
      if (message.kind === "coordinator" && coordinatorPort != null) coordinatorPort._emit(message.frame);
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
      close() {},
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
    async openExternal(url) { await edge.openExternal({ url }); },
    async openCloudAgent(bcId) { await edge.openCloudAgent({ bcId }); },
    stageAttachmentBytes: (filename, bytes) => edge.stageAttachmentBytes({ filename, bytes }),
    commitStagedAttachments: (paths, filenames) => edge.commitStagedAttachments({ paths, filenames }),
    async discardStagedAttachment(path) { await edge.discardStagedAttachment({ path }); },
    mcp: {
      list: () => ipc.invoke("sand:mcp-list"),
      effectivePlugins: () => ipc.invoke("sand:mcp-effective-plugins"),
      catalog: () => ipc.invoke("sand:mcp-catalog"),
      teamPopularity: () => ipc.invoke("sand:mcp-team-popularity"),
      pluginLogo: (url) => ipc.invoke("sand:mcp-plugin-logo", { url }),
      install: (request) => ipc.invoke("sand:mcp-install", request),
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
    onDevBoxRebuild: (listener) => edge.subscribe({ "dev-box-rebuild": listener }),
    onOpenFeedback: (listener) => edge.subscribe({ "open-feedback": () => listener() }),
    onOpenAbout: (listener) => edge.subscribe({ "open-about": () => listener() }),
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
    get rpcLog() { return rpcLog.slice(); },
    health: state.health,
  };
  attachSocket();
})();
