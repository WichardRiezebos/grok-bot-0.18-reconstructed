import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import * as Ws from "ws";

import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import {
  COMPOSIO_WEBHOOK_SECRET_NAME,
  composioApiKeyFrom,
  ensureComposioWebhookAndTriggers,
  isPublicComposioWebhookBase,
  parseComposioWebhookPayload,
  verifyComposioWebhookSignature,
} from "../shared/node/composio-mcp.js";
import type { RuntimeConfig } from "./config.js";
import { persistencePathFor, secretsPathFor, settingsPathFor } from "./config.js";
import { forkCoordinator, type CoordinatorSession } from "./coordinator-parent.js";
import type { DebugState } from "./debug-log.js";
import { createDebugState, noteLog } from "./debug-log.js";
import { renderDebugPage, renderFallbackApp } from "./debug-page.js";
import { postGatewayCommand } from "./gateway-rpc.js";
import { probeBoxHealth, buildRuntimeHealth, failureEnvelope } from "./health.js";
import { createRpcDispatcher, initialRendererState } from "./rpc.js";
import { loadSecrets, persistSecrets } from "./secrets-file.js";
import { redactValue } from "./redact.js";
import { normalizeRequestUrl, proxyVncHttp, proxyVncUpgrade, vncProxyMatch } from "./vnc-proxy.js";
import { readAttachmentMediaBytes } from "./web-attachments.js";

interface RuntimeSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "message" | "close", listener: (raw?: Buffer | string) => void): void;
}

