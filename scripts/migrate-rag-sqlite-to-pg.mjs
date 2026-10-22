#!/usr/bin/env node
/**
 * 把旧 SQLite 知识库（rag.db 的 chunks / documents）迁移到 PostgreSQL + pgvector，
 * 可选地同时把内容写入 Elasticsearch（关键词通道）。
 *
 * 用法：
 *   node scripts/migrate-rag-sqlite-to-pg.mjs --dry-run          # 只看统计，不写库
 *   node scripts/migrate-rag-sqlite-to-pg.mjs                    # 迁移到 PG
 *   node scripts/migrate-rag-sqlite-to-pg.mjs --es               # 同时写 ES（需 RAG_ES_NODE）
 *
 * 环境变量：
 *   RAG_DB_PATH            旧 SQLite 文件，默认 apps/rag-server/rag.db
 *   RAG_PG_URL             目标 PostgreSQL（必填）
 *   RAG_PG_TABLE_PREFIX    表前缀，默认 rag
 *   RAG_PG_DIMS            向量维度，默认取第一个向量的实际长度
 *   RAG_ES_NODE / RAG_ES_INDEX_PREFIX / RAG_ES_DIMS   --es 时使用
 *
 * 行为与限制：
 * - 逐来源 replaceSource（先删后写），因此可重复执行，不会重复累积；
 * - 保留 title / tags / allowedGroups（replaceSource 之后补一次 updateDocument）；
 * - 分块 id 原样保留（sha1(source:chunkIndex)），图谱库里的 sourceChunk 引用继续有效；
 * - documents.version 会重置为 1、createdAt 取迁移时间：这两项不在 VectorStore 接口内；
 * - 旧 SQLite 文件不会被修改或删除。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ElasticsearchVectorStore,
  HybridVectorStore,
  PgVectorStore,
} from "../packages/rag/dist/index.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const withEs = args.has("--es");

const sqlitePath = resolve(process.env.RAG_DB_PATH ?? "apps/rag-server/rag.db");
const pgUrl = process.env.RAG_PG_URL?.trim();
if (!dryRun && !pgUrl) {
  console.error("error: RAG_PG_URL is required (or pass --dry-run)");
  process.exit(2);
}
if (!existsSync(sqlitePath)) {
  console.error(`error: sqlite file not found: ${sqlitePath}`);
  process.exit(2);
}

/** SQLite 里存的是小端 Float32 BLOB，转回 Float32Array。 */
function deserializeF32(bytes) {
  const copy = new Uint8Array(bytes);
  copy.set(new Uint8Array(bytes));
  return new Float32Array(copy.buffer);
}

function toStringArray(json, fallback = []) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : fallback;
  } catch {
    return fallback;
  }
}

const db = new DatabaseSync(sqlitePath, { readOnly: true });
const documents = db
  .prepare(`SELECT * FROM documents ORDER BY source`)
  .all();

const chunksBySource = new Map();
const chunkStmt = db.prepare(
  `SELECT id, source, chunk_index, content, embedding FROM chunks
    WHERE source = ? ORDER BY chunk_index`,
);

let totalChunks = 0;
let detectedDims = 0;
for (const document of documents) {
  const rows = chunkStmt.all(document.source);
  const rowsWithVector = rows.map((row) => {
    const embedding = row.embedding ? deserializeF32(row.embedding) : new Float32Array(0);
    if (embedding.length > 0) {
      if (detectedDims === 0) detectedDims = embedding.length;
      else if (detectedDims !== embedding.length) {
        throw new Error(
          `mixed embedding dims in ${document.source}: ${detectedDims} vs ${embedding.length}`,
        );
      }
    }
    return {
      chunk: {
        id: row.id,
        source: row.source,
        chunkIndex: row.chunk_index,
        content: row.content,
      },
      embedding,
    };
  });
  chunksBySource.set(document.source, rowsWithVector);
  totalChunks += rowsWithVector.length;
}

console.log(
  `[migrate] sqlite=${sqlitePath} documents=${documents.length} chunks=${totalChunks} dims=${detectedDims || "none"}`,
);
for (const document of documents) {
  console.log(
    `  - ${document.source}: chunks=${chunksBySource.get(document.source).length} ` +
      `version=${document.version} mime=${document.mime_type}`,
  );
}

if (dryRun) {
  console.log("[migrate] dry-run: nothing written");
  db.close();
  process.exit(0);
}

const pgStore = new PgVectorStore({
  connectionString: pgUrl,
  tablePrefix: process.env.RAG_PG_TABLE_PREFIX?.trim() || "rag",
  dims: Number(process.env.RAG_PG_DIMS) || detectedDims || 1536,
});

let esStore;
if (withEs) {
  const esNode = process.env.RAG_ES_NODE?.trim();
  if (!esNode) {
    console.error("error: --es requires RAG_ES_NODE");
    process.exit(2);
  }
  esStore = new ElasticsearchVectorStore({
    node: esNode,
    indexPrefix: process.env.RAG_ES_INDEX_PREFIX?.trim() || "rag",
    dims: Number(process.env.RAG_ES_DIMS) || detectedDims || 1536,
    clientOptions: { requestTimeout: 5000, maxRetries: 0 },
  });
  console.log(`[migrate] also syncing content to elasticsearch: ${esNode}`);
}

const store = esStore
  ? new HybridVectorStore({ vectorStore: pgStore, keywordStore: esStore })
  : pgStore;

try {
  await pgStore.ensureSchema();
  console.log(`[migrate] target tables: ${pgStore.tables.chunks} / ${pgStore.tables.documents}`);

  let migrated = 0;
  for (const document of documents) {
    const rows = chunksBySource.get(document.source);
    if (rows.length === 0) continue;
    const metadata = {
      mimeType: document.mime_type ?? "application/octet-stream",
      byteSize: Number(document.byte_size ?? 0),
      contentHash: document.content_hash ?? "",
      chunkStrategy: document.chunk_strategy === "semantic" ? "semantic" : "fixed",
      chunkSize: Number(document.chunk_size ?? 500),
      chunkOverlap: Number(document.chunk_overlap ?? 50),
      separators: toStringArray(document.separators_json ?? "[]"),
      semanticThreshold:
        document.semantic_threshold === null || document.semantic_threshold === undefined
          ? null
          : Number(document.semantic_threshold),
      ocrApplied: Boolean(document.ocr_applied),
      ocrStatus: document.ocr_status ?? "none",
    };
    await store.replaceSource(document.source, rows, metadata);

    // replaceSource 会把 title 置为 source、清空 tags/ACL，这里补回人工运营数据。
    const tags = toStringArray(document.tags_json ?? "[]");
    const allowedGroups = toStringArray(document.allowed_groups_json ?? "[]");
    if (
      document.title !== document.source ||
      tags.length > 0 ||
      allowedGroups.length > 0
    ) {
      await store.updateDocument(document.source, {
        title: document.title,
        tags,
        allowedGroups,
      });
    }
    migrated += rows.length;
    console.log(`[migrate] ${document.source}: ${rows.length} chunks -> pg`);
  }

  const count = await pgStore.countChunks();
  console.log(
    `[migrate] done: migrated=${migrated} chunks, target countChunks=${count}, sources=${(await pgStore.listSources()).length}`,
  );
} finally {
  await store.close?.();
  db.close();
}
