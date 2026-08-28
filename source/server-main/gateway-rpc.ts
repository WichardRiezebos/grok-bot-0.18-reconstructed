import { GATEWAY_API_PREFIX, GATEWAY_AUTH_SCHEME } from "../shared/gateway-wire.js";
import type { RuntimeConfig } from "./config.js";

export async function postGatewayCommand(
  config: RuntimeConfig,
  method: string,
  args: unknown = {},
  timeoutMs = 30_000,
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.gatewayToken.length > 0) headers.authorization = `${GATEWAY_AUTH_SCHEME} ${config.gatewayToken}`;
  const response = await fetch(new URL(`${GATEWAY_API_PREFIX}/${method}`, config.gatewayUrl).toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(args ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`gateway ${method} failed: ${detail}`);
  }
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
