/** Transport-neutral value normalization shared by web, mobile and server callers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Keep non-empty string values once, in their first-seen order. */
export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** Split a user-entered list, trim entries and remove empty or repeated values. */
export function parseDelimitedStringList(
  value: string,
  delimiter: string | RegExp = /[,，\n]/,
): string[] {
  return [
    ...new Set(
      value
        .split(delimiter)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** Parse and normalize a JSON string-list field, treating malformed data as empty. */
export function parseJsonStringList(raw: string): string[] {
  try {
    return normalizeStringList(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

/** Return a trimmed non-empty string or null for missing/invalid input. */
export function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Return a trimmed non-empty string or undefined for missing/invalid input. */
export function optionalString(value: unknown): string | undefined {
  return trimmedString(value) ?? undefined;
}

export function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : 0;
}

export function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