function resolveWebSocketServer(mod: unknown): new (options: { noServer?: boolean; server?: ReturnType<typeof createServer>; path?: string; maxPayload?: number }) => {
  on(event: "connection", listener: (socket: RuntimeSocket, req: IncomingMessage) => void): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (socket: RuntimeSocket) => void): void;
  emit(event: "connection", socket: RuntimeSocket, req: IncomingMessage): boolean;
  close(): void;
} {
  const record = mod as { WebSocketServer?: unknown; Server?: unknown; default?: { WebSocketServer?: unknown; Server?: unknown } };
  const candidate = record.WebSocketServer ?? record.Server ?? record.default?.WebSocketServer ?? record.default?.Server;
  if (typeof candidate !== "function") throw new Error("ws WebSocketServer export is unavailable");
  return candidate as new (options: { noServer?: boolean; server?: ReturnType<typeof createServer>; path?: string; maxPayload?: number }) => {
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

function readRequestBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class PayloadTooLargeError extends Error {
  constructor() { super("payload too large"); this.name = "PayloadTooLargeError"; }
}

function stripCrossOrigin(html: string): string {
  return html.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "");
}

function allowSelfFraming(html: string): string {
  return html.replace(
    /(<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*content=")([^"]*)("\s*\/?>)/i,
    (whole, head: string, policy: string, tail: string) => {
      if (!/frame-src/i.test(policy)) return whole;
      return `${head}${policy.replace(/frame-src([^;]*)/i, (_all, sources: string) => sources.includes("'self'") ? `frame-src${sources}` : `frame-src 'self'${sources}`)}${tail}`;
    },
  );
}

function injectRenderer(html: string, debug: boolean): string {
  const tags = `<script src="/__grok_bot/shim.js"></script>${debug ? '<script src="/__grok_bot/overlay.js"></script>' : ""}`;
  const prepared = allowSelfFraming(stripCrossOrigin(html));
  if (prepared.includes("<head>")) return prepared.replace("<head>", `<head>${tags}`);
  const htmlOpen = prepared.match(/<html[^>]*>/i);
  if (htmlOpen != null) return prepared.replace(htmlOpen[0], `${htmlOpen[0]}${tags}`);
  const doctype = prepared.match(/<!doctype html[^>]*>/i);
  if (doctype != null) return prepared.replace(doctype[0], `${doctype[0]}${tags}`);
  return `${tags}${prepared}`;
}

function safeStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
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
    if (previous !== socket) flushOwnerFrameBuffer(socket);
  };
  let restartQueued = false;
  const COORDINATOR_RESTART_BASE_MS = 750;
  const COORDINATOR_RESTART_MAX_MS = 30_000;
  const COORDINATOR_STABLE_MS = 10_000;
  const OWNER_BACKPRESSURE_LIMIT = 4 * 1024 * 1024;
  const OWNER_FRAME_BUFFER_LIMIT = 256;
  const OWNER_FRAME_BUFFER_TTL_MS = 2_000;
  let coordinatorRestartAttempts = 0;
  let ownerFrameBuffer: Array<{ at: number; frame: string }> = [];
  const COORDINATOR_FRAME_BACKLOG_LIMIT = 100;
  const COORDINATOR_FRAME_BACKLOG_TTL_MS = 8_000;
  let coordinatorFrameBacklog: Array<{ at: number; frame: unknown }> = [];
  const flushCoordinatorFrameBacklog = () => {
    const session = coordinator;
    const now2 = Date.now();
    const pending = coordinatorFrameBacklog;
    coordinatorFrameBacklog = [];
    if (session == null || pending.length === 0) return;
    setTimeout(() => {
      for (const entry of pending) {
        if (closing || coordinator !== session) return;
        if (now2 - entry.at > COORDINATOR_FRAME_BACKLOG_TTL_MS) continue;
        try { coordinator.postData(entry.frame); } catch {}
      }
    }, 300).unref?.();
  };
  const forwardCoordinatorFrame = (kind: "coordinator" | "coordinator-main", frame: unknown) => {
    const data = JSON.stringify({ kind, frame });
    const socket = ownerSocket;
    if (socket == null || socket.readyState !== socket.OPEN) {
      if (ownerFrameBuffer.length < OWNER_FRAME_BUFFER_LIMIT) ownerFrameBuffer.push({ at: Date.now(), frame: data });
      return;
    }
    if ((socket.bufferedAmount ?? 0) > OWNER_BACKPRESSURE_LIMIT) return;
    try { socket.send(data); } catch {}
  };
  const flushOwnerFrameBuffer = (socket: RuntimeSocket) => {
    const now = Date.now();
    const pending = ownerFrameBuffer.filter((entry) => now - entry.at <= OWNER_FRAME_BUFFER_TTL_MS);
    ownerFrameBuffer = [];
    for (const entry of pending) {
      if ((socket.bufferedAmount ?? 0) > OWNER_BACKPRESSURE_LIMIT) return;
      try { socket.send(entry.frame); } catch { return; }
    }
  };
  const scheduleCoordinatorRestart = () => {
    coordinatorRestartAttempts += 1;
    const delay = Math.min(COORDINATOR_RESTART_BASE_MS * 2 ** (coordinatorRestartAttempts - 1), COORDINATOR_RESTART_MAX_MS)
      + Math.floor(Math.random() * 250);
    noteLog(debug, "control", `coordinator restart scheduled in ${delay}ms`);
    const generationAtSchedule = coordinatorGeneration;
    setTimeout(() => {
      if (closing || generationAtSchedule !== coordinatorGeneration) return;
      startCoordinator();
    }, delay);
  };
  const startCoordinator = () => {
    const generation = ++coordinatorGeneration;
    try {
      coordinator?.dispose();
      coordinator = undefined;
      ownerSocket = undefined;
      for (const socket of [...sockets]) {
        try { socket.close(1012, "coordinator-restart"); } catch {}
      }
      const session = (options.fork ?? forkCoordinator)(config, debug);
      coordinator = session;
      flushCoordinatorFrameBacklog();
      const stableTimer = setTimeout(() => { coordinatorRestartAttempts = 0; }, COORDINATOR_STABLE_MS);
      stableTimer.unref?.();
      session.onData((frame) => {
        forwardCoordinatorFrame("coordinator", frame);
      });
      session.onMainData((frame) => {
        forwardCoordinatorFrame("coordinator-main", frame);
      });
      session.child.on?.("exit", () => {
        clearTimeout(stableTimer);
        if (closing || generation !== coordinatorGeneration) return;
        noteLog(debug, "control", "coordinator died; restarting");
        scheduleCoordinatorRestart();
      });
    } catch (error) {
      debug.coordinatorAlive = false;
      debug.coordinatorPid = null;
      noteLog(debug, "stderr", `coordinator fork failed: ${String(error)}`);
      scheduleCoordinatorRestart();
    }
  };
  startCoordinator();

  const webhookBase = config.publicUrl.replace(/\/$/u, "");
  const composioKey = composioApiKeyFrom(process.env, loadSecrets(secretsPathFor(config.dataDir)));
  if (composioKey != null && isPublicComposioWebhookBase(webhookBase)) {
    void ensureComposioWebhookAndTriggers({
      apiKey: composioKey,
      webhookUrl: `${webhookBase}/webhooks/composio`,
      persistSecret: (secret) => {
        const current = loadSecrets(secretsPathFor(config.dataDir));
        persistSecrets(secretsPathFor(config.dataDir), { ...current, [COMPOSIO_WEBHOOK_SECRET_NAME]: secret });
      },
    }).catch((error) => {
      noteLog(debug, "control", `composio triggers ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const emit = (event: string, payload: unknown) => {
    const frame = JSON.stringify({ kind: "event", channel: `sand-rpc:main:e:${event}`, payload });
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      try { socket.send(frame); } catch {}
    }
  };

  const dispatchRpc = createRpcDispatcher({
    config,
    debug,
    settings,
    secretsPath: secretsPathFor(config.dataDir),
    persistencePath: persistencePathFor(config.dataDir),
    restartCoordinator: () => { restartQueued = true; },
    emit,
  });
  const flushCoordinatorRestart = () => {
    if (!restartQueued) return;
    restartQueued = false;
    startCoordinator();
  };

  const authorize = (_req: IncomingMessage, _allowLoopbackHealth = false): boolean => true;

  const sessionCookieHeaders = (_req: IncomingMessage): Record<string, string> => ({});

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let url: URL;
    try {
      url = new URL(normalizeRequestUrl(req.url), "http://127.0.0.1");
    } catch {
      return send(res, 400, "bad request");
    }
    const pathName = url.pathname;

    if (req.method === "GET" && pathName === "/health") {
      if (!authorize(req, true)) return send(res, 401, "unauthorized");
      const health = await buildRuntimeHealth(config, debug);
      return sendJson(res, health.ok ? 200 : 503, health);
    }

    if (req.method === "POST" && pathName === "/webhooks/composio") {
      let payload: string;
      try {
        payload = await readRequestBody(req);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          res.writeHead(413, { "content-type": "text/plain; charset=utf-8", "connection": "close", "cache-control": "no-store" });
          res.end("payload too large\n");
          try { req.socket.end(); } catch {}
          return;
        }
        return send(res, 400, "bad request");
      }
      const secrets = loadSecrets(secretsPathFor(config.dataDir));
      const secret = process.env.COMPOSIO_WEBHOOK_SECRET?.trim() || secrets[COMPOSIO_WEBHOOK_SECRET_NAME]?.trim() || "";
      const webhookId = String(req.headers["webhook-id"] ?? "");
      const webhookTimestamp = String(req.headers["webhook-timestamp"] ?? "");
      const signature = String(req.headers["webhook-signature"] ?? "");
      if (secret.length === 0 || webhookId.length === 0 || webhookTimestamp.length === 0 || signature.length === 0
        || !verifyComposioWebhookSignature({ payload, signature, webhookId, webhookTimestamp, secret })) {
        return send(res, 401, "unauthorized");
      }
      const parsed = parseComposioWebhookPayload(payload);
      if (parsed == null) return sendJson(res, 400, { ok: false, error: "invalid payload" });
      try {
        await postGatewayCommand(config, "fireComposioTrigger", {
          triggerSlug: parsed.triggerSlug,
          data: parsed.data,
        });
      } catch (error) {
        noteLog(debug, "control", `composio webhook ${error instanceof Error ? error.message : String(error)}`);
        return sendJson(res, 502, { ok: false });
      }
      return sendJson(res, 200, { ok: true });
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
    if (req.method === "POST" && pathName === "/debug/actions/coordinator-rpc") {
      let body: { method?: unknown; args?: unknown } = {};
      try { body = JSON.parse(await readRequestBody(req)) as typeof body; } catch {}
      const method = typeof body.method === "string" ? body.method : "";
      if (method.length === 0) return sendJson(res, 400, { ok: false, error: "missing method" });
      try {
        const value = await dispatchRpc(`sand-rpc:main:m:${method}`, body.args ?? {});
        return sendJson(res, 200, { ok: true, value: redactValue(value) });
      } catch (error) {
        return sendJson(res, 200, failureEnvelope(error));
      }
    }
    if (req.method === "POST" && pathName === "/debug/actions/open-settings") {
      // Same path the desktop tray uses: the renderer's onOpenSettings
      // subscription opens the settings overlay on this edge event.
      emit("open-settings", {});
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathName === "/media") {
      const filePath = url.searchParams.get("path");
      if (filePath == null || filePath.length === 0) return send(res, 400, "missing path");
      try {
        const chunk = await readAttachmentMediaBytes(config, filePath);
        if (chunk == null) return send(res, 404, "not found");
        res.writeHead(200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
          "cache-control": "private, max-age=60",
        });
        res.end(chunk.bytes);
        return;
      } catch {
        return send(res, 502, "attachment unavailable");
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
          res.end(bytes);
          return;
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
            res.end(readFileSync(target));
            return;
          }
        } catch {}
      }
    }

    return send(res, 404, "not found");
  };

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      noteLog(debug, "stderr", `request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, "internal error");
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  debug.wsListenerReady = true;
  server.on("upgrade", (req, socket, head) => {
    try {
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
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (origin != null && origin.length > 0) {
        try {
          const parsed = new URL(origin);
          const hostHeader = String(req.headers.host ?? "");
          if (parsed.host !== hostHeader) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
        } catch {
          socket.destroy();
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit("connection", client, req);
      });
    } catch {
      try { socket.destroy(); } catch {}
    }
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
    // The 0.36 renderer's computer-rebuild lock can latch `update` in this
    // runtime and hold every send ("Waiting to send…"); the reducer only
    // clears a non-pending update lock on a terminal migration event. Emit a
    // periodic terminal migration marker so a latched lock always resolves.
    // The detail must classify as "busy" (see the renderer's migration-failure
    // parsing): an empty detail would raise the "Update failed" recovery
    // banner even though the computer is fine, while "busy" only surfaces the
    // benign update-refusal state that the next status poll clears.
    const clearRebuildLatch = () => {
      try {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ kind: "event", channel: "box-migration", payload: { phase: "failed", operationId: null, detail: "busy" } }));
        }
      } catch {}
    };
    clearRebuildLatch();
    const rebuildLatchTimer = setInterval(clearRebuildLatch, 30_000);
    socket.on("close", () => clearInterval(rebuildLatchTimer));
    socket.on("message", (raw?: Buffer | string) => {
      void (async () => {
        let message: { kind?: string; id?: string; channel?: string; payload?: unknown; frame?: unknown; text?: string };
        try { message = JSON.parse(String(raw)) as typeof message; }
        catch { return; }
        if (message.kind === "rpc" && typeof message.id === "string" && typeof message.channel === "string") {
          try {
            const value = await dispatchRpc(message.channel, message.payload);
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ kind: "rpc-ok", id: message.id, value }));
          } catch (error) {
            const envelope = failureEnvelope(error);
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ kind: "rpc-err", id: message.id, failure: envelope.failure }));
          } finally {
            flushCoordinatorRestart();
          }
          return;
        }
        if (message.kind === "debug-note" && typeof message.text === "string") {
          noteLog(debug, "stdout", `client-frame ${message.text.slice(0, 200)}`);
          return;
        }
        if (message.kind === "coordinator") {
          claimOwner(socket);
          // A renderer's port client emits a lifecycle-shutdown frame when it
          // breaches its own protocol. With several tabs sharing one
          // coordinator, forwarding that frame would let one stale tab kill
          // the shared coordinator and every in-flight turn with it — the
          // coordinator's lifecycle belongs to the control process here.
          // The hello handshake must still pass through.
          const frameKind = (message.frame as { kind?: string; phase?: string; method?: string } | null)?.kind;
          if (frameKind === "lifecycle") {
            const phase = (message.frame as { phase?: string } | null)?.phase;
            if (phase === "shutdown") {
              noteLog(debug, "control", `dropped client coordinator shutdown frame: ${JSON.stringify(message.frame).slice(0, 200)}`);
              return;
            }
          }
          if (coordinator == null) {
            if (coordinatorFrameBacklog.length < COORDINATOR_FRAME_BACKLOG_LIMIT) coordinatorFrameBacklog.push({ at: Date.now(), frame: message.frame });
            noteLog(debug, "control", `coordinator frame buffered (no session): ${JSON.stringify(message.frame).slice(0, 120)}`);
            return;
          }
          if (frameKind === "request") {
            noteLog(debug, "control", `coordinator request ${String((message.frame as { method?: string }).method)}`);
          }
          try { coordinator.postData(message.frame); }
          catch (error) { noteLog(debug, "control", `coordinator post failed: ${String(error)}`); }
          return;
        }
        if (message.kind === "coordinator-main") {
          claimOwner(socket);
          const mainFrameKind = (message.frame as { kind?: string; phase?: string } | null)?.kind;
          if (mainFrameKind === "lifecycle" && (message.frame as { phase?: string }).phase === "shutdown") {
            noteLog(debug, "control", "dropped client coordinator-main shutdown frame");
            return;
          }
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
      wss.close();
      for (const socket of [...sockets]) {
        try { socket.close(1001, "server-close"); } catch {}
      }
      const WS_CLOSE_GRACE_MS = 2_000;
      const SERVER_CLOSE_GRACE_MS = 5_000;
      setTimeout(() => {
        for (const socket of [...sockets]) {
          try { socket.terminate?.(); } catch {}
        }
      }, WS_CLOSE_GRACE_MS).unref?.();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve();
        };
        const deadline = setTimeout(() => {
          try { server.closeAllConnections(); } catch {}
          finish();
        }, SERVER_CLOSE_GRACE_MS);
        deadline.unref?.();
        server.close((error) => {
          if (error != null) noteLog(debug, "stderr", `server close: ${error instanceof Error ? error.message : String(error)}`);
          finish();
        });
      });
      try { server.closeAllConnections(); } catch {}
    },
  };
}
