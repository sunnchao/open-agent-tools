import type { SchemaCatalog, TableCatalog } from "../types.js";

export interface PreRegisteredIntent {
  intent: string;
  /** 该意图必用的表。 */
  tables: string[];
  /** 默认 join 路径说明（供渲染）。 */
  joinNote?: string;
}

/**
 * 意图 → 表预注册表（确定性选表）。
 * 由业务方（配合 query-resolver 的口径字典）维护；命中后零 LLM 消耗。
 */
export class PreRegisteredSelector {
  constructor(private readonly intents: PreRegisteredIntent[]) {}

  resolve(intent: string): PreRegisteredIntent | undefined {
    return this.intents.find((i) => i.intent === intent);
  }

  /** 从 catalog 中取出预注册意图涉及的完整表 schema。 */
  selectTables(catalog: SchemaCatalog, intent: string): TableCatalog[] {
    const entry = this.resolve(intent);
    if (!entry) return [];
    const byName = new Map(catalog.tables.map((t) => [t.table.name, t]));
    return entry.tables
      .map((name) => byName.get(name))
      .filter((t): t is TableCatalog => t !== undefined);
  }
}

/**
 * 探索式查询兜底：关键词 / 语义检索选表。
 * 语义检索可接入 packages/rag（向量+BM25）；此处提供关键词评分实现。
 *
 * 中文没有词边界，因此把查询切成二元组（bigram）并与 表名/注释/字段/枚举
 * 做双向子串匹配（词条包含 token 或 token 包含词条均算命中）。
 */
export function searchTables(
  catalog: SchemaCatalog,
  query: string,
  topK = 5,
): Array<{ table: TableCatalog; score: number }> {
  const tokens = tokenize(query);
  const scored: Array<{ table: TableCatalog; score: number }> = [];
  for (const t of catalog.tables) {
    const terms = [
      t.table.name.toLowerCase(),
      t.table.comment?.toLowerCase() ?? "",
      ...t.columns.flatMap((c) => [c.name.toLowerCase(), c.comment?.toLowerCase() ?? ""]),
      ...t.enums.flatMap((e) => e.values.map((v) => v.value.toLowerCase())),
    ].filter(Boolean);

    let score = 0;
    for (const token of tokens) {
      const hit = (term: string, weight: number) => {
        if (term.includes(token) || token.includes(term)) score += weight;
      };
      terms.forEach((term) => {
        if (term === t.table.name) hit(term, 3); // 表名
        else if (term === t.table.comment) hit(term, 2); // 表注释
        else hit(term, 1); // 字段/枚举
      });
    }
    if (score > 0) scored.push({ table: t, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 查询切词：空白/标点分词 + 中文连续段转二元组。 */
function tokenize(query: string): string[] {
  const parts = query.toLowerCase().split(/[\s，。、,；;：:！!？?（）()]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const part of parts) {
    const hasCjk = /[\u4e00-\u9fff]/.test(part);
    if (!hasCjk) {
      tokens.push(part);
      continue;
    }
    // 整段 + 二元组
    tokens.push(part);
    for (let i = 0; i < part.length - 1; i += 1) {
      tokens.push(part.slice(i, i + 2));
    }
  }
  return tokens;
}
