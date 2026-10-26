import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { Rag } from "@open-agent-tools/rag";
import {
  catalogToDocuments,
  createSemanticSelector,
  type RetrievalFn,
  type SchemaCatalog,
} from "@open-agent-tools/schema-catalog";
import { getDbPath } from "../../../platform/db.js";

interface CachedSelector {
  fingerprint: string;
  rag: Rag;
  retrieve: RetrievalFn;
}

const cache = new Map<string, CachedSelector>();

/** 语义选表开关：设置 SCHEMA_SEMANTIC_SELECTOR 为 1/true/on/rag 时启用。 */
export function semanticSelectorEnabled(): boolean {
  const value = process.env.SCHEMA_SEMANTIC_SELECTOR?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "rag";
}

function fingerprintOf(catalog: SchemaCatalog): string {
  const documents = catalogToDocuments(catalog);
  return createHash("sha1")
    .update(documents.map((doc) => `${doc.id}\u0000${doc.content}`).join("\u0001"))
    .digest("hex");
}

function indexPathFor(sourceId: string): string {
  const configured = process.env.SCHEMA_SEMANTIC_INDEX_PATH?.trim();
  if (configured) return configured.replace("{source}", sourceId);
  return resolve(dirname(getDbPath()), `schema-semantic-${sourceId}.sqlite`);
}

/**
 * 构建（并缓存）某数据源的语义检索器：把 catalog 扁平化为表文档写入 RAG 索引
 * （无 embeddings 时退化为 BM25），返回 schema-catalog 约定的 RetrievalFn。
 */
export async function buildSemanticRetriever(
  sourceId: string,
  catalog: SchemaCatalog,
): Promise<RetrievalFn> {
  const fingerprint = fingerprintOf(catalog);
  const cached = cache.get(sourceId);
  if (cached && cached.fingerprint === fingerprint) return cached.retrieve;

  cached?.rag.close();
  const rag = new Rag({ dbPath: indexPathFor(sourceId) });
  const documents = catalogToDocuments(catalog);
  await rag.ingestBuffers(
    documents.map((doc) => ({ name: `${doc.id}.md`, data: new TextEncoder().encode(doc.content) })),
  );

  const retrieve: RetrievalFn = async (query, topK) => {
    const result = await rag.retrieve(query, { topK: Math.max(topK, 1) });
    const best = new Map<string, number>();
    for (const chunk of result.chunks) {
      const table = chunk.source.replace(/\.md$/, "");
      best.set(table, Math.max(best.get(table) ?? 0, chunk.score));
    }
    return [...best.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
  };

  cache.set(sourceId, { fingerprint, rag, retrieve });
  return retrieve;
}

/** 按语义检索选出最相关的表名；未启用或无命中时返回空数组，交由调用方回退。 */
export async function selectTablesSemantically(
  sourceId: string,
  question: string,
  catalog: SchemaCatalog,
  topK = 4,
): Promise<string[]> {
  if (!semanticSelectorEnabled()) return [];
  const retrieve = await buildSemanticRetriever(sourceId, catalog);
  const selector = createSemanticSelector(catalog, retrieve);
  const hits = await selector.select(question, topK);
  return hits.map((hit) => hit.table.table.name);
}

/** 释放缓存索引（配置变更或测试清理时调用）。 */
export function resetSemanticSelectors(): void {
  for (const entry of cache.values()) entry.rag.close();
  cache.clear();
}
