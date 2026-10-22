#!/usr/bin/env node
/**
 * 把 PostgreSQL 里已有的知识库内容重建到 Elasticsearch 关键词索引。
 *
 * 为什么需要它：`RAG_ES_SYNC_MODE=lenient`（默认）下，ES 不可用时入库照常成功但关键词索引会缺数据；
 * 等 ES 恢复后跑一次本脚本即可补齐，不必重传文档。同样适用于 ES 数据卷被清空、
 * 索引 mapping 变更后重建、或历史上用 `--es` 之外的方式导入过数据的情况。
 *
 * 用法：
 *   node scripts/resync-rag-es.mjs --dry-run              # 只列出来源与分块数
 *   node scripts/resync-rag-es.mjs                        # 全量重建
 *   node scripts/resync-rag-es.mjs --source a.md --source b.md   # 只重建指定来源
 *
 * 环境变量：RAG_PG_URL（必填）、RAG_PG_TABLE_PREFIX、RAG_ES_NODE（必填）、
 *          RAG_ES_INDEX_PREFIX、RAG_ES_DIMS
 * 未显式提供时自动读取 apps/rag-server/.env（命令行内联变量优先）。
 */
import {
  ElasticsearchVectorStore,
  HybridVectorStore,
  PgVectorStore,
} from "../packages/rag/dist/index.js";
import { loadRagEnv } from "./lib/rag-env.mjs";

const envFile = loadRagEnv();

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const sources = argv.flatMap((arg, index) => {
  if (arg === "--source") return [argv[index + 1]].filter(Boolean);
  return [];
});

const pgUrl = process.env.RAG_PG_URL?.trim();
const esNode = process.env.RAG_ES_NODE?.trim();
if (!pgUrl) {
  console.error("error: RAG_PG_URL is required");
  process.exit(2);
}
if (!esNode) {
  console.error("error: RAG_ES_NODE is required");
  process.exit(2);
}

const pgStore = new PgVectorStore({
  connectionString: pgUrl,
  tablePrefix: process.env.RAG_PG_TABLE_PREFIX?.trim() || "rag",
  dims: Number(process.env.RAG_PG_DIMS) || 1024,
  // 重建 ES 不涉及 pgvector 查询，关掉索引建设可以省掉一次 DDL。
  createIndex: false,
});

const esStore = new ElasticsearchVectorStore({
  node: esNode,
  indexPrefix: process.env.RAG_ES_INDEX_PREFIX?.trim() || "rag",
  dims: Number(process.env.RAG_ES_DIMS) || 1024,
  clientOptions: { requestTimeout: 10000, maxRetries: 1 },
});

const store = new HybridVectorStore({
  vectorStore: pgStore,
  keywordStore: esStore,
  syncMode: "strict",
  keywordFailureMode: "strict",
});

/** ES 客户端的 ConnectionError 往往没有 message，尽量拼出可排查的信息。 */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.name, error.message, error.code].filter(
    (part) => typeof part === "string" && part.trim().length > 0,
  );
  const cause = error.cause;
  if (cause instanceof Error) parts.push(`cause: ${cause.code ?? ""} ${cause.message}`.trim());
  return parts.length > 0 ? parts.join(" | ") : "unknown error";
}

try {
  const targets = sources.length > 0 ? sources : await pgStore.listSources();
  console.log(
    `[resync] env=${envFile ?? "(process.env)"} pg=${pgUrl} es=${esNode} sources=${targets.length}`,
  );
  for (const source of targets) {
    const chunks = (await pgStore.listChunksBySource?.(source)) ?? [];
    console.log(`  - ${source}: ${chunks.length} chunks`);
  }
  if (dryRun) {
    console.log("[resync] dry-run: nothing written");
  } else {
    const result = await store.resync(targets);
    console.log(`[resync] done: sources=${result.sources} chunks=${result.chunks}`);
  }
} catch (error) {
  console.error(`[resync] failed: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  await store.close?.();
}
