import type { SandInferenceRouterUsage, SandInferenceRouterUsageProvider } from "./inference-router.js";

export const OPENROUTER_ACTIVITY_URL = "https://openrouter.ai/activity";

export function openRouterCostCents(usage: SandInferenceRouterUsageProvider | undefined): number {
  if (usage == null) return 0;
  const recorded = usage.costUsd;
  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0) return Math.round(recorded * 100);
  return 0;
}

export function openRouterUsageToCursorSummary(usage: SandInferenceRouterUsage | null | undefined) {
  const openrouter = usage?.providers.openrouter;
  const usedCents = openRouterCostCents(openrouter);
  return {
    isEnterprise: false,
    sandUsagePercent: null,
    sandUsageResetTimestampMs: null,
    hasAvailableUsage: true,
    isSandTrial: false,
    hasEndedSandTrial: false,
    hasNonZeroIncludedLimit: false,
    canCancelSandTrial: false,
    onDemand: {
      usedCents,
      limitCents: null,
      resetTimestampMs: null,
    },
    upgradeCta: {
      label: "OpenRouter activity",
      disabled: false,
      action: { kind: "open-url" as const, url: OPENROUTER_ACTIVITY_URL },
    },
  };
}
