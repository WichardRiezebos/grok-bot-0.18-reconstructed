/**
 * Fetch wrapper that bounds only connection establishment (time-to-response-headers).
 * Once headers arrive the timer is cleared, so streaming bodies (SSE, downloads) are
 * never cut short; caller-provided abort signals keep controlling the whole request.
 */
export async function fetchWithConnectTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  connectTimeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else if (externalSignal != null) externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Connecting timed out", "TimeoutError")), connectTimeoutMs);
  timer.unref?.();
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
