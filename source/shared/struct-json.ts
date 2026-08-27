export function sanitizeToolInputForStruct(value: unknown): Record<string, unknown> {
  if (value == null || value === "undefined" || value === "null") return {};
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === "undefined" || trimmed === "null") return {};
    try { return sanitizeToolInputForStruct(JSON.parse(trimmed) as unknown); }
    catch { return {}; }
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const json = JSON.stringify(value);
    if (json == null || json === "undefined" || json === "null") return {};
    const parsed = JSON.parse(json) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
