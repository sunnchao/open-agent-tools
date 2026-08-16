/**
 * Returns `true` when `error` (or any of its `cause` chain) carries the given
 * PostgreSQL error code (e.g. `"23505"` for unique violations).
 */
export function isPostgresError(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && (current as { code?: unknown }).code === code) return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** Convenience wrapper for the PostgreSQL unique-violation error code `23505`. */
export function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error, "23505");
}
