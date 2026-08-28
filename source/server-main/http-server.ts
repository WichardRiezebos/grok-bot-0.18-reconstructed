import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import * as Ws from "ws";

import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import type { RuntimeConfig } from "./config.js";
import { persistencePathFor, secretsPathFor, settingsPathFor } from "./config.js";
import { forkCoordinator, type CoordinatorSession } from "./coordinator-parent.js";
import type { DebugState } from "./debug-log.js";
import { createDebugState, noteLog } from "./debug-log.js";
import { renderDebugPage, renderFallbackApp } from "./debug-page.js";
import { probeBoxHealth, buildRuntimeHealth, failureEnvelope } from "./health.js";
import { createRpcDispatcher, initialRendererState } from "./rpc.js";
import { loadSecrets, persistSecrets } from "./secrets-file.js";
import { redactValue } from "./redact.js";
import { normalizeRequestUrl, proxyVncHttp, proxyVncUpgrade, vncProxyMatch } from "./vnc-proxy.js";

interface RuntimeSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close", listener: (raw?: Buffer | string) => void): void;
}

function resolveWebSocketServer(mod: unknown): new (options: { noServer?: boolean; server?: ReturnType<typeof createServer>; path?: string }) => {
  on(event: "connection", listener: (socket: RuntimeSocket, req: IncomingMessage) => void): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (socket: RuntimeSocket) => void): void;
  emit(event: "connection", socket: RuntimeSocket, req: IncomingMessage): boolean;
  close(): void;
} {
  const record = mod as { WebSocketServer?: unknown; Server?: unknown; default?: { WebSocketServer?: unknown; Server?: unknown } };
  const candidate = record.WebSocketServer ?? record.Server ?? record.default?.WebSocketServer ?? record.default?.Server;
  if (typeof candidate !== "function") throw new Error("ws WebSocketServer export is unavailable");
  return candidate as new (options: { noServer?: boolean; server?: ReturnType<typeof createServer>; path?: string }) => {
    on(event: "connection", listener: (socket: RuntimeSocket, req: IncomingMessage) => void): void;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (socket: RuntimeSocket) => void): void;
    emit(event: "connection", socket: RuntimeSocket, req: IncomingMessage): boolean;
    close(): void;
  };
}

const WebSocketServer = resolveWebSocketServer(Ws);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

const BUNDLED_DIR = fileURLToPath(new URL("./", import.meta.url));

