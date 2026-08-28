import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const COMPOSIO_API_KEY_NAME = "COMPOSIO_API_KEY";
export const COMPOSIO_MCP_SERVER_NAME = "composio";
export const COMPOSIO_MCP_URL = "https://connect.composio.dev/mcp";

const BOX_SECRETS_FILENAME = "box-secrets.json";

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
  const candidates = [
    ...(settingsPath == null ? [] : [join(dirname(settingsPath), BOX_SECRETS_FILENAME), join(dirname(settingsPath), "local-docker-credential", BOX_SECRETS_FILENAME)]),
    join(homedir(), ".grokbot", BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot", "local-docker-credential", BOX_SECRETS_FILENAME),
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

export function composioMcpRuntimeConfig(apiKey: string | undefined): { mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> } {
  if (apiKey == null) return { mcpServers: {} };
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
