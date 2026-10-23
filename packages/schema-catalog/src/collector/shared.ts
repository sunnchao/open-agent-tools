import type { CatalogSource, ColumnMeta, EnumMeta } from "../types.js";

export function groupByTable<T>(
  rows: readonly T[],
  tableKey: (row: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = tableKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

export function matchesAny(name: string, filters: string[]): boolean {
  return filters.some((filter) => {
    if (!filter.includes("*")) return filter === name;
    const escaped = filter.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${escaped.join(".*")}$`).test(name);
  });
}

export function isSensitive(column: string, comment?: string): ColumnMeta["sensitivity"] {
  const text = `${column} ${comment ?? ""}`.toLowerCase();
  return /(password|passwd|pwd|secret|token|api_?key|private_?key|id_card|身份证|手机号|mobile|phone|手机|密码|密钥)/.test(
    text,
  )
    ? "sensitive"
    : "normal";
}

const COMMON_TYPES: Record<CatalogSource, RegExp> = {
  mysql: /^(tinyint|smallint|mediumint|int|bigint|varchar|char|enum|set|date|datetime|timestamp)/,
  postgresql:
    /^(smallint|integer|bigint|numeric|decimal|real|double precision|character varying|character|text|date|timestamp|boolean)/,
};

export function columnTier(
  column: string,
  type: string,
  isPrimary: boolean,
  isUnique: boolean,
  source: CatalogSource,
): ColumnMeta["tier"] {
  if (isPrimary || isUnique) return "required";
  const name = column.toLowerCase();
  if (/^(created|updated|submitted|approved|status|state|type|org|dept|is_|has_)/.test(name))
    return "required";
  if (
    /^(username|user_name|account|login|login_name|nickname|nick_name|display_name|real_name)$/.test(
      name,
    )
  )
    return "common";
  if (/(_at|_on|_id|_no|_code|_name|_type|_status)/.test(name)) return "common";
  if (
    COMMON_TYPES[source].test(type.toLowerCase()) &&
    /(^|_)(id|no|code|name|status|type|time|date)(_|$)/.test(name)
  )
    return "common";
  return "full";
}

export function commentEnum(column: ColumnMeta): EnumMeta | null {
  const pairs = (column.comment ?? "").match(/(\d+)\s*=\s*([^;，,]+)/g);
  if (!pairs || pairs.length < 2) return null;
  return {
    table: column.table,
    column: column.name,
    values: pairs.map((pair) => {
      const [value, ...meaning] = pair.split("=");
      return { value: value!.trim(), meaning: meaning.join("=").trim() };
    }),
  };
}
