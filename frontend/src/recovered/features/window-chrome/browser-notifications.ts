import {
  SandOsNotificationDecider,
  buildNotificationContent,
  toNotificationSnapshot,
  type NotificationAgent,
  type NotificationTransition
} from "../../../../../source/shared/os-notification";

export interface BrowserNotificationPort {
  onclick: ((this: Notification, ev: Event) => void) | null;
  onclose: ((this: Notification, ev: Event) => void) | null;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBrowserNotificationRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  return !/Electron/i.test(navigator.userAgent);
}

export function isBrowserNotificationSupported(): boolean {
  return typeof Notification === "function";
}

export async function ensureBrowserNotificationPermission(): Promise<void> {
  if (!isBrowserNotificationRuntime()) return;
  if (!isBrowserNotificationSupported()) {
    throw new Error("Browser notifications are not supported in this context.");
  }
  if (Notification.permission === "granted") return;
  if (Notification.permission === "denied") {
    throw new Error("Browser notifications are blocked. Allow them in the site settings.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Browser notifications were not allowed.");
  }
}

function awaitingFromRoster(value: unknown): NotificationAgent["awaitingUserResponse"] {
  if (value == null) return null;
  if (isRecord(value)) {
    return { reason: typeof value.reason === "string" ? value.reason : "" };
  }
  return { reason: "" };
}

export function toNotificationAgentFromRoster(value: unknown): NotificationAgent | null {
  const nested = isRecord(value) && isRecord(value.agent) ? value.agent : value;
  if (!isRecord(nested) || typeof nested.id !== "string" || nested.id.length === 0) return null;
  return {
    id: nested.id,
    name: typeof nested.name === "string" ? nested.name : "",
    isRunning: nested.isRunning === true,
    awaitingUserResponse: awaitingFromRoster(nested.awaitingUserResponse),
    notifyOnUpdatesEnabled: nested.notifyOnUpdatesEnabled === true,
    isHiddenFromSidebar: nested.isHiddenFromSidebar === true || nested.hiddenFromSidebar === true || nested.isHidden === true,
    ...(typeof nested.lastMessageId === "string" || nested.lastMessageId === null ? { lastMessageId: nested.lastMessageId } : {}),
    lastMessagePreview: typeof nested.lastMessagePreview === "string" ? nested.lastMessagePreview : null
  };
}

export function toNotificationAgentsFromRoster(value: unknown): NotificationAgent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(toNotificationAgentFromRoster)
    .filter((agent): agent is NotificationAgent => agent != null);
}

export class SandBrowserNotificationManager {
  private decider = new SandOsNotificationDecider();
  private readonly active = new Set<BrowserNotificationPort>();
  private hasSeededBaseline = false;
  private preSeedDeltas: NotificationAgent[] = [];

  constructor(private readonly deps: {
    readonly isSupported: () => boolean;
    readonly isPermissionGranted: () => boolean;
    readonly isWindowFocused: () => boolean;
    readonly createNotification: (options: { readonly title: string; readonly body: string; readonly silent: boolean }) => BrowserNotificationPort;
    readonly openAgent: (agentId: string) => void;
    readonly now?: () => number;
  }) {}

  handleAgentsEvent(agents: readonly NotificationAgent[]): void {
    if (!this.deps.isSupported()) return;
    if (!this.hasSeededBaseline) {
      this.seedBaseline(agents);
      return;
    }
    const nowMs = (this.deps.now ?? Date.now)();
    const transitions = this.decider.decide({
      agents: agents.map(toNotificationSnapshot),
      isWindowFocused: !this.deps.isPermissionGranted() || this.deps.isWindowFocused(),
      nowMs
    });
    for (const transition of transitions) this.show(transition);
  }

  handleAgentUpsertedEvent(agent: NotificationAgent): void {
    if (!this.hasSeededBaseline) {
      this.preSeedDeltas.push(agent);
      return;
    }
    const snapshot = toNotificationSnapshot(agent);
    if (!this.deps.isSupported() || !this.deps.isPermissionGranted()) {
      this.decider.observeAgent(snapshot);
      return;
    }
    const nowMs = (this.deps.now ?? Date.now)();
    for (const transition of this.decider.decideAgent(snapshot, { isWindowFocused: this.deps.isWindowFocused(), nowMs })) {
      this.show(transition);
    }
  }

  seedBaseline(agents: readonly NotificationAgent[]): void {
    this.decider.seedBaseline(agents.map(toNotificationSnapshot));
    this.flushPreSeedDeltas();
  }

  reset(): void {
    this.decider = new SandOsNotificationDecider();
    this.hasSeededBaseline = false;
    this.preSeedDeltas = [];
    for (const notification of this.active) notification.close();
    this.active.clear();
  }

  private flushPreSeedDeltas(): void {
    if (this.hasSeededBaseline) return;
    this.hasSeededBaseline = true;
    const buffered = this.preSeedDeltas;
    this.preSeedDeltas = [];
    for (const agent of buffered) this.handleAgentUpsertedEvent(agent);
  }

  private show(transition: NotificationTransition): void {
    if (!this.deps.isPermissionGranted()) return;
    const { title, body } = buildNotificationContent(transition);
    try {
      const notification = this.deps.createNotification({ title, body, silent: transition.kind === "agent-done" });
      notification.onclick = () => {
        this.deps.openAgent(transition.agentId);
        notification.close();
      };
      notification.onclose = () => {
        this.active.delete(notification);
      };
      this.active.add(notification);
    } catch {
      // Constructor can throw if permission flipped or the browser rejects the options.
    }
  }
}
