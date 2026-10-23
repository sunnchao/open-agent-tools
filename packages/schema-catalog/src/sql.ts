/** Quote a PostgreSQL identifier without accepting raw SQL fragments. */
export function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
