const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|cookie|credential/i;

export function lastFour(value: string): string {
  if (value.length <= 4) return "****";
  return `…${value.slice(-4)}`;
}

export function redactSecret(value: string | undefined | null): string | null {
  if (value == null || value.length === 0) return null;
  return lastFour(value);
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key != null && SECRET_KEY.test(key) && typeof value === "string") return lastFour(value);
  if (typeof value === "string" && value.length > 24 && SECRET_KEY.test(key ?? "")) return lastFour(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object" && value != null) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) result[entryKey] = redactValue(entryValue, entryKey);
    return result;
  }
  return value;
}
