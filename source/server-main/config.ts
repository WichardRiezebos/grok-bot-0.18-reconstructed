import { homedir } from "node:os";
import { join } from "node:path";

export const CONTROL_PORT_DEFAULT = 8080;
export const COOKIE_NAME = "grok_bot_runtime";
export const APP_VERSION = "0.18.0-reconstructed.1";

function truthy(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export interface RuntimeConfig {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly dataDir: string;
  readonly publicUrl: string;
  readonly accessToken?: string;
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  readonly openRouterKey: string | undefined;
  readonly debug: boolean;
  readonly coordinatorArtifact: string;
  readonly rendererRoot: string | undefined;
  readonly staticRoot: string;
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RuntimeConfig {
  const dataDir = env.GROK_BOT_DATA_DIR?.trim() || join(homedir(), ".grokbot-web");
  const renderer = env.GROK_BOT_RENDERER_ROOT?.trim();
  const staticRoot = env.GROK_BOT_STATIC_ROOT?.trim() || join(cwd, "static");
  const parsedPort = Number.parseInt(env.GROK_BOT_LISTEN_PORT?.trim() || String(CONTROL_PORT_DEFAULT), 10);
  const listenPort = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : CONTROL_PORT_DEFAULT;
  return {
    listenHost: env.GROK_BOT_LISTEN_HOST?.trim() || "0.0.0.0",
    listenPort,
    dataDir,
    publicUrl: env.PUBLIC_URL?.trim() || `http://127.0.0.1:${CONTROL_PORT_DEFAULT}`,
    accessToken: env.RUNTIME_ACCESS_TOKEN?.trim() || env.GROK_BOT_ACCESS_TOKEN?.trim() || undefined,
    gatewayUrl: env.SAND_HOST_GATEWAY_URL?.trim() || "http://box:1340",
    gatewayToken: env.SAND_HOST_GATEWAY_TOKEN?.trim() || env.SAND_GATEWAY_TOKEN?.trim() || "",
    openRouterKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    debug: truthy(env.RUNTIME_DEBUG),
    coordinatorArtifact: env.GROK_BOT_COORDINATOR_ARTIFACT?.trim() || join(cwd, "node-agent-coordinator", "main.cjs"),
    rendererRoot: renderer != null && renderer.length > 0 ? renderer : undefined,
    staticRoot,
  };
}

export function settingsPathFor(dataDir: string): string {
  return join(dataDir, "settings.json");
}

export function secretsPathFor(dataDir: string): string {
  return join(dataDir, "box-secrets.json");
}

export function persistencePathFor(dataDir: string): string {
  return join(dataDir, "client-persistence.json");
}
