export const ROUTED_TURN_STOPPED_MESSAGE = "Stopped.";
export const ROUTED_TURN_SUPERSEDED_MESSAGE = "Turn superseded.";

export type RoutedTurnAbortKind = "stop" | "supersede" | "timeout";

export class RoutedTurnAbortError extends Error {
  readonly kind: RoutedTurnAbortKind;

  constructor(kind: RoutedTurnAbortKind, message?: string) {
    super(
      message
        ?? (kind === "stop"
          ? ROUTED_TURN_STOPPED_MESSAGE
          : kind === "supersede"
            ? ROUTED_TURN_SUPERSEDED_MESSAGE
            : "The routed request timed out."),
    );
    this.name = "RoutedTurnAbortError";
    this.kind = kind;
  }
}

export function isRoutedTurnAbortError(error: unknown): error is RoutedTurnAbortError {
  return error instanceof RoutedTurnAbortError;
}

export function routedTurnAbortKind(error: unknown): RoutedTurnAbortKind | undefined {
  if (error instanceof RoutedTurnAbortError) return error.kind;
  const record = typeof error === "object" && error != null ? error as { readonly kind?: unknown; readonly name?: unknown } : null;
  if (record?.name === "RoutedTurnAbortError" && (record.kind === "stop" || record.kind === "supersede" || record.kind === "timeout")) {
    return record.kind;
  }
  return undefined;
}

export function routedAbortErrorFromSignal(signal: AbortSignal | undefined, timeoutFallback: () => Error): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const kind = routedTurnAbortKind(signal?.reason);
  if (kind != null) return new RoutedTurnAbortError(kind);
  return timeoutFallback();
}

// A bare stop command ("stop", "stoppen", "nvm", …) sent while a turn is
// running acts as the hidden stop button: abort the running turn without an
// LLM call. Deliberately narrow — only whole messages, so "stop the video at
// 2min" still reaches the model as a normal prompt.
const ROUTED_STOP_COMMANDS = new Set([
  "stop", "stop it", "stop!", "halt", "cancel", "abort", "nevermind", "never mind", "nvm",
  "stoppen", "annuleer", "breek af", "genoeg",
]);

export function isRoutedStopCommand(prompt: string): boolean {
  return ROUTED_STOP_COMMANDS.has(
    prompt
      .trim()
      .toLowerCase()
      .replace(/[.!?…]+$/u, "")
      .replace(/\s+/gu, " "),
  );
}
