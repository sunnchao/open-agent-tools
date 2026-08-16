/** MySQL 常见错误码。 */
export const MYSQL_ERROR_CODES = {
  /** Duplicate entry（唯一键冲突）。 */
  DUPLICATE_ENTRY: "ER_DUP_ENTRY",
} as const;

/**
 * 返回 `error`（或其 `cause` 链）是否携带给定 MySQL 错误码。
 *
 * mysql2 的驱动错误通过 `errno` / `code`（如 `"ER_DUP_ENTRY"`）暴露。
 */
export function isMysqlError(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const c = current as { code?: unknown; errno?: unknown };
    if (c.code === code || String(c.errno) === code) return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** 唯一键冲突（Duplicate entry）便捷判定。 */
export function isMysqlUniqueViolation(error: unknown): boolean {
  return isMysqlError(error, MYSQL_ERROR_CODES.DUPLICATE_ENTRY);
}
