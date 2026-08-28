import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const COMPOSIO_API_KEY_NAME = "COMPOSIO_API_KEY";
export const COMPOSIO_MCP_SERVER_NAME = "composio";
export const COMPOSIO_MCP_URL = "https://connect.composio.dev/mcp";
export const COMPOSIO_CONNECTED_ACCOUNTS_URL = "https://backend.composio.dev/api/v3/connected_accounts";
export const COMPOSIO_TOOL_ROUTER_SESSION_URL = "https://backend.composio.dev/api/v3.1/tool_router/session";

type ComposioMcpRuntimeConfig = { mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> };

const BOX_SECRETS_FILENAME = "box-secrets.json";
let cachedPlatformSession: { key: string; url: string } | undefined;

function secretsFromFile(path: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
  const secrets = (parsed as { secrets?: unknown }).secrets;
  if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
  return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function readComposioApiKey(settingsPath?: string): string | undefined {
  const env = composioApiKeyFrom();
  if (env != null) return env;
  const dataDirs = [process.env.GROK_BOT_DATA_DIR, process.env.SAND_DATA_ROOT]
    .map((value) => value?.trim())
    .filter((value): value is string => value != null && value.length > 0);
  const candidates = [
    ...(settingsPath == null ? [] : [join(dirname(settingsPath), BOX_SECRETS_FILENAME), join(dirname(settingsPath), "local-docker-credential", BOX_SECRETS_FILENAME)]),
    ...dataDirs.map((dir) => join(dir, BOX_SECRETS_FILENAME)),
    join("/home/box/sand-data", BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot", BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot", "local-docker-credential", BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot-web", BOX_SECRETS_FILENAME),
    join(homedir(), ".cursor", "sand-dev", BOX_SECRETS_FILENAME),
  ];
  for (const path of candidates) {
    try {
      const key = secretsFromFile(path).COMPOSIO_API_KEY?.trim();
      if (key != null && key.length > 0) return key;
    } catch {}
  }
  return undefined;
}

export function composioApiKeyFrom(env: NodeJS.ProcessEnv = process.env, secrets: Readonly<Record<string, string>> = {}): string | undefined {
  const value = env.COMPOSIO_API_KEY?.trim() || secrets.COMPOSIO_API_KEY?.trim();
  return value != null && value.length > 0 ? value : undefined;
}

export function composioMcpRuntimeConfig(apiKey: string | undefined): ComposioMcpRuntimeConfig {
  if (apiKey == null) return { mcpServers: {} };
  if (apiKey.startsWith("ak_")) return { mcpServers: {} };
  return {
    mcpServers: {
      [COMPOSIO_MCP_SERVER_NAME]: {
        type: "http",
        url: COMPOSIO_MCP_URL,
        headers: { "x-consumer-api-key": apiKey },
      },
    },
  };
}

export async function resolveComposioMcpRuntimeConfig(apiKey: string | undefined): Promise<ComposioMcpRuntimeConfig> {
  if (apiKey == null) return { mcpServers: {} };
  if (!apiKey.startsWith("ak_")) return composioMcpRuntimeConfig(apiKey);
  if (cachedPlatformSession?.key === apiKey) {
    return {
      mcpServers: {
        [COMPOSIO_MCP_SERVER_NAME]: {
          type: "http",
          url: cachedPlatformSession.url,
          headers: { "x-api-key": apiKey },
        },
      },
    };
  }
  try {
    const accountsResponse = await fetch(COMPOSIO_CONNECTED_ACCOUNTS_URL, { headers: { "x-api-key": apiKey } });
    let userId = "grok-bot";
    const connectedAccounts: Record<string, string[]> = {};
    if (accountsResponse.ok) {
      const body = await accountsResponse.json() as {
        items?: Array<{ user_id?: unknown; status?: unknown; id?: unknown; toolkit?: { slug?: unknown } }>;
      };
      for (const item of body.items ?? []) {
        if (item.status !== "ACTIVE" || typeof item.id !== "string") continue;
        const slug = item.toolkit?.slug;
        if (typeof slug !== "string" || slug.length === 0) continue;
        (connectedAccounts[slug] ??= []).push(item.id);
        if (typeof item.user_id === "string" && item.user_id.length > 0) userId = item.user_id;
      }
    }
    const sessionResponse = await fetch(COMPOSIO_TOOL_ROUTER_SESSION_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        workbench: { enable: false },
        ...(Object.keys(connectedAccounts).length === 0 ? {} : { connected_accounts: connectedAccounts }),
      }),
    });
    if (!sessionResponse.ok) return { mcpServers: {} };
    const session = await sessionResponse.json() as { mcp?: { url?: unknown } };
    const url = session.mcp?.url;
    if (typeof url !== "string" || url.length === 0) return { mcpServers: {} };
    cachedPlatformSession = { key: apiKey, url };
    return {
      mcpServers: {
        [COMPOSIO_MCP_SERVER_NAME]: {
          type: "http",
          url,
          headers: { "x-api-key": apiKey },
        },
      },
    };
  } catch {
    return { mcpServers: {} };
  }
}
