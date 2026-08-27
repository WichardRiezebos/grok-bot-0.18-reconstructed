import { appendFileSync } from "node:fs";
import { join } from "node:path";

export const ROUTED_INFERENCE_LOG_FILENAME = "routed-inference.log";

export function routedInferenceLogPath(dataDir: string): string {
  return join(dataDir, ROUTED_INFERENCE_LOG_FILENAME);
}

export function formatRoutedInferenceLogLine(message: string, at = new Date()): string {
  return `${at.toISOString()} ${message.replaceAll("\n", " ")}\n`;
}

export function isRoutedInferenceLogLine(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u.test(text.trimStart());
}

export async function awaitAbortRace<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutError: () => Error,
): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw timeoutError();
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(timeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } catch (error) {
    void work.catch(() => undefined);
    throw error;
  } finally {
    if (onAbort != null) signal.removeEventListener("abort", onAbort);
  }
}

export function appendRoutedInferenceLog(dataDir: string, message: string, at = new Date()): void {
  const line = formatRoutedInferenceLogLine(message, at);
  try { appendFileSync(routedInferenceLogPath(dataDir), line); } catch { /* log must never break a turn */ }
  try { process.stderr.write(line); } catch { /* ignore */ }
}

export function routedStreamEventToolName(event: {
  readonly type: string;
  readonly toolName?: unknown;
  readonly toolCall?: unknown;
}): string | undefined {
  if (typeof event.toolName === "string" && event.toolName.length > 0) return event.toolName;
  const call = event.toolCall;
  if (typeof call === "object" && call != null && "toolName" in call && typeof (call as { toolName?: unknown }).toolName === "string") {
    return (call as { toolName: string }).toolName;
  }
  return undefined;
}

export function routedStreamProgressLine(event: {
  readonly type: string;
  readonly toolName?: unknown;
  readonly toolCall?: unknown;
}): string | undefined {
  const toolName = routedStreamEventToolName(event);
  if (event.type === "tool-call" || event.type === "tool-call-streaming-start") {
    return toolName == null ? "Using a tool…" : `Using ${toolName}…`;
  }
  if (event.type === "reasoning" || event.type === "reasoning-delta") return "Thinking…";
  return undefined;
}

function routedProviderErrorPieces(error: unknown, depth = 0): string[] {
  if (depth > 5 || error == null) return [];
  if (typeof error === "string") return error.trim().length === 0 ? [] : [error.trim()];
  if (error instanceof Error) {
    const extra = error as Error & { cause?: unknown; data?: unknown; responseBody?: unknown; errors?: unknown; statusCode?: unknown };
    return [
      extra.message,
      ...(typeof extra.statusCode === "number" ? [`HTTP ${extra.statusCode}`] : []),
      ...routedProviderErrorPieces(extra.cause, depth + 1),
      ...routedProviderErrorPieces(extra.responseBody, depth + 1),
      ...routedProviderErrorPieces(extra.data, depth + 1),
      ...(Array.isArray(extra.errors) ? extra.errors.flatMap((nested) => routedProviderErrorPieces(nested, depth + 1)) : []),
    ];
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const nested = record.error;
    return [
      ...routedProviderErrorPieces(typeof record.message === "string" ? record.message : undefined, depth + 1),
      ...routedProviderErrorPieces(typeof nested === "string" ? nested : nested, depth + 1),
      ...routedProviderErrorPieces(record.metadata, depth + 1),
    ];
  }
  return [String(error)];
}

export function routedRouterErrorText(error: unknown): string {
  const unique = [...new Set(routedProviderErrorPieces(error).map((part) => part.replaceAll("\n", " ").trim()).filter((part) => part.length > 0))];
  return `Router error: ${(unique.join(" — ") || "unknown provider error").slice(0, 500)}`;
}

export function routedSettledAssistantContent(visibleText: string, error: unknown): string {
  const routed = routedRouterErrorText(error);
  const trimmed = visibleText.trim();
  return trimmed.length === 0 ? routed : `${trimmed}\n\n${routed}`;
}

function routedErrorCorpus(error: unknown): string {
  return routedProviderErrorPieces(error).join(" ").toLowerCase();
}

export function isRoutedTransientProviderError(error: unknown): boolean {
  if (error instanceof Error) {
    const status = (error as Error & { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  }
  const text = routedErrorCorpus(error);
  if (/\b(429|502|503|504)\b/.test(text)) return true;
  return /\b(econnreset|etimedout|enotfound|eai_again|socket|network|overloaded|rate.?limit|fetch failed|terminated)\b/.test(text);
}

export function isRoutedPromptOverflowError(error: unknown): boolean {
  const text = routedErrorCorpus(error);
  return /maximum prompt length|context length|prompt is too long|too many tokens/.test(text);
}
