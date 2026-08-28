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
