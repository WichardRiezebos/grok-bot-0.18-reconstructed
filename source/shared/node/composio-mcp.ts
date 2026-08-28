import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const COMPOSIO_API_KEY_NAME = "COMPOSIO_API_KEY";
export const COMPOSIO_MCP_SERVER_NAME = "composio";
export const COMPOSIO_MCP_URL = "https://connect.composio.dev/mcp";
export const COMPOSIO_CONNECTED_ACCOUNTS_URL = "https://backend.composio.dev/api/v3/connected_accounts";
export const COMPOSIO_TOOL_ROUTER_SESSION_URL = "https://backend.composio.dev/api/v3.1/tool_router/session";
export const COMPOSIO_TOOLS_URL = "https://backend.composio.dev/api/v3.1/tools";
export const COMPOSIO_TOOL_EXECUTE_URL = "https://backend.composio.dev/api/v3.1/tools/execute";
export const COMPOSIO_WEBHOOK_SUBSCRIPTIONS_URL = "https://backend.composio.dev/api/v3/org/webhooks";
export const COMPOSIO_TRIGGER_INSTANCES_URL = "https://backend.composio.dev/api/v3.1/trigger_instances";
export const COMPOSIO_WEBHOOK_SECRET_NAME = "COMPOSIO_WEBHOOK_SECRET";
export const COMPOSIO_MODEL_TOOL_LIMIT = 32;
export const COMPOSIO_WEBHOOK_TOLERANCE_SECONDS = 300;
export const COMPOSIO_TOOLS_MISSING_MESSAGE = "Composio is saved but tools did not load. Open Plugins → Yours to see the connector, or save the key again in Settings after the computer is running.";
export const DEFAULT_COMPOSIO_TRIGGER_SLUGS: Readonly<Record<string, string>> = { gmail: "GMAIL_NEW_GMAIL_MESSAGE" };
const TOOLKIT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  linear: "Linear",
  github: "GitHub",
  slack: "Slack",
  notion: "Notion",
  googledrive: "Google Drive",
  googlecalendar: "Google Calendar",
  outlook: "Outlook",
};

type ComposioMcpRuntimeConfig = { mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> };

export type ComposioConnectedAccount = { id: string; userId: string; toolkit: string };

export type ComposioToolDefinition = {
  name: string;
  toolName: string;
  providerIdentifier: string;
  description: string;
  inputSchema: Record<string, unknown>;
  toolkit: string;
  connectedAccountId?: string;
  userId?: string;
};

type ComposioMcpExecResult = { result: { case: "success" | "error"; value: unknown } };

const BOX_SECRETS_FILENAME = "box-secrets.json";
const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } as const;
const GMAIL_TOOLKIT = "gmail";

let cachedPlatformSession: { key: string; url: string } | undefined;
let cachedPlatformTools: {
  key: string;
  tools: ComposioToolDefinition[];
  userId: string;
  accounts: Record<string, string>;
} | undefined;
let cachedConnectSession: { key: string; url: string; headers: Record<string, string>; sessionId?: string } | undefined;

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

export function isComposioProjectKey(apiKey: string): boolean {
  return apiKey.startsWith("ak_");
}

export function isComposioServerIdentifier(identifier: string | undefined): boolean {
  if (identifier == null || identifier.length === 0) return false;
  return identifier === COMPOSIO_MCP_SERVER_NAME || identifier.startsWith(`${COMPOSIO_MCP_SERVER_NAME}--`);
}

export function composioServerIdentifierForToolkit(toolkit: string): string {
  const slug = toolkit.trim().toLowerCase();
  return slug.length === 0 || slug === COMPOSIO_MCP_SERVER_NAME
    ? COMPOSIO_MCP_SERVER_NAME
    : `${COMPOSIO_MCP_SERVER_NAME}--${slug}`;
}

