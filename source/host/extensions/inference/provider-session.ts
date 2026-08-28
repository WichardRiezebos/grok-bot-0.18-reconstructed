import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { query as queryClaude, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import { resolveClaudeCodeCliPath } from "../../../shared/node/inference-router-local.js";
import { getSandRootDir, SAND_BOX_DATA_ROOT } from "../../host-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT, DEFAULT_OPENROUTER_REASONING_EFFORT, injectOpenRouterReasoningIntoBody, resolveOpenRouterComputerModel, resolveOpenRouterModel, resolveOpenRouterReasoningEffort, type OpenRouterReasoningEffort } from "../../../shared/openrouter-models.js";
import { boundOpenRouterRequestBody } from "../../../shared/openrouter-prompt-budget.js";
import { injectOpenRouterCacheControlIntoBody, openRouterCacheUsageFromPayload } from "../../../shared/openrouter-prompt-cache.js";
import {
  ROUTED_PLUGIN_MAX_STEPS,
  openRouterToolResultContent,
  routedToolsIncludeComputer,
} from "../../../shared/routed-computer-tools.js";
import { BOX_SECRETS_FILENAME, getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";
import { awaitAbortRace, routedStreamEventToolName, routedStreamProgressLine } from "../../../shared/routed-inference-log.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number };
type OpenRouterTurnUsage = { cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;

export const GROK_ROUTER_SYSTEM_PROMPT = [
  "You are Grok Bot, a warm, concise desktop assistant.",
  "You are running inside Grok Bot, not inside Codex CLI or Claude Code.",
  "The tools supplied with this request include Grok Bot's already-connected plugins and accounts, plus Computer for this agent's own box desktop (the live screen in the UI). Use plugins whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it.",
  "You do have a screen you can drive: it is this agent's box desktop. Chrome starts with no visible window. Call box_chrome with the destination URL only if Chrome is not already visible, then use Computer to screenshot, click, type, and scroll. Never claim a page is loaded, searched, or clicked unless the latest Computer screenshot shows that window.",
  "Report only what the latest Computer screenshot actually shows. If the expected page is not visible, say so plainly, wait, and re-screenshot. Do not call box_chrome again for a site that is already open — reopening the homepage wipes search and basket.",
  "The user watches your screen live next to this chat. You cannot attach or show screenshots in chat, so never say you are showing one; when asked to show something, put it on the screen and point them to your screen.",
  "Do not screenshot in a loop. After at most two screenshots, click, type, or navigate, or stop and tell the user what you see.",
  "Cookie banners, GDPR consent, and Accept/Accepteren/Akkoord buttons are yours: click them with Computer. Never request_box_help for a cookie banner, and never ask the user to click one.",
  "Do not announce screenshots, clicks, or waits. Speak only when you are blocked or done.",
  "Do not close the box browser or its windows. If a page looks blank, screenshot again after a short wait instead of quitting Chrome.",
  "When a step needs the user (a login, 2FA, captcha, or payment), hand them the box with request_box_help immediately. Do not keep driving Computer toward checkout. You never see their password or 2FA.",
  "Never ask for an API key for an already-connected plugin. Respond directly to the user in natural language after completing any necessary tool calls.",
].join("\n");

function recordRoutedUsage(provider: RoutedProvider, usage: UsageRecord): void {
  new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(provider, usage);
}

function secretsFromFile(path: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
  const secrets = (parsed as { secrets?: unknown }).secrets;
  if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
  return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function persistedSecrets(): Record<string, string> {
  const candidates = [
    getBoxSecretsStorePath(),
    join(getSandRootDir(), "local-docker-credential", BOX_SECRETS_FILENAME),
    join(SAND_BOX_DATA_ROOT, BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot", BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot", "local-docker-credential", BOX_SECRETS_FILENAME),
    join(homedir(), ".cursor", "sand-dev", BOX_SECRETS_FILENAME),
  ];
  for (const path of candidates) {
    try {
      const secrets = secretsFromFile(path);
      if (Object.keys(secrets).length > 0) return secrets;
    } catch {}
  }
  return {};
}

function openRouterCredential(): string {
  const value = process.env.OPENROUTER_API_KEY?.trim() || persistedSecrets().OPENROUTER_API_KEY?.trim();
  if (value == null || value.length === 0) throw new Error("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.");
  return value;
}

function providerPrompt(messages: readonly ProviderMessage[]): string {
  const rendered = messages.map(message => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
  return `${GROK_ROUTER_SYSTEM_PROMPT}\n\nContinue this Grok Bot conversation.\n\n${rendered}`;
}

function configuredOpenRouterModel(): string {
  try { return resolveOpenRouterModel(new SandSettingsStore(join(getSandRootDir(), "settings.json")).getOpenRouterModel()); }
  catch { return resolveOpenRouterModel(undefined); }
}

function configuredOpenRouterComputerModel(): string {
  try {
    const store = new SandSettingsStore(join(getSandRootDir(), "settings.json"));
    return resolveOpenRouterComputerModel(store.getOpenRouterComputerModel(), store.getOpenRouterModel());
  } catch { return configuredOpenRouterModel(); }
}

function configuredOpenRouterReasoningEffort(computer: boolean): OpenRouterReasoningEffort {
  const fallback = computer ? DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT : DEFAULT_OPENROUTER_REASONING_EFFORT;
  const env = computer ? process.env.SAND_OPENROUTER_COMPUTER_REASONING_EFFORT : process.env.SAND_OPENROUTER_REASONING_EFFORT;
  try {
    const store = new SandSettingsStore(join(getSandRootDir(), "settings.json"));
    const stored = computer ? store.getOpenRouterComputerReasoningEffort() : store.getOpenRouterReasoningEffort();
    return resolveOpenRouterReasoningEffort(stored, fallback, env);
  } catch { return resolveOpenRouterReasoningEffort(undefined, fallback, env); }
}

function openRouterFetch(effort: OpenRouterReasoningEffort, modelId: string, usage: OpenRouterTurnUsage): typeof fetch {
  return async (input, init) => {
    const nextInit = init == null ? init : (() => {
      const reasoned = injectOpenRouterReasoningIntoBody(boundOpenRouterRequestBody(init.body), effort);
      const body = injectOpenRouterCacheControlIntoBody(reasoned, modelId);
      return body === init.body ? init : { ...init, body: body as BodyInit };
    })();
    const response = await fetch(input, nextInit);
    void response.clone().json().then((payload) => {
      const parsed = openRouterCacheUsageFromPayload(payload);
      usage.cacheReadTokens = parsed.cacheReadTokens;
      usage.cacheWriteTokens = parsed.cacheWriteTokens;
      usage.costUsd = parsed.costUsd;
    }).catch(() => undefined);
    if (response.ok) return response;
    const text = await response.text();
    let message = `OpenRouter HTTP ${response.status}`;
    try {
      const parsed: unknown = JSON.parse(text);
      const record = typeof parsed === "object" && parsed != null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      const nested = record?.error;
      if (typeof nested === "string" && nested.trim().length > 0) message = nested.trim();
      else if (typeof nested === "object" && nested != null) {
        const error = nested as Record<string, unknown>;
        if (typeof error.message === "string" && error.message.trim().length > 0) message = error.message.trim();
        const metadata = error.metadata;
        if (typeof metadata === "object" && metadata != null) {
          const raw = (metadata as Record<string, unknown>).raw;
          if (typeof raw === "string" && raw.trim().length > 0) message = `${message}: ${raw.trim()}`;
        }
      }
    } catch {
      if (text.trim().length > 0) message = `${message}: ${text.trim()}`;
    }
    return new Response(JSON.stringify({ error: { message: message.slice(0, 400), type: "openrouter_error" } }), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

function deferred<T>() {
  const resolvers = Promise.withResolvers<T>();
  void resolvers.promise.catch(() => {});
  return resolvers;
}

function response(text: string, id: string, modelId: string) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose };

function codexCredentials(): CodexCredentials {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Codex login credentials must be a private direct regular file.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Loose;
  const accessToken = parsed?.tokens?.access_token;
  const refreshToken = parsed?.tokens?.refresh_token;
  const idToken = parsed?.tokens?.id_token;
  const accountId = parsed?.tokens?.account_id;
  if (parsed?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0 || typeof idToken !== "string" || idToken.length === 0 || typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex is not signed in with ChatGPT. Run `codex login`, then reopen Grok Bot.");
  }
  return { accessToken, refreshToken, idToken, accountId, path, document: parsed };
}

function jwtAudience(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Loose;
    const audience = payload.aud;
    return typeof audience === "string" ? audience : Array.isArray(audience) ? audience.find((value): value is string => typeof value === "string") ?? null : null;
  } catch { return null; }
}

async function refreshCodexCredentials(current: CodexCredentials): Promise<CodexCredentials> {
  const clientId = jwtAudience(current.idToken);
  if (clientId == null) throw new Error("Codex login expired and its refresh identity is invalid. Run `codex login` again.");
  const refresh = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }),
  });
  if (!refresh.ok) throw new Error("Codex login expired and could not be refreshed. Run `codex login` again.");
  const payload = await refresh.json() as Loose;
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) throw new Error("Codex returned an invalid refreshed login. Run `codex login` again.");
  const document = {
    ...current.document,
    tokens: {
      ...current.document.tokens,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
      id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken,
    },
    last_refresh: new Date().toISOString(),
  };
  const temporary = `${current.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, current.path);
  return codexCredentials();
}

let inflightCodexRefresh: Promise<CodexCredentials> | undefined;
function refreshCodexCredentialsSingleFlight(current: CodexCredentials): Promise<CodexCredentials> {
  inflightCodexRefresh ??= refreshCodexCredentials(current).finally(() => { inflightCodexRefresh = undefined; });
  return inflightCodexRefresh;
}

function codexAuthenticatedFetch(initial: CodexCredentials): typeof fetch {
  let credentials = initial;
  return async (input, init) => {
    const perform = () => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("ChatGPT-Account-Id", credentials.accountId);
      return fetch(input, { ...init, headers });
    };
    let result = await perform();
    if (result.status !== 401) return result;
    credentials = await refreshCodexCredentialsSingleFlight(credentials);
    result = await perform();
    return result;
  };
}

function configuredCodexModel(): string {
  const selected = process.env.SAND_CODEX_MODEL?.trim();
  if (selected) return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4";
  } catch { return "gpt-5.4"; }
}

function configuredCodexReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const selected = process.env.SAND_CODEX_REASONING_EFFORT?.trim();
  if (selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh") return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim();
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
  } catch { return undefined; }
}

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = source.inputSchema ?? source.parameters;
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : [];
  });
  return tools.length === 0 ? undefined : tools;
}

function resolvedMaxSteps(toolsPresent: boolean, requested?: number): number {
  if (!toolsPresent) return 1;
  return requested ?? ROUTED_PLUGIN_MAX_STEPS;
}

function codexExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void, maxSteps?: number) {
  const credentials = codexCredentials();
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const tools = codexTools(definitions);
  const fullStream = (async function* () {
    let text = "";
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(configuredCodexReasoningEffort() == null ? {} : { reasoningEffort: configuredCodexReasoningEffort()! }),
        instructions: GROK_ROUTER_SYSTEM_PROMPT,
        input: messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })),
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: resolvedMaxSteps(tools != null, maxSteps),
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        const extended = { ...event.usage, maxTokens: 0 };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve(extended);
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } });
        resultResponse.resolve(response(text, invocationId, model));
      }
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function claudeExecutor(messages: readonly ProviderMessage[], invocationId: string, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string, maxSteps?: number) {
  const executable = resolveClaudeCodeCliPath();
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.");
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const fullStream = (async function* () {
    try {
      let final: SDKResultMessage | undefined;
      const selectedModel = process.env.SAND_CLAUDE_MODEL?.trim();
      for await (const message of queryClaude({ prompt: providerPrompt(messages), options: { pathToClaudeCodeExecutable: executable, cwd: getSandRootDir(), tools: [], ...(mcpServerUrl == null ? {} : { allowedTools: ["mcp__grok_bot_plugins__*"], mcpServers: { grok_bot_plugins: { type: "http" as const, url: mcpServerUrl } }, strictMcpConfig: true }), permissionMode: "default", maxTurns: resolvedMaxSteps(mcpServerUrl != null, maxSteps), persistSession: false, ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }) } })) if (message.type === "result") final = message;
      if (final == null) throw new Error("Claude Code ended without a result.");
      if (final.subtype !== "success") throw new Error(final.errors.join("\n") || `Claude Code failed (${final.subtype}).`);
      const text = final.result;
      if (text.length > 0) yield { type: "text-delta" as const, textDelta: text };
      const input = final.usage.input_tokens, output = final.usage.output_tokens, cacheRead = final.usage.cache_read_input_tokens ?? 0, cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
      onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } });
      resultResponse.resolve(response(text, invocationId, "claude-code"));
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: RoutedToolExecutor): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters;
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
      experimental_toToolResultContent: (result: unknown) => openRouterToolResultContent(result),
    };
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => await executeTool(definition, args, options.toolCallId);
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

function openRouterExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void, abortSignal?: AbortSignal, maxSteps?: number) {
  const computer = routedToolsIncludeComputer(definitions ?? []);
  const id = computer ? configuredOpenRouterComputerModel() : configuredOpenRouterModel();
  const turnUsage: OpenRouterTurnUsage = { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const model: LanguageModelV1 = createOpenAI({ apiKey: openRouterCredential(), baseURL: "https://openrouter.ai/api/v1", compatibility: "compatible", name: "openrouter", headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" }, fetch: openRouterFetch(configuredOpenRouterReasoningEffort(computer), id, turnUsage) }).chat(id as any);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages: messages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxRetries: 0, maxSteps: resolvedMaxSteps(tools !== undefined, maxSteps), ...(abortSignal == null ? {} : { abortSignal }) });
  const extendedUsage = result.usage.then(value => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: turnUsage.cacheReadTokens, cacheWriteTokens: turnUsage.cacheWriteTokens, costUsd: turnUsage.costUsd, maxTokens: 0 }));
  if (onUsage != null) void extendedUsage.then(onUsage, () => undefined);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(_ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[]) {
    if (this.provider === "codex") return codexExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage);
    if (this.provider === "claude-code") return claudeExecutor(this.getMessages(), invocationId, this.onUsage);
    return openRouterExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage);
  }
}

export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  return {
    getModelId: () => provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : configuredOpenRouterModel(),
    getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage)),
  };
}

function routedTurnTimeoutError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("The routed request timed out after 90 seconds.");
}

async function collectRoutedText(
  fullStream: AsyncIterable<{ type: string; textDelta?: string; toolName?: unknown; toolCall?: unknown }>,
  onTextDelta?: (delta: string, accumulated: string) => void,
  abortSignal?: AbortSignal,
  onStreamEvent?: (event: { readonly type: string; readonly toolName?: string; readonly elapsedMs: number }) => void,
  onProgress?: (line: string) => void,
): Promise<string> {
  let text = "";
  const started = Date.now();
  const iterate = (async () => {
    for await (const event of fullStream) {
      if (abortSignal?.aborted) throw routedTurnTimeoutError(abortSignal);
      const toolName = routedStreamEventToolName(event);
      onStreamEvent?.({
        type: event.type,
        ...(toolName == null ? {} : { toolName }),
        elapsedMs: Date.now() - started,
      });
      if (event.type === "error") {
        const failure = (event as { error?: unknown }).error;
        throw failure instanceof Error ? failure : new Error(String(failure ?? "Routed provider stream failed."));
      }
      if (event.type === "text-delta" && typeof event.textDelta === "string") {
        text += event.textDelta;
        onTextDelta?.(event.textDelta, text);
        continue;
      }
      const progress = routedStreamProgressLine(event);
      if (progress != null) onProgress?.(progress);
    }
  })();
  if (abortSignal == null) {
    await iterate;
    return text;
  }
  await awaitAbortRace(iterate, abortSignal, () => routedTurnTimeoutError(abortSignal));
  return text;
}

export async function runRoutedProviderText(provider: RoutedProvider, messages: readonly ProviderMessage[], options?: {
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
  readonly onProgress?: (line: string) => void;
  readonly onStreamEvent?: (event: { readonly type: string; readonly toolName?: string; readonly elapsedMs: number }) => void;
  readonly abortSignal?: AbortSignal;
  readonly maxSteps?: number;
}): Promise<string> {
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage);
  const abortSignal = options?.abortSignal;
  const result = provider === "codex"
    ? codexExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage, options?.maxSteps)
    : provider === "claude-code"
      ? claudeExecutor(messages, invocationId, onUsage, options?.mcpServerUrl, options?.maxSteps)
      : openRouterExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage, abortSignal, options?.maxSteps);
  try {
    const text = await collectRoutedText(result.fullStream, options?.onTextDelta, abortSignal, options?.onStreamEvent, options?.onProgress);
    if (abortSignal?.aborted) throw routedTurnTimeoutError(abortSignal);
    await result.response;
    return text;
  } catch (error) {
    void result.response.catch(() => {});
    void result.usage.catch(() => {});
    void result.extendedUsage.catch(() => {});
    void result.providerMetadata.catch(() => {});
    throw error;
  }
}
