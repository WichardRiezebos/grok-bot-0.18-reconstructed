import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { COOKIE_NAME } from "./config.js";

export function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header == null || header.length === 0) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return undefined;
}

export function extractAccessToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }
  const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
  if (cookie != null && cookie.length > 0) return cookie;
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query = url.searchParams.get("token")?.trim();
    if (query != null && query.length > 0) return query;
  } catch {}
  return undefined;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === ":1" || address === "::ffff:127.0.0.1";
}

export function cookieHeader(token: string, secure: boolean): string {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
