const CACHE_CONTROL = { type: "ephemeral" } as const;

export function openRouterModelHonorsCacheControl(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.startsWith("anthropic/") || id.includes("claude");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function withCacheControl(value: unknown): unknown {
  if (typeof value === "string") {
    return [{ type: "text", text: value, cache_control: CACHE_CONTROL }];
  }
  if (Array.isArray(value) && value.length > 0) {
    const last = value.length - 1;
    return value.map((item, index) => {
      const record = asRecord(item);
      return record == null || index !== last ? item : { ...record, cache_control: CACHE_CONTROL };
    });
  }
  const record = asRecord(value);
  return record == null ? value : { ...record, cache_control: CACHE_CONTROL };
}

function isLatestUserTurn(message: Record<string, unknown>, index: number, messages: readonly unknown[]): boolean {
  if (message.role !== "user") return false;
  return !messages.slice(index + 1).some((item) => asRecord(item)?.role === "user");
}

export function injectOpenRouterCacheControlIntoBody(body: unknown, modelId: string): unknown {
  if (typeof body !== "string" || !openRouterModelHonorsCacheControl(modelId)) return body;
  try {
    const parsed: unknown = JSON.parse(body);
    const root = asRecord(parsed);
    if (root == null) return body;
    const next: Record<string, unknown> = { ...root };
    if (typeof next.system === "string" || Array.isArray(next.system)) next.system = withCacheControl(next.system);
    if (Array.isArray(next.tools) && next.tools.length > 0) next.tools = withCacheControl(next.tools);
    next.stream_options = { ...(asRecord(next.stream_options) ?? {}), include_usage: true };
    if (Array.isArray(next.messages)) {
      next.messages = next.messages.map((item, index, messages) => {
        const message = asRecord(item);
        if (message == null) return item;
        if (message.role === "system") return { ...message, content: withCacheControl(message.content) };
        if (isLatestUserTurn(message, index, messages)) return item;
        const laterAssistant = messages.slice(index + 1).some((later) => {
          const role = asRecord(later)?.role;
          return role === "assistant" || role === "tool";
        });
        if ((message.role === "assistant" || message.role === "tool") && !laterAssistant) {
          return { ...message, content: withCacheControl(message.content) };
        }
        return item;
      });
    }
    return JSON.stringify(next);
  } catch {
    return body;
  }
}

export function openRouterCacheUsageFromPayload(payload: unknown): { cacheReadTokens: number; cacheWriteTokens: number; costUsd: number } {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage) ?? root;
  if (usage == null) return { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const details = asRecord(usage.prompt_tokens_details);
  const cacheRead = numberOrZero(usage.cache_read_input_tokens, details?.cached_tokens, usage.cached_tokens);
  const cacheWrite = numberOrZero(usage.cache_creation_input_tokens, details?.cache_write_tokens, usage.cache_write_tokens);
  const costUsd = numberOrZero(usage.cost, usage.total_cost, asRecord(usage.cost_details)?.upstream_inference_cost);
  return { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, costUsd };
}

function numberOrZero(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

export function rewriteOpenRouterFetchBody(body: unknown, effortBody: unknown, modelId: string): unknown {
  const withEffort = effortBody ?? body;
  return injectOpenRouterCacheControlIntoBody(withEffort, modelId);
}
