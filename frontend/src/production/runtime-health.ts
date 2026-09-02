export interface RuntimeHealthSnapshot {
  readonly ok: boolean;
  readonly coordinator: { readonly alive: boolean };
  readonly box: { readonly ok: boolean };
  readonly wsListenerReady: boolean;
}

export const UNKNOWN_RUNTIME_HEALTH: RuntimeHealthSnapshot = {
  ok: false,
  coordinator: { alive: false },
  box: { ok: false },
  wsListenerReady: false,
};

export const ASSUMED_HEALTHY_RUNTIME_HEALTH: RuntimeHealthSnapshot = {
  ok: true,
  coordinator: { alive: true },
  box: { ok: true },
  wsListenerReady: true,
};

export interface RuntimeHealthStore {
  get(): RuntimeHealthSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

function parseRuntimeHealth(value: unknown): RuntimeHealthSnapshot | null {
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  const coordinator = record.coordinator;
  const box = record.box;
  if (typeof record.ok !== "boolean") return null;
  if (typeof coordinator !== "object" || coordinator == null || typeof (coordinator as { alive?: unknown }).alive !== "boolean") return null;
  if (typeof box !== "object" || box == null || typeof (box as { ok?: unknown }).ok !== "boolean") return null;
  if (typeof record.wsListenerReady !== "boolean") return null;
  return {
    ok: record.ok,
    coordinator: { alive: (coordinator as { alive: boolean }).alive },
    box: { ok: (box as { ok: boolean }).ok },
    wsListenerReady: record.wsListenerReady,
  };
}

export function createRuntimeHealthStore(options: {
  poll?: () => Promise<unknown>;
  intervalMs?: number;
  initial?: RuntimeHealthSnapshot;
}): RuntimeHealthStore {
  if (options.poll == null) {
    const snapshot = options.initial ?? ASSUMED_HEALTHY_RUNTIME_HEALTH;
    return {
      get: () => snapshot,
      subscribe: () => () => {},
      dispose: () => {},
    };
  }

  const poll = options.poll;
  const intervalMs = options.intervalMs ?? 2_000;
  let snapshot = options.initial ?? UNKNOWN_RUNTIME_HEALTH;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => { for (const listener of [...listeners]) listener(); };
  const setSnapshot = (next: RuntimeHealthSnapshot) => {
    if (disposed) return;
    if (snapshot.ok === next.ok
      && snapshot.coordinator.alive === next.coordinator.alive
      && snapshot.box.ok === next.box.ok
      && snapshot.wsListenerReady === next.wsListenerReady) return;
    snapshot = next;
    notify();
  };
  const probe = () => {
    void poll().then((value) => {
      const parsed = parseRuntimeHealth(value);
      if (parsed != null) setSnapshot(parsed);
    }, () => {});
  };

  probe();
  timer = setInterval(probe, intervalMs);

  return {
    get: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer != null) clearInterval(timer);
      timer = null;
      listeners.clear();
    },
  };
}

declare global {
  interface Window {
    __grokBotDebug?: {
      health?: () => Promise<unknown>;
    };
  }
}

export function isWebRuntimeHealthProbeAvailable(windowValue: Window): boolean {
  return typeof windowValue.__grokBotDebug?.health === "function";
}

export function pollRuntimeHealthFromLocation(locationValue: Pick<Location, "search">): () => Promise<unknown> {
  return () => {
    const token = new URLSearchParams(locationValue.search).get("token");
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    return fetch(`/health${query}`, { credentials: "same-origin" }).then((response) => response.json());
  };
}

export function projectWindowTransportState(input: {
  transport: "browser" | "connecting" | "connected" | "down";
  health: RuntimeHealthSnapshot;
}): "browser" | "connecting" | "connected" | "down" | "reconnecting" | "unhealthy" {
  if (input.transport === "browser") return "browser";
  if (!input.health.coordinator.alive || !input.health.ok) {
    return input.transport === "connected" ? "unhealthy" : "reconnecting";
  }
  return input.transport;
}
