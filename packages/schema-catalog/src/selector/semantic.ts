import type { SchemaCatalog, TableCatalog } from "../types.js";

/** 检索命中：id 对应 catalogToDocuments 产出的 doc.id（即表名）。 */
export interface RetrievalHit {
  id: string;
  score: number;
}

/**
 * 外部检索函数：可接入 packages/rag（向量 + BM25 混合检索）或任意自研实现。
 * schema-catalog 只定义契约，不引入 rag 依赖，保持包解耦。
 */
export type RetrievalFn = (query: string, topK: number) => Promise<RetrievalHit[]> | RetrievalHit[];

/** 一张表被扁平化后的可检索文档。 */
export interface CatalogDocument {
  /** 表名，作为检索语料 id。 */
  id: string;
  /** 供向量化/BM25 索引的文本（表名 + 注释 + 字段 + 枚举含义）。 */
  content: string;
  metadata: { table: string; schema: string; comment?: string };
}

export interface SemanticSelector {
  /** 待写入检索索引的语料。 */
  documents: CatalogDocument[];
  /** 按自然语言查询语义选表，返回命中的完整表 schema。 */
  select(query: string, topK?: number): Promise<Array<{ table: TableCatalog; score: number }>>;
}

/** 把 catalog 扁平化为可检索文档：表名/注释/字段名+注释/枚举值含义。 */
export function catalogToDocuments(catalog: SchemaCatalog): CatalogDocument[] {
  return catalog.tables.map((t) => ({
    id: t.table.name,
    content: renderTableDocument(t),
    metadata: { table: t.table.name, schema: t.table.schema, comment: t.table.comment },
  }));
}

function renderTableDocument(t: TableCatalog): string {
  const lines: string[] = [`表 ${t.table.name}`];
  if (t.table.comment) lines.push(`说明：${t.table.comment}`);
  const cols = t.columns
    .map((c) => (c.comment ? `${c.name}(${c.comment})` : c.name))
    .join("、");
  if (cols) lines.push(`字段：${cols}`);
  for (const e of t.enums) {
    const values = e.values
      .map((v) => (v.meaning ? `${v.value}=${v.meaning}` : v.value))
      .join("，");
    if (values) lines.push(`枚举 ${e.column}：${values}`);
  }
  return lines.join("\n");
}

/**
 * 语义选表：把 catalog 文档交给外部检索实现（建议 packages/rag），
 * 按查询召回候选表并映射回完整 schema。
 */
export function createSemanticSelector(
  catalog: SchemaCatalog,
  retrieve: RetrievalFn,
): SemanticSelector {
  const documents = catalogToDocuments(catalog);
  const byName = new Map(catalog.tables.map((t) => [t.table.name, t]));
  return {
    documents,
    async select(query, topK = 5) {
      const hits = await retrieve(query, topK);
      const out: Array<{ table: TableCatalog; score: number }> = [];
      for (const hit of hits) {
        const table = byName.get(hit.id);
        if (table) out.push({ table, score: hit.score });
      }
      return out;
    },
  };
}