function send(res: ServerResponse, status: number, body: string, headers?: Record<string, string>): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string, headers?: Record<string, string>): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${JSON.stringify(body)}\n`);
}

function stripCrossOrigin(html: string): string {
  return html.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "");
}

function injectRenderer(html: string, debug: boolean): string {
  const tags = `<script src="/__grok_bot/shim.js"></script>${debug ? '<script src="/__grok_bot/overlay.js"></script>' : ""}`;
  const prepared = stripCrossOrigin(html);
  if (prepared.includes("<head>")) return prepared.replace("<head>", `<head>${tags}`);
  return `${tags}${prepared}`;
}

function safeStaticPath(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || normalize(rel).startsWith("..")) return null;
  return target;
}

export interface RuntimeServer {
  readonly url: string;
  readonly debug: DebugState;
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export function startRuntimeServer(config: RuntimeConfig, options: { readonly fork?: typeof forkCoordinator } = {}): RuntimeServer {
  mkdirSync(config.dataDir, { recursive: true });
  const debug = createDebugState();
  const settings = new SandSettingsStore(settingsPathFor(config.dataDir));
  if (settings.getInferenceProvider() === "cursor") settings.setInferenceProvider("openrouter");
  if (config.openRouterKey != null) {
    const secrets = loadSecrets(secretsPathFor(config.dataDir));
    if (secrets.OPENROUTER_API_KEY !== config.openRouterKey) {
      persistSecrets(secretsPathFor(config.dataDir), { ...secrets, OPENROUTER_API_KEY: config.openRouterKey });
    }
  }

  let coordinator: CoordinatorSession | undefined;
  let coordinatorGeneration = 0;
  let closing = false;
  const sockets = new Set<RuntimeSocket>();
  let ownerSocket: RuntimeSocket | undefined;
  const claimOwner = (socket: RuntimeSocket) => {
    if (ownerSocket === socket) return;
    const previous = ownerSocket;
    ownerSocket = socket;
    if (previous != null && previous !== socket) {
      noteLog(debug, "control", "coordinator owner superseded");
      try { previous.close(4409, "superseded by another tab"); } catch {}
    }
  };
  const startCoordinator = () => {
    const generation = ++coordinatorGeneration;
    try {
      coordinator?.dispose();
      ownerSocket = undefined;
      for (const socket of [...sockets]) {
        try { socket.close(1012, "coordinator-restart"); } catch {}
      }
      coordinator = (options.fork ?? forkCoordinator)(config, debug);
      coordinator.onData((frame) => {
        if (ownerSocket != null && ownerSocket.readyState === ownerSocket.OPEN) {
          ownerSocket.send(JSON.stringify({ kind: "coordinator", frame }));
        }
      });
      coordinator.onMainData((frame) => {
        if (ownerSocket != null && ownerSocket.readyState === ownerSocket.OPEN) {
          ownerSocket.send(JSON.stringify({ kind: "coordinator-main", frame }));
        }
      });
      coordinator.child.on?.("exit", () => {
        if (closing || generation !== coordinatorGeneration) return;
        noteLog(debug, "control", "coordinator died; restarting");
        setTimeout(() => {
          if (closing || generation !== coordinatorGeneration) return;
          startCoordinator();
        }, 750);
      });
    } catch (error) {
      debug.coordinatorAlive = false;
      debug.coordinatorPid = null;
      noteLog(debug, "stderr", `coordinator fork failed: ${String(error)}`);
    }
  };
  startCoordinator();

  const dispatchRpc = createRpcDispatcher({
    config,
    debug,
    settings,
    secretsPath: secretsPathFor(config.dataDir),
    persistencePath: persistencePathFor(config.dataDir),
    restartCoordinator: startCoordinator,
  });

  const authorize = (_req: IncomingMessage, _allowLoopbackHealth = false): boolean => true;

  const sessionCookieHeaders = (_req: IncomingMessage): Record<string, string> => ({});

  const server = createServer(async (req, res) => {
    const url = new URL(normalizeRequestUrl(req.url), "http://127.0.0.1");
    const pathName = url.pathname;

    if (req.method === "GET" && pathName === "/health") {
      if (!authorize(req, true)) return send(res, 401, "unauthorized");
      return sendJson(res, 200, await buildRuntimeHealth(config, debug));
    }

    if (req.method === "GET" && pathName === "/debug") {
      return sendHtml(res, 200, renderDebugPage(await buildRuntimeHealth(config, debug), debug, config.debug), sessionCookieHeaders(req));
    }
    if (req.method === "POST" && pathName === "/debug/actions/probe-box") {
      return sendJson(res, 200, await probeBoxHealth(config));
    }
    if (req.method === "POST" && pathName === "/debug/actions/ping-rpc") {
      try {
        const value = await dispatchRpc("sand-rpc:main:m:getDesktopEnvironment", {});
        return sendJson(res, 200, { ok: true, value: redactValue(value) });
      } catch (error) {
        return sendJson(res, 200, failureEnvelope(error));
      }
    }

    const vnc = vncProxyMatch(pathName);
    if (vnc != null && (req.method === "GET" || req.method === "HEAD")) {
      return proxyVncHttp(req, res, config.gatewayUrl, vnc, url.search);
    }

    if (req.method === "GET" && (pathName === "/__grok_bot/shim.js" || pathName === "/__grok_bot/overlay.js")) {
      const file = pathName.endsWith("overlay.js") ? "overlay.js" : "web-shim.js";
      for (const root of [config.staticRoot, BUNDLED_DIR]) {
        try {
          const bytes = readFileSync(join(root, file));
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
          return res.end(bytes);
        } catch {}
      }
      return send(res, 404, "missing shim");
    }

    if (req.method === "GET" && (pathName === "/" || pathName === "/index.html")) {
      const cookies = sessionCookieHeaders(req);
      if (config.rendererRoot != null) {
        try {
          const html = readFileSync(join(config.rendererRoot, "index.html"), "utf8");
          return sendHtml(res, 200, injectRenderer(html, config.debug), cookies);
        } catch {}
      }
      return sendHtml(res, 200, renderFallbackApp(config.debug), cookies);
    }

    if (req.method === "GET" && config.rendererRoot != null) {
      const target = safeStaticPath(config.rendererRoot, pathName);
      if (target != null) {
        try {
          const stats = statSync(target);
          if (stats.isFile()) {
            res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "public, max-age=60" });
            return res.end(readFileSync(target));
          }
        } catch {}
      }
    }

    return send(res, 404, "not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  debug.wsListenerReady = true;
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(normalizeRequestUrl(req.url), "http://127.0.0.1");
    const vnc = vncProxyMatch(url.pathname);
    if (vnc != null) {
      if (!authorize(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      proxyVncUpgrade(req, socket, head, config.gatewayUrl, vnc, url.search);
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit("connection", client, req);
    });
  });
  wss.on("connection", (socket, req) => {
    if (!authorize(req)) {
      socket.close(4401, "unauthorized");
      return;
    }
    debug.wsClients += 1;
    debug.lastWsConnectAt = new Date().toISOString();
    sockets.add(socket);
    noteLog(debug, "control", "websocket connected");
    socket.send(JSON.stringify({
      kind: "hello-ok",
      debug: config.debug,
      initialState: initialRendererState(settings),
    }));
    socket.on("message", (raw?: Buffer | string) => {
      void (async () => {
        let message: { kind?: string; id?: string; channel?: string; payload?: unknown; frame?: unknown };
        try { message = JSON.parse(String(raw)) as typeof message; }
        catch { return; }
        if (message.kind === "rpc" && typeof message.id === "string" && typeof message.channel === "string") {
          try {
            const value = await dispatchRpc(message.channel, message.payload);
            socket.send(JSON.stringify({ kind: "rpc-ok", id: message.id, value }));
          } catch (error) {
            const envelope = failureEnvelope(error);
            socket.send(JSON.stringify({ kind: "rpc-err", id: message.id, failure: envelope.failure }));
          }
          return;
        }
        if (message.kind === "coordinator") {
          claimOwner(socket);
          try { coordinator?.postData(message.frame); }
          catch (error) { noteLog(debug, "control", `coordinator post failed: ${String(error)}`); }
          return;
        }
        if (message.kind === "coordinator-main") {
          claimOwner(socket);
          try { coordinator?.postMainData(message.frame); }
          catch (error) { noteLog(debug, "control", `coordinator main-data post failed: ${String(error)}`); }
        }
      })();
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (ownerSocket === socket) ownerSocket = undefined;
      debug.wsClients = Math.max(0, debug.wsClients - 1);
      debug.lastWsDisconnectAt = new Date().toISOString();
    });
  });

  let url = `http://127.0.0.1:${config.listenPort}`;
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, () => {
      const address = server.address();
      const port = typeof address === "object" && address != null ? address.port : config.listenPort;
      const host = config.listenHost === "0.0.0.0" ? "127.0.0.1" : config.listenHost;
      url = `http://${host}:${port}`;
      noteLog(debug, "control", `listening on ${url}`);
      resolve();
    });
  });

  return {
    get url() { return url; },
    debug,
    ready,
    async close() {
      closing = true;
      coordinatorGeneration += 1;
      coordinator?.dispose();
      for (const socket of [...sockets]) {
        try { socket.close(1001, "server-close"); } catch {}
      }
      wss.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error != null ? reject(error) : resolve()));
    },
  };
}
