export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.7-flash";
export const DEFAULT_OPENROUTER_COMPUTER_MODEL = "anthropic/claude-haiku-4.5";
export const DEFAULT_OPENROUTER_SUMMARIZE_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_OPENROUTER_REASONING_EFFORT = "low";
export const DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT = "low";
export const OPENROUTER_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type OpenRouterReasoningEffort = (typeof OPENROUTER_REASONING_EFFORTS)[number];
export const OPENROUTER_SLOTS = ["think", "drive", "summarize"] as const;
export type OpenRouterSlot = (typeof OPENROUTER_SLOTS)[number];
export const RECOMMENDED_OPENROUTER_MODEL_IDS = [
  "google/gemini-3.7-flash",
  "anthropic/claude-haiku-4.5",
  "google/gemini-2.5-flash",
  "x-ai/grok-4.6",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.6",
] as const;
export const OPENROUTER_SLOT_PRESETS = {
  high: {
    model: "anthropic/claude-opus-4.6",
    computerModel: "anthropic/claude-opus-4.6",
    summarizeModel: "google/gemini-2.5-flash",
    reasoningEffort: "medium",
    computerReasoningEffort: "low",
  },
  med: {
    model: "x-ai/grok-4.6",
    computerModel: "anthropic/claude-haiku-4.5",
    summarizeModel: "google/gemini-2.5-flash",
    reasoningEffort: "medium",
    computerReasoningEffort: "low",
  },
  low: {
    model: "google/gemini-3.7-flash",
    computerModel: "anthropic/claude-haiku-4.5",
    summarizeModel: "google/gemini-2.5-flash",
    reasoningEffort: "low",
    computerReasoningEffort: "low",
  },
} as const;
export type OpenRouterSlotPresetId = keyof typeof OPENROUTER_SLOT_PRESETS;
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=text";
export const OPENROUTER_CATALOG_TIMEOUT_MS = 20_000;

export interface OpenRouterModelOption {
  readonly id: string;
  readonly name: string;
  readonly recommended: boolean;
}

export function normalizeOpenRouterModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^~+/u, "");
  if (trimmed.length === 0 || trimmed.includes("\n") || trimmed.includes("\0")) return undefined;
  return trimmed;
}

export function resolveOpenRouterModel(stored: unknown, env = process.env.SAND_OPENROUTER_MODEL): string {
  return normalizeOpenRouterModelId(env) ?? normalizeOpenRouterModelId(stored) ?? DEFAULT_OPENROUTER_MODEL;
}

export function resolveOpenRouterComputerModel(
  stored: unknown,
  _chatModel?: string,
  env = process.env.SAND_OPENROUTER_COMPUTER_MODEL,
): string {
  return normalizeOpenRouterModelId(env)
    ?? normalizeOpenRouterModelId(stored)
    ?? DEFAULT_OPENROUTER_COMPUTER_MODEL;
}

export function resolveOpenRouterSummarizeModel(
  stored: unknown,
  thinkModel: string,
  env = process.env.SAND_OPENROUTER_SUMMARIZE_MODEL,
): string {
  return normalizeOpenRouterModelId(env)
    ?? normalizeOpenRouterModelId(stored)
    ?? normalizeOpenRouterModelId(thinkModel)
    ?? DEFAULT_OPENROUTER_SUMMARIZE_MODEL;
}

export function openRouterSlotFromSession(options?: {
  readonly isComputerUseSubagent?: boolean;
  readonly isSummarizationSession?: boolean;
}): OpenRouterSlot {
  if (options?.isSummarizationSession === true) return "summarize";
  if (options?.isComputerUseSubagent === true) return "drive";
  return "think";
}

export function resolveOpenRouterSlotModel(
  slot: OpenRouterSlot,
  args: {
    readonly think: string;
    readonly drive: string;
    readonly summarize: string;
  },
): string {
  if (slot === "drive") return args.drive;
  if (slot === "summarize") return args.summarize;
  return args.think;
}

