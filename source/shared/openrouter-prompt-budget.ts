export const OPENROUTER_PROMPT_KEEP_RECENT_IMAGES = 3;
export const OPENROUTER_PROMPT_CHAR_BUDGET = 1_200_000;
export const OPENROUTER_PROMPT_REMOVED_IMAGE_TEXT = "[older screenshot removed]";
export const OPENROUTER_PROMPT_TRUNCATED_TEXT_MARKER = "\n[truncated]";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isImagePart(value: unknown): boolean {
  const record = asRecord(value);
  if (record == null) return false;
  const type = record.type;
  if (type === "image" || type === "image_url" || type === "input_image") return true;
  if (record.image_url != null) return true;
  if (typeof record.mimeType === "string" && typeof record.data === "string" && record.data.length > 0) return true;
  if (typeof record.image === "string" && (record.image.startsWith("data:") || record.image.length > 256)) return true;
  return false;
}

function textPart(text: string): Record<string, unknown> {
  return { type: "text", text };
}

function messageRole(message: unknown): string {
  const role = asRecord(message)?.role;
  return typeof role === "string" ? role : "";
}

function isSystemMessage(message: unknown): boolean {
  return messageRole(message) === "system";
}

function isToolMessage(message: unknown): boolean {
  const role = messageRole(message);
  return role === "tool" || role === "function";
}

function serializedSize(messages: readonly unknown[], extra: unknown): number {
  return JSON.stringify({ messages, extra }).length;
}

function pruneImages(messages: readonly unknown[], keepRecent: number): unknown[] {
  const locations: Array<{ messageIndex: number; partIndex: number }> = [];
  const contents: Array<unknown[] | null> = messages.map((message) => {
    const content = asRecord(message)?.content;
    if (Array.isArray(content)) return content;
    if (isImagePart(content)) return [content];
    return null;
  });
  for (let messageIndex = 0; messageIndex < contents.length; messageIndex++) {
    const parts = contents[messageIndex];
    if (parts == null) continue;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      if (isImagePart(parts[partIndex])) locations.push({ messageIndex, partIndex });
    }
  }
  const kept = new Set(
    locations.slice(-Math.max(0, keepRecent)).map((location) => `${location.messageIndex}:${location.partIndex}`),
  );
  return messages.map((message, messageIndex) => {
    const parts = contents[messageIndex];
    if (parts == null) return message;
    const record = asRecord(message);
    if (record == null) return message;
    return {
      ...record,
      content: parts.map((part, partIndex) => (
        isImagePart(part) && !kept.has(`${messageIndex}:${partIndex}`)
          ? textPart(OPENROUTER_PROMPT_REMOVED_IMAGE_TEXT)
          : part
      )),
    };
  });
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const room = Math.max(0, limit - OPENROUTER_PROMPT_TRUNCATED_TEXT_MARKER.length);
  return `${value.slice(0, room)}${OPENROUTER_PROMPT_TRUNCATED_TEXT_MARKER}`;
}

function truncateToolMessage(message: unknown, limit: number): unknown {
  const record = asRecord(message);
  if (record == null || !isToolMessage(message)) return message;
  if (typeof record.content === "string") {
    return { ...record, content: truncateText(record.content, limit) };
  }
  if (!Array.isArray(record.content)) return message;
  return {
    ...record,
    content: record.content.map((part) => {
      const item = asRecord(part);
      if (item == null || typeof item.text !== "string") return part;
      return { ...item, text: truncateText(item.text, limit) };
    }),
  };
}

function hasToolCalls(message: unknown): boolean {
  const record = asRecord(message);
  if (record == null) return false;
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
  if (Array.isArray(record.content) && record.content.some((part) => {
    const item = asRecord(part);
    return item?.type === "tool-call" || item?.type === "tool_call";
  })) return true;
  return false;
}

function dropOldestNonSystem(messages: readonly unknown[]): unknown[] | null {
  if (messages.length <= 1) return null;
  const index = messages.findIndex((message, offset) => offset < messages.length - 1 && !isSystemMessage(message));
  if (index < 0) return null;
  let start = index;
  let end = index + 1;
  if (isToolMessage(messages[index])) {
    let previous = index - 1;
    while (previous >= 0 && isSystemMessage(messages[previous])) previous -= 1;
    if (previous >= 0 && (hasToolCalls(messages[previous]) || messageRole(messages[previous]) === "assistant")) start = previous;
  }
  if (hasToolCalls(messages[start]) || messageRole(messages[start]) === "assistant") {
    while (end < messages.length - 1 && isToolMessage(messages[end])) end += 1;
  }
  return [...messages.slice(0, start), ...messages.slice(end)];
}

function enforceCharBudget(messages: readonly unknown[], extra: unknown, budget: number, keepRecentImages: number): unknown[] {
  let next = [...messages];
  for (;;) {
    if (serializedSize(next, extra) <= budget) return next;
    const dropped = dropOldestNonSystem(next);
    if (dropped == null) break;
    next = dropped;
  }
  if (serializedSize(next, extra) <= budget) return next;
  for (const limit of [8_000, 400]) {
    next = next.map((message) => truncateToolMessage(message, limit));
    if (serializedSize(next, extra) <= budget) return next;
  }
  if (keepRecentImages > 1) return pruneImages(next, 1);
  return next;
}

export function boundOpenRouterMessages(
  messages: readonly unknown[],
  options?: {
    readonly keepRecentImages?: number;
    readonly charBudget?: number;
    readonly extra?: unknown;
  },
): unknown[] {
  const keepRecentImages = options?.keepRecentImages ?? OPENROUTER_PROMPT_KEEP_RECENT_IMAGES;
  const charBudget = options?.charBudget ?? OPENROUTER_PROMPT_CHAR_BUDGET;
  const pruned = pruneImages(messages, keepRecentImages);
  return enforceCharBudget(pruned, options?.extra, charBudget, keepRecentImages);
}

export function boundOpenRouterRequestBody(
  body: unknown,
  options?: {
    readonly keepRecentImages?: number;
    readonly charBudget?: number;
  },
): unknown {
  if (typeof body !== "string") return body;
  try {
    const parsed: unknown = JSON.parse(body);
    const record = asRecord(parsed);
    if (record == null || !Array.isArray(record.messages)) return body;
    const { messages: _old, ...rest } = record;
    const messages = boundOpenRouterMessages(record.messages, {
      ...(options ?? {}),
      extra: rest,
    });
    return JSON.stringify({ ...record, messages });
  } catch {
    return body;
  }
}
