import { createPollingPolicy, realClock, type Clock } from "../../internal/scheduling.js";
import { BOX_IDLE_PROBE_INTERVAL_MS } from "../../shared/box-idle-suspend.js";
import { SAND_BOX_SUSPENDED_BLOCKED_MESSAGE } from "../../shared/gateway-reachability.js";

export class BoxSuspendedError extends Error {
  constructor() {
    super(SAND_BOX_SUSPENDED_BLOCKED_MESSAGE);
    this.name = "BoxSuspendedError";
  }
}

export interface BoxIdleHealthProbe {
  readonly running: boolean;
  readonly ready: boolean;
  readonly isBusy: boolean;
  readonly lastBusyAtMs: number | null;
}

export interface BoxIdleSuspendDeps {
  getIdleMs(): number;
  probe(): Promise<BoxIdleHealthProbe | null>;
  isMigrating(): boolean;
  stop(): Promise<void>;
  start(): Promise<unknown>;
  restartCoordinator(): void;
  clock?: Clock;
  log?(message: string): void;
}

export interface BoxIdleSuspendService {
  isSuspended(): boolean;
  getIdleMs(): number;
  noteActivity(): void;
  noteVncPresence(isPresent: boolean): void;
  noteIdleMsChanged(): void;
  guardConnect<T>(demand: boolean, connect: () => Promise<T>): Promise<T>;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  start(): void;
  dispose(): void;
}

let registered: BoxIdleSuspendService | undefined;

export function registerBoxIdleSuspendService(service: BoxIdleSuspendService | undefined): void {
  registered = service;
}

export function getRegisteredBoxIdleSuspendService(): BoxIdleSuspendService | undefined {
  return registered;
}

export function createBoxIdleSuspendService(deps: BoxIdleSuspendDeps): BoxIdleSuspendService {
  const clock = deps.clock ?? realClock;
  let suspended = false;
  let waking = false;
  let vncPresent = false;
  let lastActivityAtMs = clock.now();
  let chain: Promise<unknown> = Promise.resolve();
  let polling: { dispose(): void } | undefined;
  const abort = new AbortController();

  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const run = chain.then(operation, operation);
    chain = Promise.allSettled([run]);
    return run;
  };

  const enabled = (): boolean => deps.getIdleMs() > 0;

  const noteActivity = (): void => {
    lastActivityAtMs = clock.now();
  };

  const stopPolling = (): void => {
    polling?.dispose();
    polling = undefined;
  };

  const startPolling = (): void => {
    stopPolling();
    if (abort.signal.aborted || !enabled()) return;
    polling = createPollingPolicy(clock, { name: "sand-box-idle-suspend", intervalMs: BOX_IDLE_PROBE_INTERVAL_MS }).start(() => tick(), abort.signal);
  };

  const tick = async (): Promise<void> => {
    if (abort.signal.aborted || suspended || waking || !enabled() || deps.isMigrating() || vncPresent) return;
    const health = await deps.probe();
    if (health == null || !health.running || !health.ready) return;
    if (health.isBusy) return;
    if (health.lastBusyAtMs == null) return;
    const idleMs = deps.getIdleMs();
    const lastUse = Math.max(health.lastBusyAtMs, lastActivityAtMs);
    if (clock.now() - lastUse < idleMs) return;
    deps.log?.("auto-suspend: local Docker VM idle, stopping");
    await suspend();
  };

  const suspend = (): Promise<void> => serialize(async () => {
    if (suspended) return;
    if (deps.isMigrating()) return;
    suspended = true;
    try {
      await deps.stop();
    } catch (error) {
      suspended = false;
      throw error;
    }
  });

  const resume = (): Promise<void> => serialize(async () => {
    suspended = false;
    noteActivity();
    await deps.start();
    deps.restartCoordinator();
  });

  const service: BoxIdleSuspendService = {
    isSuspended: () => suspended,
    getIdleMs: () => deps.getIdleMs(),
    noteActivity,
    noteVncPresence(isPresent) {
      vncPresent = isPresent;
      if (isPresent) noteActivity();
    },
    noteIdleMsChanged() {
      noteActivity();
      if (abort.signal.aborted) return;
      startPolling();
    },
    async guardConnect(demand, connect) {
      if (demand) {
        suspended = false;
        waking = true;
        noteActivity();
        try {
          return await connect();
        } finally {
          waking = false;
        }
      }
      if (suspended) throw new BoxSuspendedError();
      if (enabled()) {
        const health = await deps.probe();
        if (health == null || !health.running) throw new BoxSuspendedError();
      }
      return await connect();
    },
    suspend,
    resume,
    start() {
      lastActivityAtMs = clock.now();
      startPolling();
    },
    dispose() {
      if (abort.signal.aborted) return;
      abort.abort();
      stopPolling();
      if (registered === service) registered = undefined;
    },
  };
  return service;
}
