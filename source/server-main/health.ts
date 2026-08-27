import { GATEWAY_AUTH_SCHEME, GATEWAY_HEALTH_PATH } from "../shared/gateway-wire.js";
import type { RuntimeConfig } from "./config.js";
import type { DebugState } from "./debug-log.js";
import { DockerUnavailableError } from "./unavailable.js";

export interface BoxHealth {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly isBusy?: boolean;
  readonly error?: string;
}

export async function probeBoxHealth(config: RuntimeConfig, timeoutMs = 2_000): Promise<BoxHealth> {
  const started = Date.now();
  try {
    const headers: Record<string, string> = {};
    if (config.gatewayToken.length > 0) headers.authorization = `${GATEWAY_AUTH_SCHEME} ${config.gatewayToken}`;
    const response = await fetch(new URL(GATEWAY_HEALTH_PATH, config.gatewayUrl).toString(), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, latencyMs, error: `HTTP ${response.status}` };
    let isBusy: boolean | undefined;
    try {
      const body = await response.json() as { isBusy?: unknown };
      if (typeof body.isBusy === "boolean") isBusy = body.isBusy;
    } catch {}
    return { ok: true, latencyMs, ...(isBusy === undefined ? {} : { isBusy }) };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface RuntimeHealth {
  readonly ok: boolean;
  readonly runtime: "docker";
  readonly pid: number;
  readonly uptimeMs: number;
  readonly coordinator: { readonly alive: boolean; readonly pid: number | null; readonly lastExit: number | null };
  readonly box: BoxHealth;
  readonly openRouterConfigured: boolean;
  readonly wsListenerReady: boolean;
}

export async function buildRuntimeHealth(config: RuntimeConfig, debug: DebugState): Promise<RuntimeHealth> {
  const box = await probeBoxHealth(config);
  const coordinatorAlive = debug.coordinatorAlive;
  return {
    ok: coordinatorAlive && box.ok && debug.wsListenerReady,
    runtime: "docker",
    pid: process.pid,
    uptimeMs: Date.now() - debug.startedAtMs,
    coordinator: { alive: coordinatorAlive, pid: debug.coordinatorPid, lastExit: debug.coordinatorLastExit },
    box,
    openRouterConfigured: (config.openRouterKey?.length ?? 0) > 0,
    wsListenerReady: debug.wsListenerReady,
  };
}

export function failureEnvelope(error: unknown): { ok: false; failure: { code: string; detail: string } } {
  if (error instanceof DockerUnavailableError) return { ok: false, failure: { code: error.code, detail: error.message } };
  const detail = error instanceof Error ? error.message : String(error);
  return { ok: false, failure: { code: "docker/handler-failed", detail } };
}
