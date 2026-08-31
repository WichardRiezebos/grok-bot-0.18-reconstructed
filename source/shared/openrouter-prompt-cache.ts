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

export function applyOpenRouterCacheControl(root: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...root };
  const systemMarked = typeof next.system === "string" || Array.isArray(next.system);
  if (systemMarked) next.system = withCacheControl(next.system);
  const toolsMarked = Array.isArray(next.tools) && next.tools.length > 0;
  if (toolsMarked) next.tools = withCacheControl(next.tools);
  if (Array.isArray(next.messages)) {
    const messages = next.messages;
    let latestUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (asRecord(messages[index])?.role === "user") { latestUserIndex = index; break; }
    }
    let latestAssistantOrToolIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      const role = asRecord(messages[index])?.role;
      if (role === "assistant" || role === "tool") { latestAssistantOrToolIndex = index; break; }
    }
    let markersRemaining = 4 - (systemMarked ? 1 : 0) - (toolsMarked ? 1 : 0);
    next.messages = messages.map((item, index) => {
      const message = asRecord(item);
      if (message == null) return item;
      if (message.role === "system") {
        if (markersRemaining <= 0) return item;
        markersRemaining -= 1;
        return { ...message, content: withCacheControl(message.content) };
      }
      if (index === latestUserIndex) return item;
      if ((message.role === "assistant" || message.role === "tool") && index === latestAssistantOrToolIndex) {
        if (markersRemaining <= 0) return item;
        markersRemaining -= 1;
        return { ...message, content: withCacheControl(message.content) };
      }
      return item;
    });
  }
  return next;
}

export function injectOpenRouterCacheControlIntoBody(body: unknown, modelId: string): unknown {
  if (typeof body !== "string" || !openRouterModelHonorsCacheControl(modelId)) return body;
  try {
    const parsed: unknown = JSON.parse(body);
    const root = asRecord(parsed);
    if (root == null) return body;
    return JSON.stringify(applyOpenRouterCacheControl(root));
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

export function injectOpenRouterStreamUsageIntoBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    const parsed: unknown = JSON.parse(body);
    const root = asRecord(parsed);
    if (root == null) return body;
    return JSON.stringify(applyOpenRouterStreamUsage(root));
  } catch {
    return body;
  }
}

export function applyOpenRouterStreamUsage(root: Record<string, unknown>): Record<string, unknown> {
  return {
    ...root,
    stream_options: { ...(asRecord(root.stream_options) ?? {}), include_usage: true },
  };
}

export function applyOpenRouterSseUsage(chunk: string, usage: { cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    if (!payload.includes("usage") && !payload.includes("cost") && !payload.includes("cached")) continue;
    try {
      const parsed = openRouterCacheUsageFromPayload(JSON.parse(payload) as unknown);
      if (parsed.cacheReadTokens > usage.cacheReadTokens) usage.cacheReadTokens = parsed.cacheReadTokens;
      if (parsed.cacheWriteTokens > usage.cacheWriteTokens) usage.cacheWriteTokens = parsed.cacheWriteTokens;
      if (parsed.costUsd > usage.costUsd) usage.costUsd = parsed.costUsd;
    } catch {}
  }
}

export function observeOpenRouterSseUsage(
  response: Response,
  usage: { cacheReadTokens: number; cacheWriteTokens: number; costUsd: number },
): Response {
  if (response.body == null) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (value != null) {
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) applyOpenRouterSseUsage(event, usage);
        controller.enqueue(value);
      }
      if (done) {
        buffer += decoder.decode();
        if (buffer.length > 0) applyOpenRouterSseUsage(buffer, usage);
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function numberOrZero(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

export function rewriteOpenRouterFetchBody(body: unknown, effortBody: unknown, modelId: string): unknown {
  const withEffort = effortBody ?? body;
  return injectOpenRouterStreamUsageIntoBody(injectOpenRouterCacheControlIntoBody(withEffort, modelId));
}