export function isOpenRouterReasoningEffort(value: unknown): value is OpenRouterReasoningEffort {
  return typeof value === "string" && (OPENROUTER_REASONING_EFFORTS as readonly string[]).includes(value);
}

export function normalizeOpenRouterReasoningEffort(value: unknown): OpenRouterReasoningEffort | undefined {
  return isOpenRouterReasoningEffort(value) ? value : undefined;
}

export function resolveOpenRouterReasoningEffort(
  stored: unknown,
  fallback: OpenRouterReasoningEffort,
  env?: string,
): OpenRouterReasoningEffort {
  return normalizeOpenRouterReasoningEffort(env) ?? normalizeOpenRouterReasoningEffort(stored) ?? fallback;
}

export function openRouterReasoningRequest(effort: OpenRouterReasoningEffort): { effort: OpenRouterReasoningEffort; exclude: false } | undefined {
  if (effort === "none") return undefined;
  // Stream reasoning into the Thinking row. Excluding it leaves a blank gap while
  // the model thinks and the shipped transcript still reserves an empty block.
  return { effort, exclude: false };
}

export function injectOpenRouterReasoningIntoBody(body: unknown, effort: OpenRouterReasoningEffort): unknown {
  if (typeof body !== "string") return body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return body;
    const reasoning = openRouterReasoningRequest(effort);
    if (reasoning == null) {
      const next = { ...(parsed as Record<string, unknown>) };
      delete next.reasoning;
      return JSON.stringify(next);
    }
    return JSON.stringify({ ...(parsed as Record<string, unknown>), reasoning });
  } catch {
    return body;
  }
}

export function openRouterCatalogCurrentIds(...values: unknown[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    const id = normalizeOpenRouterModelId(value);
    if (id != null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function isTextOpenRouterModel(model: { readonly architecture?: { readonly output_modalities?: unknown; readonly modality?: unknown } }): boolean {
  const outputs = model.architecture?.output_modalities;
  if (Array.isArray(outputs)) {
    if (outputs.includes("text")) return true;
    if (outputs.length > 0) return false;
  }
  const modality = model.architecture?.modality;
  if (typeof modality === "string") return modality.includes("->text") || modality === "text";
  return true;
}

export function parseOpenRouterCatalog(payload: unknown, currentId?: string | readonly string[]): OpenRouterModelOption[] {
  const root = typeof payload === "object" && payload != null && !Array.isArray(payload) ? payload as { data?: unknown } : null;
  const data = Array.isArray(root?.data) ? root.data : Array.isArray(payload) ? payload : [];
  const byId = new Map<string, { id: string; name: string }>();
  for (const raw of data) {
    if (typeof raw !== "object" || raw == null || Array.isArray(raw)) continue;
    const record = raw as { id?: unknown; name?: unknown; architecture?: { output_modalities?: unknown; modality?: unknown } };
    const id = normalizeOpenRouterModelId(record.id);
    if (id == null || !isTextOpenRouterModel(record)) continue;
    const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : id;
    byId.set(id, { id, name });
  }
  for (const current of openRouterCatalogCurrentIds(...(Array.isArray(currentId) ? currentId : [currentId]))) {
    if (!byId.has(current)) byId.set(current, { id: current, name: current });
  }
  const recommended = RECOMMENDED_OPENROUTER_MODEL_IDS
    .filter((id) => byId.has(id))
    .map((id) => ({ ...byId.get(id)!, recommended: true }));
  const recommendedIds = new Set(recommended.map((model) => model.id));
  const rest = [...byId.values()]
    .filter((model) => !recommendedIds.has(model.id))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((model) => ({ ...model, recommended: false }));
  return [...recommended, ...rest];
}

export function openRouterModelLabel(model: OpenRouterModelOption): string {
  return model.recommended ? `Recommended · ${model.name}` : model.name;
}
