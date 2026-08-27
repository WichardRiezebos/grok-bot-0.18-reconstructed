export interface LogLine {
  readonly at: string;
  readonly stream: "stdout" | "stderr" | "control";
  readonly text: string;
}

export interface RpcTrace {
  readonly at: string;
  readonly method: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string;
}

export interface StubCall {
  readonly at: string;
  readonly method: string;
  readonly detail: string;
}

export function createRingBuffer<T>(limit: number): { push(item: T): void; snapshot(): T[]; clear(): void } {
  const items: T[] = [];
  return {
    push(item) {
      items.push(item);
      if (items.length > limit) items.splice(0, items.length - limit);
    },
    snapshot() {
      return items.slice();
    },
    clear() {
      items.length = 0;
    },
  };
}

export interface DebugState {
  readonly logs: ReturnType<typeof createRingBuffer<LogLine>>;
  readonly rpc: ReturnType<typeof createRingBuffer<RpcTrace>>;
  readonly stubs: ReturnType<typeof createRingBuffer<StubCall>>;
  wsClients: number;
  lastWsConnectAt: string | null;
  lastWsDisconnectAt: string | null;
  coordinatorAlive: boolean;
  coordinatorPid: number | null;
  coordinatorLastExit: number | null;
  wsListenerReady: boolean;
  startedAtMs: number;
}

export function createDebugState(now = Date.now()): DebugState {
  return {
    logs: createRingBuffer<LogLine>(200),
    rpc: createRingBuffer<RpcTrace>(100),
    stubs: createRingBuffer<StubCall>(100),
    wsClients: 0,
    lastWsConnectAt: null,
    lastWsDisconnectAt: null,
    coordinatorAlive: false,
    coordinatorPid: null,
    coordinatorLastExit: null,
    wsListenerReady: false,
    startedAtMs: now,
  };
}

export function noteLog(state: DebugState, stream: LogLine["stream"], text: string): void {
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length === 0) return;
  for (const line of trimmed.split(/\r?\n/u)) {
    state.logs.push({ at: new Date().toISOString(), stream, text: line.slice(0, 4_000) });
  }
}
