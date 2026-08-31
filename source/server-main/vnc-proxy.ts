import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { SAND_BOX_FORK_NOVNC_PORT, SAND_BOX_PRIMARY_NOVNC_PORT } from "../packages/constants/sand-box.js";

export const VNC_PRIMARY_PREFIX = "/__grok_bot/vnc/primary";
export const VNC_FORK_PREFIX = "/__grok_bot/vnc/fork";

const VNC_PROXY_CONNECT_TIMEOUT_MS = 10_000;
const VNC_PROXY_HTTP_IDLE_TIMEOUT_MS = 30_000;
const VNC_PROXY_STRIPPED_HEADERS = new Set(["authorization", "cookie"]);

export function vncProxyMatch(pathName: string): { readonly prefix: string; readonly port: number; readonly rest: string } | null {
  if (pathName === VNC_PRIMARY_PREFIX || pathName.startsWith(`${VNC_PRIMARY_PREFIX}/`)) {
    const rest = pathName.slice(VNC_PRIMARY_PREFIX.length).replace(/\/{2,}/g, "/");
    return { prefix: VNC_PRIMARY_PREFIX, port: SAND_BOX_PRIMARY_NOVNC_PORT, rest: rest.length > 0 ? rest : "/" };
  }
  if (pathName === VNC_FORK_PREFIX || pathName.startsWith(`${VNC_FORK_PREFIX}/`)) {
    const rest = pathName.slice(VNC_FORK_PREFIX.length).replace(/\/{2,}/g, "/");
    return { prefix: VNC_FORK_PREFIX, port: SAND_BOX_FORK_NOVNC_PORT, rest: rest.length > 0 ? rest : "/" };
  }
  return null;
}

export function boxVncOrigin(gatewayUrl: string, port: number): string {
  const gateway = new URL(gatewayUrl);
  return `${gateway.protocol}//${gateway.hostname}:${port}`;
}

export function normalizeRequestUrl(raw: string | undefined): string {
  return (raw ?? "/").replace(/^\/{2,}/, "/");
}

export function rewriteLoopbackVncUrl(src: string, origin = ""): string {
  let parsed: URL;
  try {
    parsed = new URL(src, origin.length > 0 ? origin : "http://127.0.0.1");
  } catch {
    return src;
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const port = Number.parseInt(parsed.port, 10);
  if (!loopback || (port !== SAND_BOX_PRIMARY_NOVNC_PORT && port !== SAND_BOX_FORK_NOVNC_PORT)) return src;
  const prefix = port === SAND_BOX_FORK_NOVNC_PORT ? VNC_FORK_PREFIX : VNC_PRIMARY_PREFIX;
  const rawPath = parsed.searchParams.get("path");
  if (rawPath != null && rawPath.length > 0 && !rawPath.includes("__grok_bot/vnc/")) {
    const rest = rawPath.replace(/^\//, "");
    parsed.searchParams.set("path", `${prefix.replace(/^\//, "")}/${rest}`);
  }
  return `${prefix}${parsed.pathname}${parsed.search}`;
}

export function proxyVncHttp(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayUrl: string,
  match: { readonly port: number; readonly rest: string },
  search: string,
): void {
  const expectedOrigin = boxVncOrigin(gatewayUrl, match.port);
  const target = new URL(match.rest + search, expectedOrigin);
  if (target.origin !== expectedOrigin) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("vnc proxy target rejected");
    return;
  }
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host };
  for (const name of ["connection", ...VNC_PROXY_STRIPPED_HEADERS]) delete headers[name];
  const upstream = httpRequest(target, { method: req.method, headers }, (incoming) => {
    res.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(res);
  });
  upstream.setTimeout(VNC_PROXY_HTTP_IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("vnc proxy upstream timeout")));
  const abortUpstream = () => {
    upstream.destroy();
  };
  res.on("close", abortUpstream);
  req.on("aborted", abortUpstream);
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("vnc proxy failed");
    } else res.end();
  });
  req.pipe(upstream);
}

export function proxyVncUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  gatewayUrl: string,
  match: { readonly port: number; readonly rest: string },
  search: string,
): void {
  const expectedOrigin = boxVncOrigin(gatewayUrl, match.port);
  const target = new URL(match.rest + search, expectedOrigin);
  if (target.origin !== expectedOrigin) {
    try { socket.destroy(); } catch {}
    return;
  }
  const port = Number.parseInt(target.port, 10);
  const upstream = netConnect(port, target.hostname, () => {
    clearTimeout(connectTimer);
    const headerLines = Object.entries(req.headers).flatMap(([key, value]) => {
      const name = key.toLowerCase();
      if (value == null || name === "host" || VNC_PROXY_STRIPPED_HEADERS.has(name)) return [];
      const serialized = Array.isArray(value) ? value : [value];
      return serialized.map((item) => `${name}: ${item}`);
    });
    upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const fail = () => {
    try { socket.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };
  const connectTimer = setTimeout(fail, VNC_PROXY_CONNECT_TIMEOUT_MS);
  connectTimer.unref?.();
  upstream.on("error", () => {
    clearTimeout(connectTimer);
    fail();
  });
  socket.on("error", () => {
    clearTimeout(connectTimer);
    fail();
  });
}
