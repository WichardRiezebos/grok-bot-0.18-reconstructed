import type { PollingPolicy } from "../../../internal/scheduling.js";

// Upstream schedules cron routines cloud-side and delivers fires through
// SandAutomationFireConsumer, which requires a backend token. This
// reconstruction runs without that backend (OpenRouter-only mode), so cron
// routines would never fire anywhere: `shouldScheduleLocally` stays false
// without cloud scheduling evidence and the trigger hub only drives event
// listeners. This scheduler closes that gap the way the upstream sync-failure
// tray already promises ("event routines keep running locally when safe"):
// when no cloud credential exists, due runs are computed locally from the
// store's derived `nextRunAt` (anchored on the persisted `lastRunAt`) and
// delivered through the same `runServerScheduledAutomation` seam the cloud
// consumer uses, so spend guard, background sessions, run history, and
// run-uuid dedup all behave identically.

export const LOCAL_DUE_RUN_INTERVAL_MS = 30_000;

export interface LocalSchedulableAutomation {
  readonly id: string;
  readonly isEnabled: boolean;
  /** Store-derived earliest next cron occurrence; null/undefined when disabled or event-only. */
  readonly nextRunAt?: number | null;
}

export interface LocalSchedulableRow {
  readonly agentId: string;
  readonly automation: LocalSchedulableAutomation;
}

export interface LocalDueFire {
  readonly agentId: string;
  readonly automation: LocalSchedulableAutomation;
  readonly runUuid: string;
  readonly scheduledForMs: number;
  readonly latenessMs: number;
}

export interface LocalDueRunPass {
  readonly atMs: number;
  readonly dueCount: number;
  readonly firedCount: number;
  readonly skippedForCloud: boolean;
  readonly skippedWhileNotReady: boolean;
  readonly lastError?: string;
}

/** One fire per due automation per pass; the runUuid is stable per slot. */
export function collectDueFires(rows: readonly LocalSchedulableRow[], nowMs: number): LocalDueFire[] {
  const due: LocalDueFire[] = [];
  for (const row of rows) {
    const automation = row?.automation;
    if (automation == null || automation.isEnabled !== true) continue;
    const nextRunAt = automation.nextRunAt;
    if (typeof nextRunAt !== "number" || !Number.isFinite(nextRunAt) || nextRunAt > nowMs) continue;
    due.push({
      agentId: row.agentId,
      automation,
      runUuid: `local-${row.agentId}-${automation.id}-${nextRunAt}`,
      scheduledForMs: nextRunAt,
      latenessMs: Math.max(0, nowMs - nextRunAt),
    });
  }
  return due;
}

export interface LocalDueRunSchedulerDeps<TAutomation extends LocalSchedulableAutomation = LocalSchedulableAutomation> {
  readonly polling: PollingPolicy;
  readonly listAutomations: () => Promise<readonly { agentId: string; automation: TAutomation }[]>;
  readonly isReady: () => boolean | Promise<boolean>;
  /** True when the upstream cloud backend owns scheduling; local passes then stand down. */
  readonly hasCloudCredential: () => boolean;
  readonly fire: (args: { agentId: string; automation: TAutomation; runUuid: string; scheduledForMs: number }) => Promise<unknown>;
  readonly onPass?: (pass: LocalDueRunPass) => void;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

export class LocalDueRunScheduler<TAutomation extends LocalSchedulableAutomation = LocalSchedulableAutomation> {
  private timer: { dispose(): void } | null = null;
  private passing = false;
  private stopped = true;
  private lastPass: LocalDueRunPass | null = null;

  constructor(private readonly deps: LocalDueRunSchedulerDeps<TAutomation>) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = this.deps.polling.start(async () => {
      if (this.stopped) return;
      try {
        await this.pass();
      } catch {}
    });
    void this.deps.log?.("[sand:automations] local due-run scheduler started (no cloud backend; cron routines fire locally)");
  }

  stop(): void {
    this.stopped = true;
    this.timer?.dispose();
    this.timer = null;
  }

  async pass(): Promise<void> {
    if (this.passing) return;
    this.passing = true;
    const nowMs = this.deps.now ?? Date.now;
    try {
      if (this.deps.hasCloudCredential()) {
        this.recordPass({ atMs: nowMs(), dueCount: 0, firedCount: 0, skippedForCloud: true, skippedWhileNotReady: false });
        return;
      }
      if (!(await this.deps.isReady())) {
        this.recordPass({ atMs: nowMs(), dueCount: 0, firedCount: 0, skippedForCloud: false, skippedWhileNotReady: true });
        return;
      }
      const rows = await this.deps.listAutomations();
      const due = collectDueFires(rows as readonly LocalSchedulableRow[], nowMs());
      let firedCount = 0;
      let lastError: string | undefined;
      for (const entry of due) {
        try {
          await this.deps.fire({
            agentId: entry.agentId,
            automation: entry.automation as TAutomation,
            runUuid: entry.runUuid,
            scheduledForMs: entry.scheduledForMs,
          });
          firedCount += 1;
          void this.deps.log?.(
            `[sand:automations] local schedule fired "${entry.automation.id}" for agent ${entry.agentId}`
            + ` (scheduled ${new Date(entry.scheduledForMs).toISOString()}, ${Math.round(entry.latenessMs / 1000)}s late)`,
          );
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      this.recordPass({ atMs: nowMs(), dueCount: due.length, firedCount, skippedForCloud: false, skippedWhileNotReady: false, ...(lastError === undefined ? {} : { lastError }) });
    } finally {
      this.passing = false;
    }
  }

  getStatus(): LocalDueRunPass | null {
    return this.lastPass;
  }

  private recordPass(pass: LocalDueRunPass): void {
    this.lastPass = pass;
    this.deps.onPass?.(pass);
  }
}
