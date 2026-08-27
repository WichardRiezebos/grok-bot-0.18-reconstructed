import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  OPENROUTER_CATALOG_TIMEOUT_MS,
  OPENROUTER_MODELS_URL,
  parseOpenRouterCatalog,
  type OpenRouterModelOption,
} from "../openrouter-models.js";

const BOX_SECRETS_FILENAME = "box-secrets.json";

function secretsFromFile(path: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
  const secrets = (parsed as { secrets?: unknown }).secrets;
  if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
  return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function readOpenRouterApiKey(settingsPath?: string): string | undefined {
  const env = process.env.OPENROUTER_API_KEY?.trim();
  if (env != null && env.length > 0) return env;
  const candidates = [
    ...(settingsPath == null ? [] : [join(dirname(settingsPath), BOX_SECRETS_FILENAME), join(dirname(settingsPath), "local-docker-credential", BOX_SECRETS_FILENAME)]),
    join(homedir(), ".grokbot", BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot", "local-docker-credential", BOX_SECRETS_FILENAME),
    join(homedir(), ".cursor", "sand-dev", BOX_SECRETS_FILENAME),
  ];
  for (const path of candidates) {
    try {
      const key = secretsFromFile(path).OPENROUTER_API_KEY?.trim();
      if (key != null && key.length > 0) return key;
    } catch {}
  }
  return undefined;
}

export async function fetchOpenRouterCatalog(args?: {
  readonly apiKey?: string;
  readonly currentId?: string | readonly string[];
  readonly fetchImpl?: typeof fetch;
}): Promise<OpenRouterModelOption[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = args?.apiKey?.trim();
  if (apiKey != null && apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;
  const response = await (args?.fetchImpl ?? fetch)(OPENROUTER_MODELS_URL, {
    headers,
    signal: AbortSignal.timeout(OPENROUTER_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenRouter models request failed (${response.status}).`);
  return parseOpenRouterCatalog(await response.json(), args?.currentId);
}
