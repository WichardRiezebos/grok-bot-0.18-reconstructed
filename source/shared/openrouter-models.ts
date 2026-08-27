export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4.1";
export const DEFAULT_OPENROUTER_REASONING_EFFORT = "medium";
export const DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT = "low";
export const OPENROUTER_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type OpenRouterReasoningEffort = (typeof OPENROUTER_REASONING_EFFORTS)[number];
export const RECOMMENDED_OPENROUTER_MODEL_IDS = [
  "x-ai/grok-4",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-4.1",
  "google/gemini-2.5-pro",
  "meta-llama/llama-4-maverick",
  "qwen/qwen3.7-flash",
] as const;
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
  chatModel: string,
  env = process.env.SAND_OPENROUTER_COMPUTER_MODEL,
): string {
  return normalizeOpenRouterModelId(env)
    ?? normalizeOpenRouterModelId(stored)
    ?? normalizeOpenRouterModelId(chatModel)
    ?? DEFAULT_OPENROUTER_MODEL;
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
