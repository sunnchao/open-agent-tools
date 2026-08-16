import type { ColumnMeta, SchemaCatalog, TableCatalog } from "../types.js";

export interface RenderOptions {
  /** 是否渲染字段注释（默认 true）。 */
  withComments?: boolean;
  /** 是否渲染抽样统计（默认 false，探索式查询可选）。 */
  withSamples?: boolean;
  /** 是否渲染 join 关系（默认 true）。 */
  withRelations?: boolean;
}

const DEFAULT_RENDER: Required<RenderOptions> = {
  withComments: true,
  withSamples: false,
  withRelations: true,
};

/** 一行的 token 估算（中文按 ~1 token/字，ASCII 按 ~4 字符/token，粗估）。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const ascii = text.length - cjk;
  return Math.ceil(cjk * 1.1 + ascii / 4);
}

/**
 * Level 0：全局骨架 —— 只给表名 + 一句话职责 + 行数级，不注入字段。
 * 适合作为 system prompt 里的常驻目录（几百张表也只需几 K token）。
 */
export function renderSkeleton(catalog: SchemaCatalog, options: RenderOptions = {}): string {
  void options;
  const lines: string[] = [];
  lines.push(`# 可用数据表（数据库 ${catalog.database}）`);
  for (const t of catalog.tables) {
    const comment = t.table.comment ? `：${t.table.comment}` : "";
    const rows = t.table.approxRows !== undefined ? `（约 ${formatRows(t.table.approxRows)} 行）` : "";
    lines.push(`- \`${t.table.name}\`${rows}${comment}`);
  }
  return lines.join("\n");
}

/** 渲染一张表的完整 schema（Level 1）。 */
export function renderTableSchema(table: TableCatalog, options: RenderOptions = {}): string {
  const o = { ...DEFAULT_RENDER, ...options };
  const lines: string[] = [];
  const comment = table.table.comment ? ` -- ${table.table.comment}` : "";
  lines.push(`### 表 \`${table.table.name}\`${comment}`);
  lines.push("字段：");
  for (const c of table.columns) {
    lines.push(renderColumn(c, o));
  }
  if (o.withRelations && table.relations.length > 0) {
    lines.push("关联：");
    for (const r of table.relations) {
      lines.push(`- ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`);
    }
  }
  if (o.withSamples && table.samples.length > 0) {
    lines.push("抽样（过滤值分布，仅参考）：");
    for (const s of table.samples) {
      const top = s.topValues.map((v) => `${v.value}(${v.count})`).join(", ");
      lines.push(`- ${s.column}: ${top}`);
    }
  }
  return lines.join("\n");
}

/** 按档位裁剪渲染（Level 2）：required+common 默认，full 需显式。 */
export function renderTableSchemaTiered(
  table: TableCatalog,
  tiers: ColumnMeta["tier"][] = ["required", "common"],
  options: RenderOptions = {},
): string {
  const o = { ...DEFAULT_RENDER, ...options };
  const kept = table.columns.filter((c) => c.sensitivity !== "sensitive" && tiers.includes(c.tier));
  return renderTableSchema({ ...table, columns: kept }, o);
}

function renderColumn(c: ColumnMeta, o: Required<RenderOptions>): string {
  const pk = c.isPrimary ? " PK" : "";
  const fk = c.isUnique ? " UQ" : "";
  const idx = c.hasIndex ? " IDX" : "";
  const nullable = c.nullable ? " NULL" : "";
  const comment = o.withComments && c.comment ? ` -- ${c.comment}` : "";
  const enumHint = c.enumHint
    ? ` [枚举: ${Object.entries(c.enumHint)
        .map(([v, m]) => `${v}=${m}`)
        .join(", ")}]`
    : "";
  return `- \`${c.name}\` ${c.columnType}${pk}${fk}${idx}${nullable}${comment}${enumHint}`;
}

function formatRows(n: number): string {
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(1)}亿`;
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(1)}万`;
  return String(n);
}