export function composioToolkitFromServerIdentifier(identifier: string): string {
  if (identifier.startsWith(`${COMPOSIO_MCP_SERVER_NAME}--`)) {
    return identifier.slice(`${COMPOSIO_MCP_SERVER_NAME}--`.length);
  }
  return COMPOSIO_MCP_SERVER_NAME;
}

export function composioToolkitDisplayName(toolkit: string): string {
  const slug = toolkit.trim().toLowerCase();
  if (slug === COMPOSIO_MCP_SERVER_NAME || slug.length === 0) return "Composio";
  const mapped = TOOLKIT_DISPLAY_NAMES[slug];
  if (mapped != null) return mapped;
  return slug.replace(/(^|[_-])(\w)/gu, (_all, _sep: string, letter: string) => letter.toUpperCase()).replace(/_/gu, " ");
}

export function toolkitSlugFromToolName(name: string): string {
  const prefix = name.split("_", 1)[0]?.toLowerCase() ?? "";
  return prefix.length > 0 ? prefix : COMPOSIO_MCP_SERVER_NAME;
}

export function promptLooksLikeComposioPluginUse(prompt: string): boolean {
  return /\b(gmail|composio|compositos|inbox|e-?mail)\b/iu.test(prompt);
}

export function composioMcpRuntimeConfig(apiKey: string | undefined): ComposioMcpRuntimeConfig {
  if (apiKey == null) return { mcpServers: {} };
  if (isComposioProjectKey(apiKey)) return { mcpServers: {} };
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

function projectKeyRuntimeConfig(apiKey: string, url: string): ComposioMcpRuntimeConfig {
  return {
    mcpServers: {
      [COMPOSIO_MCP_SERVER_NAME]: {
        type: "http",
        url,
        headers: { "x-api-key": apiKey },
      },
    },
  };
}

export async function listComposioConnectedAccounts(apiKey: string): Promise<ComposioConnectedAccount[]> {
  const response = await fetch(COMPOSIO_CONNECTED_ACCOUNTS_URL, { headers: { "x-api-key": apiKey } });
  if (!response.ok) return [];
  const body = await response.json() as {
    items?: Array<{ user_id?: unknown; status?: unknown; id?: unknown; toolkit?: { slug?: unknown } }>;
  };
  const accounts: ComposioConnectedAccount[] = [];
  for (const item of body.items ?? []) {
    if (item.status !== "ACTIVE" || typeof item.id !== "string") continue;
    const slug = item.toolkit?.slug;
    if (typeof slug !== "string" || slug.length === 0) continue;
    accounts.push({
      id: item.id,
      toolkit: slug,
      userId: typeof item.user_id === "string" && item.user_id.length > 0 ? item.user_id : "grok-bot",
    });
  }
  return accounts;
}

export async function resolveComposioMcpRuntimeConfig(apiKey: string | undefined): Promise<ComposioMcpRuntimeConfig> {
  if (apiKey == null) return { mcpServers: {} };
  if (!isComposioProjectKey(apiKey)) return composioMcpRuntimeConfig(apiKey);
  if (cachedPlatformSession?.key === apiKey) return projectKeyRuntimeConfig(apiKey, cachedPlatformSession.url);
  try {
    const accounts = await listComposioConnectedAccounts(apiKey);
    const connectedAccounts: Record<string, string[]> = {};
    let userId = "grok-bot";
    for (const account of accounts) {
      (connectedAccounts[account.toolkit] ??= []).push(account.id);
      userId = account.userId;
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
    const session = sessionResponse.ok
      ? await sessionResponse.json() as { mcp?: { url?: unknown } }
      : undefined;
    const url = typeof session?.mcp?.url === "string" && session.mcp.url.length > 0 ? session.mcp.url : COMPOSIO_TOOLS_URL;
    cachedPlatformSession = { key: apiKey, url };
    return projectKeyRuntimeConfig(apiKey, url);
  } catch {
    return projectKeyRuntimeConfig(apiKey, COMPOSIO_TOOLS_URL);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function inputSchemaFrom(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record == null) return { ...EMPTY_INPUT_SCHEMA };
  if (record.type == null) return { ...EMPTY_INPUT_SCHEMA, ...record, type: "object" };
  return record;
}

export function capComposioModelTools(
  tools: readonly ComposioToolDefinition[],
  limit = COMPOSIO_MODEL_TOOL_LIMIT,
): ComposioToolDefinition[] {
  const gmailRank = (name: string) => {
    if (/FETCH|SEARCH|LIST|GET_PROFILE|SEND/u.test(name)) return 0;
    return 1;
  };
  const rank = (tool: ComposioToolDefinition) => (
    tool.toolkit === GMAIL_TOOLKIT || tool.name.startsWith("GMAIL_") ? gmailRank(tool.name) : 1
  );
  const grouped = new Map<string, ComposioToolDefinition[]>();
  for (const tool of tools) {
    const slug = tool.toolkit.length > 0 ? tool.toolkit : toolkitSlugFromToolName(tool.name);
    const bucket = grouped.get(slug) ?? [];
    bucket.push(tool);
    grouped.set(slug, bucket);
  }
  const toolkits = [...grouped.keys()].sort((left, right) => {
    if (left === GMAIL_TOOLKIT) return -1;
    if (right === GMAIL_TOOLKIT) return 1;
    if (left === COMPOSIO_MCP_SERVER_NAME) return 1;
    if (right === COMPOSIO_MCP_SERVER_NAME) return -1;
    return left.localeCompare(right);
  });
  for (const toolkit of toolkits) {
    grouped.get(toolkit)?.sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name));
  }
  const taken = Object.fromEntries(toolkits.map((toolkit) => [toolkit, 0]));
  const capped: ComposioToolDefinition[] = [];
  while (capped.length < limit && toolkits.some((toolkit) => (taken[toolkit] ?? 0) < (grouped.get(toolkit)?.length ?? 0))) {
    for (const toolkit of toolkits) {
      if (capped.length >= limit) break;
      const bucket = grouped.get(toolkit) ?? [];
      const index = taken[toolkit] ?? 0;
      if (index >= bucket.length) continue;
      capped.push(bucket[index]!);
      taken[toolkit] = index + 1;
    }
  }
  return capped;
}

function toolFromComposioItem(item: Record<string, unknown>, account?: ComposioConnectedAccount): ComposioToolDefinition | undefined {
  const slug = typeof item.slug === "string" ? item.slug : typeof item.name === "string" ? item.name : "";
  if (slug.length === 0) return undefined;
  const toolkitRecord = asRecord(item.toolkit);
  const toolkit = account?.toolkit
    ?? (typeof toolkitRecord?.slug === "string" ? toolkitRecord.slug : slug.split("_", 1)[0]?.toLowerCase() ?? "composio");
  const description = typeof item.description === "string" && item.description.length > 0
    ? item.description
    : typeof item.human_description === "string" ? item.human_description : slug;
  const identifier = composioServerIdentifierForToolkit(toolkit);
  return {
    name: slug,
    toolName: slug,
    providerIdentifier: identifier,
    description,
    inputSchema: inputSchemaFrom(item.input_parameters ?? item.input_schema ?? item.parameters),
    toolkit,
    ...(account == null ? {} : { connectedAccountId: account.id, userId: account.userId }),
  };
}

async function fetchToolkitTools(apiKey: string, toolkit: string, account?: ComposioConnectedAccount): Promise<ComposioToolDefinition[]> {
  const tools: ComposioToolDefinition[] = [];
  const seen = new Set<string>();
  const collect = async (important: boolean) => {
    const url = new URL(COMPOSIO_TOOLS_URL);
    url.searchParams.set("toolkit_slug", toolkit);
    url.searchParams.set("limit", "100");
    if (important) url.searchParams.set("important", "true");
    const response = await fetch(url, { headers: { "x-api-key": apiKey } });
    if (!response.ok) return;
    const body = await response.json() as { items?: unknown[]; tools?: unknown[] };
    const rows = Array.isArray(body.items) ? body.items : Array.isArray(body.tools) ? body.tools : Array.isArray(body) ? body as unknown[] : [];
    for (const row of rows) {
      const record = asRecord(row);
      if (record == null) continue;
      const tool = toolFromComposioItem(record, account);
      if (tool == null || seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
  };
  await collect(true);
  if (tools.length < 8) await collect(false);
  return tools;
}

export async function listComposioPlatformTools(apiKey: string): Promise<ComposioToolDefinition[]> {
  if (cachedPlatformTools?.key === apiKey) return cachedPlatformTools.tools;
  const accounts = await listComposioConnectedAccounts(apiKey);
  const accountByToolkit = Object.fromEntries(accounts.map((account) => [account.toolkit, account.id]));
  const userId = accounts[0]?.userId ?? "grok-bot";
  const toolkits = [...new Set(accounts.map((account) => account.toolkit))];
  if (toolkits.length === 0) toolkits.push(GMAIL_TOOLKIT);
  const collected: ComposioToolDefinition[] = [];
  for (const toolkit of toolkits) {
    const account = accounts.find((entry) => entry.toolkit === toolkit);
    collected.push(...await fetchToolkitTools(apiKey, toolkit, account));
  }
  const tools = capComposioModelTools(collected);
  cachedPlatformTools = { key: apiKey, tools, userId, accounts: accountByToolkit };
  return tools;
}

export async function executeComposioPlatformTool(
  apiKey: string,
  slug: string,
  args: unknown,
): Promise<ComposioMcpExecResult> {
  const tools = cachedPlatformTools?.key === apiKey ? cachedPlatformTools.tools : await listComposioPlatformTools(apiKey);
  const tool = tools.find((entry) => entry.name === slug || entry.toolName === slug);
  const accounts = cachedPlatformTools?.key === apiKey ? cachedPlatformTools.accounts : {};
  const userId = tool?.userId ?? cachedPlatformTools?.userId ?? "grok-bot";
  const connectedAccountId = tool?.connectedAccountId ?? (tool != null ? accounts[tool.toolkit] : undefined);
  const response = await fetch(`${COMPOSIO_TOOL_EXECUTE_URL}/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      arguments: asRecord(args) ?? {},
      user_id: userId,
      ...(connectedAccountId == null ? {} : { connected_account_id: connectedAccountId }),
    }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = text.length === 0 ? {} : JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!response.ok) {
    const record = asRecord(parsed);
    const message = typeof record?.error === "string" ? record.error
      : typeof record?.message === "string" ? record.message
        : `Composio execute failed (${response.status}).`;
    return mcpExecError(message);
  }
  return mcpExecText(typeof parsed === "string" ? parsed : JSON.stringify(parsed));
}

function jsonFromMcpHttpBody(text: string, contentType: string): unknown {
  if (contentType.includes("text/event-stream")) {
    let last: unknown;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data.length === 0 || data === "[DONE]") continue;
      try { last = JSON.parse(data); } catch {}
    }
    return last;
  }
  return text.length === 0 ? {} : JSON.parse(text);
}

async function mcpJsonRpc(
  url: string,
  headers: Record<string, string>,
  method: string,
  params: unknown,
  sessionId?: string,
): Promise<{ result: unknown; sessionId?: string }> {
  const requestHeaders: Record<string, string> = {
    ...headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId != null && sessionId.length > 0) requestHeaders["mcp-session-id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const nextSession = response.headers.get("mcp-session-id") ?? sessionId;
  const payload = jsonFromMcpHttpBody(await response.text(), response.headers.get("content-type") ?? "") as {
    result?: unknown;
    error?: { message?: unknown };
  };
  if (!response.ok) throw new Error(`Connect MCP ${method} failed (${response.status}).`);
  if (payload?.error != null) {
    throw new Error(typeof payload.error.message === "string" ? payload.error.message : `Connect MCP ${method} failed.`);
  }
  return { result: payload?.result, sessionId: nextSession ?? undefined };
}

async function connectMcpSession(apiKey: string): Promise<{ url: string; headers: Record<string, string>; sessionId?: string }> {
  if (cachedConnectSession?.key === apiKey) return cachedConnectSession;
  const config = composioMcpRuntimeConfig(apiKey).mcpServers[COMPOSIO_MCP_SERVER_NAME];
  if (config == null) throw new Error("Composio Connect MCP is not configured.");
  const initialized = await mcpJsonRpc(config.url, config.headers, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "grok-bot", version: "0.18" },
  });
  await mcpJsonRpc(config.url, config.headers, "notifications/initialized", {}, initialized.sessionId).catch(() => undefined);
  cachedConnectSession = { key: apiKey, url: config.url, headers: config.headers, sessionId: initialized.sessionId };
  return cachedConnectSession;
}

export async function listComposioConnectMcpTools(apiKey: string): Promise<ComposioToolDefinition[]> {
  const session = await connectMcpSession(apiKey);
  const listed = await mcpJsonRpc(session.url, session.headers, "tools/list", {}, session.sessionId);
  const record = asRecord(listed.result);
  const rows = Array.isArray(record?.tools) ? record.tools : [];
  const tools: ComposioToolDefinition[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (item == null || typeof item.name !== "string" || item.name.length === 0) continue;
    const toolkit = toolkitSlugFromToolName(item.name);
    tools.push({
      name: item.name,
      toolName: item.name,
      providerIdentifier: composioServerIdentifierForToolkit(toolkit),
      description: typeof item.description === "string" ? item.description : item.name,
      inputSchema: inputSchemaFrom(item.inputSchema),
      toolkit,
    });
  }
  return capComposioModelTools(tools);
}

export async function executeComposioConnectMcpTool(
  apiKey: string,
  name: string,
  args: unknown,
): Promise<ComposioMcpExecResult> {
  const session = await connectMcpSession(apiKey);
  const called = await mcpJsonRpc(session.url, session.headers, "tools/call", {
    name,
    arguments: asRecord(args) ?? {},
  }, session.sessionId);
  return mcpExecText(JSON.stringify(called.result ?? {}));
}

function mcpExecError(message: string): ComposioMcpExecResult {
  return { result: { case: "error", value: { error: message } } };
}

function mcpExecText(text: string): ComposioMcpExecResult {
  return {
    result: {
      case: "success",
      value: {
        content: [{ content: { case: "text", value: { text } } }],
        isError: false,
      },
    },
  };
}

function backendServerFromTools(
  tools: readonly ComposioToolDefinition[],
  status: "connected" | "error",
  statusDetail?: string,
  toolkit = COMPOSIO_MCP_SERVER_NAME,
) {
  const identifier = composioServerIdentifierForToolkit(toolkit);
  return {
    serverIdentifier: identifier,
    rowServerIdentifier: identifier,
    accountLabel: "default",
    toolkit,
    displayName: composioToolkitDisplayName(toolkit),
    status,
    ...(statusDetail == null ? {} : { statusDetail }),
    tools: tools.map((tool) => ({
      name: tool.name,
      toolName: tool.toolName,
      providerIdentifier: composioServerIdentifierForToolkit(tool.toolkit || toolkit),
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function groupToolsByToolkit(tools: readonly ComposioToolDefinition[]): Map<string, ComposioToolDefinition[]> {
  const grouped = new Map<string, ComposioToolDefinition[]>();
  for (const tool of tools) {
    const slug = tool.toolkit.length > 0 ? tool.toolkit : toolkitSlugFromToolName(tool.name);
    const bucket = grouped.get(slug) ?? [];
    bucket.push(tool);
    grouped.set(slug, bucket);
  }
  return grouped;
}

function orderedToolkits(slugs: readonly string[]): string[] {
  return [...slugs].sort((left, right) => {
    if (left === GMAIL_TOOLKIT) return -1;
    if (right === GMAIL_TOOLKIT) return 1;
    if (left === COMPOSIO_MCP_SERVER_NAME) return 1;
    if (right === COMPOSIO_MCP_SERVER_NAME) return -1;
    return left.localeCompare(right);
  });
}

export async function listComposioBackendServers(apiKey: string | undefined): Promise<Array<ReturnType<typeof backendServerFromTools>>> {
  if (apiKey == null) return [backendServerFromTools([], "error", "Composio API key is missing.")];
  try {
    const tools = isComposioProjectKey(apiKey)
      ? await listComposioPlatformTools(apiKey)
      : await listComposioConnectMcpTools(apiKey);
    if (tools.length === 0) return [backendServerFromTools([], "error", COMPOSIO_TOOLS_MISSING_MESSAGE)];
    const grouped = groupToolsByToolkit(tools);
    return orderedToolkits([...grouped.keys()]).map((toolkit) => (
      backendServerFromTools(grouped.get(toolkit) ?? [], "connected", undefined, toolkit)
    ));
  } catch (error) {
    return [backendServerFromTools([], "error", error instanceof Error ? error.message : String(error))];
  }
}

export function isComposioInstalledRow(value: unknown): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const identifier = typeof record.serverIdentifier === "string" ? record.serverIdentifier : "";
  const name = typeof record.name === "string" ? record.name : "";
  return isComposioServerIdentifier(identifier) || name.toLowerCase() === "composio";
}

export function toInstalledComposioServers(
  servers: readonly ReturnType<typeof backendServerFromTools>[],
): Record<string, unknown>[] {
  return servers.map((server, index) => ({
    id: String(index + 1),
    name: server.displayName ?? composioToolkitDisplayName(composioToolkitFromServerIdentifier(server.serverIdentifier)),
    serverIdentifier: server.serverIdentifier,
    accountKey: "default",
    rowServerIdentifier: server.rowServerIdentifier,
    isTeamServer: false,
    status: server.status === "connected" ? "connected" : "error",
    ...(server.statusDetail == null ? {} : { statusDetail: server.statusDetail }),
    transport: "http",
    toolCount: server.tools.length,
    customInstructions: "",
  }));
}

export function toInstalledComposioServerTools(
  servers: readonly ReturnType<typeof backendServerFromTools>[],
): Array<{ name: string; description?: string; isDisabled: boolean }> {
  return servers.flatMap((server) =>
    server.tools.map((tool) => ({
      name: tool.toolName,
      ...(tool.description.length > 0 ? { description: tool.description } : {}),
      isDisabled: false,
    })),
  );
}

export function flattenComposioRoutedTools(
  servers: readonly ReturnType<typeof backendServerFromTools>[],
): Array<{
  name: string;
  providerIdentifier: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return servers.flatMap((server) =>
    server.tools.map((tool) => ({
      name: tool.name,
      providerIdentifier: tool.providerIdentifier.length > 0 ? tool.providerIdentifier : server.serverIdentifier,
      toolName: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  );
}

function nextUnusedId(used: Set<string>, preferred: string): string {
  if (preferred.length > 0 && !used.has(preferred)) return preferred;
  let next = 1;
  while (used.has(String(next))) next += 1;
  return String(next);
}

export function mergeInstalledMcpServers(
  gatewayServers: readonly unknown[],
  localServers: readonly Record<string, unknown>[],
): unknown[] {
  if (localServers.length === 0) return [...gatewayServers];
  const gateway = gatewayServers.filter((row) => !isComposioInstalledRow(row));
  const used = new Set(
    gateway.map((row) => (row != null && typeof row === "object" && "id" in row ? String((row as { id: unknown }).id) : "")),
  );
  const merged = [...gateway];
  for (const local of localServers) {
    const preferred = typeof local.id === "string" ? local.id : "";
    const id = nextUnusedId(used, preferred);
    used.add(id);
    merged.push({ ...local, id });
  }
  return merged;
}

export async function executeComposioBackendTool(
  apiKey: string | undefined,
  args: { readonly name?: string; readonly toolName?: string; readonly args?: unknown },
): Promise<ComposioMcpExecResult> {
  const slug = typeof args.toolName === "string" && args.toolName.length > 0
    ? args.toolName
    : typeof args.name === "string" ? args.name : "";
  if (apiKey == null) return mcpExecError("Composio API key is missing. Add it in Settings → Router.");
  if (slug.length === 0) return mcpExecError("Composio tool name is missing.");
  try {
    return isComposioProjectKey(apiKey)
      ? await executeComposioPlatformTool(apiKey, slug, args.args)
      : await executeComposioConnectMcpTool(apiKey, slug, args.args);
  } catch (error) {
    return mcpExecError(error instanceof Error ? error.message : String(error));
  }
}

export function wrapBackendMcpExecWithComposio(
  inner: Record<string, any>,
  readKey: () => string | undefined = readComposioApiKey,
): Record<string, any> {
  return {
    ...inner,
    async listTools(serverIdentifiers: readonly string[]) {
      const composioIds = serverIdentifiers.filter((id) => isComposioServerIdentifier(id));
      const otherIds = serverIdentifiers.filter((id) => !isComposioServerIdentifier(id));
      const local = composioIds.length === 0 ? [] : await listComposioBackendServers(readKey());
      const filtered = composioIds.includes(COMPOSIO_MCP_SERVER_NAME)
        ? local
        : local.filter((server) => composioIds.includes(server.serverIdentifier));
      const remote = otherIds.length === 0 ? [] : await inner.listTools(otherIds);
      return [...filtered, ...remote];
    },
    async executeTool(args: { serverIdentifier?: string; toolName?: string; name?: string; args?: unknown; toolCallId?: string; agentId?: string }) {
      if (isComposioServerIdentifier(args.serverIdentifier)) {
        return await executeComposioBackendTool(readKey(), args);
      }
      return await inner.executeTool(args);
    },
  };
}

export function isPublicComposioWebhookBase(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function verifyComposioWebhookSignature(args: {
  readonly payload: string;
  readonly signature: string;
  readonly webhookId: string;
  readonly webhookTimestamp: string;
  readonly secret: string;
  readonly nowMs?: number;
}): boolean {
  if (args.secret.length === 0 || args.webhookId.length === 0 || args.webhookTimestamp.length === 0 || args.signature.length === 0) {
    return false;
  }
  const timestamp = Number.parseInt(args.webhookTimestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > COMPOSIO_WEBHOOK_TOLERANCE_SECONDS) return false;
  const digest = createHmac("sha256", args.secret).update(`${args.webhookId}.${args.webhookTimestamp}.${args.payload}`).digest("base64");
  const expected = Buffer.from(digest);
  for (const part of args.signature.split(" ")) {
    const encoded = part.includes(",") ? part.slice(part.indexOf(",") + 1) : part;
    const received = Buffer.from(encoded);
    if (received.length === expected.length && timingSafeEqual(received, expected)) return true;
  }
  return false;
}

export function parseComposioWebhookPayload(payload: string): { triggerSlug: string; data: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record == null) return undefined;
  const metadata = asRecord(record.metadata);
  const triggerSlug = typeof metadata?.trigger_slug === "string" ? metadata.trigger_slug
    : typeof record.triggerSlug === "string" ? record.triggerSlug
      : typeof record.trigger_slug === "string" ? record.trigger_slug
        : "";
  if (triggerSlug.length === 0) return undefined;
  return { triggerSlug, data: record.data ?? record.payload ?? record };
}

export function composioRoutineEvent(triggerSlug: string, data: unknown): Record<string, unknown> {
  return {
    source: "composio",
    triggerSlug,
    ...(data != null && typeof data === "object" && !Array.isArray(data) ? { data } : data != null ? { data } : {}),
  };
}

async function jsonFromComposio(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

async function subscribeComposioWebhook(apiKey: string, webhookUrl: string): Promise<string | undefined> {
  const listed = await fetch(COMPOSIO_WEBHOOK_SUBSCRIPTIONS_URL, { headers: { "x-api-key": apiKey } });
  if (listed.ok) {
    const body = await jsonFromComposio(listed);
    const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.webhooks) ? body.webhooks : [];
    for (const item of items) {
      const record = asRecord(item);
      const url = typeof record?.webhook_url === "string" ? record.webhook_url : typeof record?.url === "string" ? record.url : "";
      const secret = typeof record?.secret === "string" ? record.secret : "";
      if (url === webhookUrl && secret.length > 0) return secret;
    }
  }
  const created = await fetch(COMPOSIO_WEBHOOK_SUBSCRIPTIONS_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ webhook_url: webhookUrl, enabled_events: ["composio.trigger.message"] }),
  });
  if (!created.ok) return undefined;
  const body = await jsonFromComposio(created);
  const secret = typeof body?.secret === "string" ? body.secret : "";
  return secret.length > 0 ? secret : undefined;
}

async function upsertDefaultTriggerInstances(apiKey: string, accounts: readonly ComposioConnectedAccount[]): Promise<void> {
  const existing = await fetch(`${COMPOSIO_TRIGGER_INSTANCES_URL}?limit=100`, { headers: { "x-api-key": apiKey } });
  const existingSlugs = new Set<string>();
  if (existing.ok) {
    const body = await jsonFromComposio(existing);
    const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.triggers) ? body.triggers : [];
    for (const item of items) {
      const record = asRecord(item);
      const slug = typeof record?.trigger_slug === "string" ? record.trigger_slug
        : typeof record?.slug === "string" ? record.slug
          : "";
      const status = typeof record?.status === "string" ? record.status.toUpperCase() : "ACTIVE";
      if (slug.length > 0 && status !== "DISABLED") existingSlugs.add(`${record?.connected_account_id ?? ""}:${slug}`);
    }
  }
  for (const account of accounts) {
    const slug = DEFAULT_COMPOSIO_TRIGGER_SLUGS[account.toolkit];
    if (slug == null) continue;
    if (existingSlugs.has(`${account.id}:${slug}`)) continue;
    await fetch(`${COMPOSIO_TRIGGER_INSTANCES_URL}/${encodeURIComponent(slug)}/upsert`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        connected_account_id: account.id,
        user_id: account.userId,
        trigger_config: {},
      }),
    }).catch(() => undefined);
  }
}

export async function ensureComposioWebhookAndTriggers(args: {
  readonly apiKey: string;
  readonly webhookUrl: string;
  readonly persistSecret?: (secret: string) => void;
}): Promise<{ secret?: string; enabled: boolean }> {
  if (!isComposioProjectKey(args.apiKey) || !isPublicComposioWebhookBase(args.webhookUrl)) {
    return { enabled: false };
  }
  const secret = await subscribeComposioWebhook(args.apiKey, args.webhookUrl);
  if (secret != null && secret.length > 0) args.persistSecret?.(secret);
  const accounts = await listComposioConnectedAccounts(args.apiKey);
  await upsertDefaultTriggerInstances(args.apiKey, accounts);
  return { ...(secret == null ? {} : { secret }), enabled: true };
}

export function resetComposioCachesForTests(): void {
  cachedPlatformSession = undefined;
  cachedPlatformTools = undefined;
  cachedConnectSession = undefined;
}
