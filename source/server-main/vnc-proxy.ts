import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { SAND_BOX_FORK_NOVNC_PORT, SAND_BOX_PRIMARY_NOVNC_PORT } from "../packages/constants/sand-box.js";

export const VNC_PRIMARY_PREFIX = "/__grok_bot/vnc/primary";
export const VNC_FORK_PREFIX = "/__grok_bot/vnc/fork";

export function vncProxyMatch(pathName: string): { readonly prefix: string; readonly port: number; readonly rest: string } | null {
  if (pathName === VNC_PRIMARY_PREFIX || pathName.startsWith(`${VNC_PRIMARY_PREFIX}/`)) {
    const rest = pathName.slice(VNC_PRIMARY_PREFIX.length);
    return { prefix: VNC_PRIMARY_PREFIX, port: SAND_BOX_PRIMARY_NOVNC_PORT, rest: rest.length > 0 ? rest : "/" };
  }
  if (pathName === VNC_FORK_PREFIX || pathName.startsWith(`${VNC_FORK_PREFIX}/`)) {
    const rest = pathName.slice(VNC_FORK_PREFIX.length);
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
  const target = new URL(match.rest + search, boxVncOrigin(gatewayUrl, match.port));
  const headers = { ...req.headers, host: target.host };
  delete headers["connection"];
  const upstream = httpRequest(target, { method: req.method, headers }, (incoming) => {
    res.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(res);
  });
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
  const target = new URL(match.rest + search, boxVncOrigin(gatewayUrl, match.port));
  const port = Number.parseInt(target.port, 10);
  const upstream = netConnect(port, target.hostname, () => {
    const headerLines = Object.entries(req.headers).flatMap(([key, value]) => {
      if (value == null || key.toLowerCase() === "host") return [];
      const serialized = Array.isArray(value) ? value : [value];
      return serialized.map((item) => `${key}: ${item}`);
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
  upstream.on("error", fail);
  socket.on("error", fail);
}
