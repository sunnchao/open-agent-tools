import { asRecord, trimmedString } from "@open-agent-tools/api-contracts/values";

export { asRecord };

/** Return the first non-empty trimmed string for one of the candidate keys. */
export function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = trimmedString(record[key]);
    if (value) return value;
  }
  return null;
}
