import { createHash } from "node:crypto";

export const LOCAL_PROFILE_DEFAULT_NAME = "Local";
export const GRAVATAR_SIZE_PX = 160;

export interface LocalProfile {
  readonly name: string;
  readonly email: string;
}

export function normalizeLocalProfileName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/g, " ").trim();
  return name.length === 0 || name.length > 200 ? undefined : name;
}

export function normalizeLocalProfileEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || email.includes("\n") || email.includes("\0")) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
  return email;
}

export function gravatarAvatarUrl(email: string, size = GRAVATAR_SIZE_PX): string {
  const hash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon&r=g`;
}

export function localProfilePictureUrl(email: string | undefined): string | undefined {
  const normalized = normalizeLocalProfileEmail(email);
  return normalized == null ? undefined : gravatarAvatarUrl(normalized);
}

export function resolveLocalProfile(raw: { readonly name?: unknown; readonly email?: unknown } | undefined): LocalProfile {
  return {
    name: normalizeLocalProfileName(raw?.name) ?? LOCAL_PROFILE_DEFAULT_NAME,
    email: normalizeLocalProfileEmail(raw?.email) ?? "",
  };
}
