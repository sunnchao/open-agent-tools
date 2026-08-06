export function querySources(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error("sources must be a string array with at most 50 items");
  }
  return [...new Set(value.map((source) => source.trim()).filter(Boolean))];
}
