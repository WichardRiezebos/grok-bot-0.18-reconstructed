export const DEFAULT_BOX_AUTO_SUSPEND_IDLE_MS = 30 * 60_000;
export const BOX_IDLE_PROBE_INTERVAL_MS = 15_000;
export const BOX_AUTO_SUSPEND_IDLE_PRESETS_MS = [0, 15 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000] as const;

export type BoxAutoSuspendIdleMs = (typeof BOX_AUTO_SUSPEND_IDLE_PRESETS_MS)[number];

export interface GatewayConnectOptions {
  readonly demand?: boolean;
}

export function isBoxAutoSuspendIdleMs(value: unknown): value is BoxAutoSuspendIdleMs {
  return typeof value === "number" && (BOX_AUTO_SUSPEND_IDLE_PRESETS_MS as readonly number[]).includes(value);
}

export function normalizeBoxAutoSuspendIdleMs(value: unknown): BoxAutoSuspendIdleMs {
  if (value === 0) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_BOX_AUTO_SUSPEND_IDLE_MS;
  let closest: BoxAutoSuspendIdleMs = DEFAULT_BOX_AUTO_SUSPEND_IDLE_MS;
  let best = Number.POSITIVE_INFINITY;
  for (const preset of BOX_AUTO_SUSPEND_IDLE_PRESETS_MS) {
    const delta = Math.abs(preset - value);
    if (delta < best) {
      best = delta;
      closest = preset;
    }
  }
  return closest;
}
