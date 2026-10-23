import { DatabaseSync } from "node:sqlite";
import type {
  Chunk,
  ChunkInfo,
  DocumentInfo,
  DocumentMetadataPatch,
  DocumentWriteMetadata,
  ScoredChunk,
  VectorStore,
} from "./types.js";
import {
  addCjkSpacing,
  cosine,
  deserializeF32,
  escapeFtsQuery,
  escapeFtsQueryOr,
  serializeF32,
} from "./utils.js";

export interface SqliteStoreOptions {
  /** SQLite 数据库文件路径，如 "./rag.db"。 */
  dbPath: string;
  /**
   * Number of vector rows loaded per scan. Batching bounds the temporary candidate
   * memory while preserving the existing brute-force cosine search.
   */
  vectorScanBatchSize?: number;
  /**
   * Candidate count below which one ordered SQL read is cheaper than repeated scans.
   * This remains a bounded raw-row limit; larger candidate sets use `vectorScanBatchSize`.
   */
  vectorScanEagerRowLimit?: number;
}

interface ChunkRow {
  rowid: number;
  id: string;
  source: string;
  chunk_index: number;
  content: string;
  embedding: Uint8Array;
}

interface RankedChunk {
  chunk: Chunk;
  score: number;
  order: number;
}

function isWorse(a: RankedChunk, b: RankedChunk): boolean {
  return a.score < b.score || (a.score === b.score && a.order > b.order);
}

/** Keep the worst retained hit at the root; equal scores retain the original query order. */
function retainTopK(heap: RankedChunk[], hit: RankedChunk, k: number): void {
  if (heap.length < k) {
    let index = heap.length;
    heap.push(hit);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!isWorse(hit, heap[parent]!)) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = hit;
  } else if (hit.score > heap[0]!.score) {
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && isWorse(heap[child + 1]!, heap[child]!)) child++;
      if (!isWorse(heap[child]!, hit)) break;
      heap[index] = heap[child]!;
      index = child;
    }
    heap[index] = hit;
  }
}

interface DocumentRow {
  source: string;
  title: string;
  tags_json: string;
  allowed_groups_json: string;
  mime_type: string;
  byte_size: number;
  content_hash: string;
  chunk_count: number;
  version: number;
  chunk_strategy: string;
  chunk_size: number;
  chunk_overlap: number;
  separators_json: string;
  semantic_threshold: number | null;
  ocr_applied: number;
  ocr_status: string;
  created_at: string;
  updated_at: string;
}

function toChunk(r: ChunkRow): Chunk {
  return { id: r.id, source: r.source, chunkIndex: r.chunk_index, content: r.content };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toDocument(r: DocumentRow): DocumentInfo {
  const status = r.ocr_status as DocumentInfo["ocrStatus"];
  return {
    source: r.source,
    title: r.title,
    tags: parseStringArray(r.tags_json),
    allowedGroups: parseStringArray(r.allowed_groups_json ?? "[]"),
    mimeType: r.mime_type,
    byteSize: r.byte_size,
    contentHash: r.content_hash,
    chunks: r.chunk_count,
    version: r.version,
    chunkStrategy: r.chunk_strategy === "semantic" ? "semantic" : "fixed",
    chunkSize: r.chunk_size,
    chunkOverlap: r.chunk_overlap,
    separators: parseStringArray(r.separators_json),
    semanticThreshold: r.semantic_threshold,
    ocrApplied: (r.ocr_applied ?? 0) === 1,
    ocrStatus:
      status === "ocr" ||
      status === "ocr_needed" ||
      status === "ocr_failed" ||
      status === "text_layer"
        ? status
        : "none",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * SQLite + FTS5 存储实现（路线 A）：
 * - `chunks` 表存原文与向量（Float32 BLOB），整数 rowid 与 FTS 表关联；
 * - `chunks_fts` 是独立 FTS5 虚拟表，索引 CJK 单字分词后的文本，提供 BM25 检索；
 * - 向量检索为暴力余弦 kNN（文档量 < 10 万 chunk 时毫秒级可接受）。
 */
export class SqliteVectorStore implements VectorStore {
  private db: DatabaseSync;
  private vectorScanBatchSize: number;
  private vectorScanEagerRowLimit: number;

  constructor(opts: SqliteStoreOptions) {
    const batchSize = opts.vectorScanBatchSize ?? 1024;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new RangeError("vectorScanBatchSize must be a positive safe integer");
    }
    this.vectorScanBatchSize = batchSize;
    const eagerRowLimit = opts.vectorScanEagerRowLimit ?? 8192;
    if (!Number.isSafeInteger(eagerRowLimit) || eagerRowLimit < 0) {
      throw new RangeError("vectorScanEagerRowLimit must be a non-negative safe integer");
    }
    this.vectorScanEagerRowLimit = eagerRowLimit;
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT NOT NULL UNIQUE,
        source      TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content     TEXT NOT NULL,
        embedding   BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content);
      CREATE TABLE IF NOT EXISTS documents (
        source          TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        tags_json       TEXT NOT NULL DEFAULT '[]',
        allowed_groups_json TEXT NOT NULL DEFAULT '[]',
        mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
        byte_size       INTEGER NOT NULL DEFAULT 0,
        content_hash    TEXT NOT NULL DEFAULT '',
        chunk_count     INTEGER NOT NULL DEFAULT 0,
        version         INTEGER NOT NULL DEFAULT 1,
        chunk_strategy  TEXT NOT NULL DEFAULT 'fixed',
        chunk_size      INTEGER NOT NULL DEFAULT 500,
        chunk_overlap   INTEGER NOT NULL DEFAULT 50,
        separators_json TEXT NOT NULL DEFAULT '[]',
        semantic_threshold REAL,
        ocr_applied     INTEGER NOT NULL DEFAULT 0,
        ocr_status      TEXT NOT NULL DEFAULT 'none',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at DESC);
    `);
    this.ensureDocumentColumns();
    this.migrateLegacyDocuments();
  }

  insert(chunk: Chunk, embedding: Float32Array): void {
    const vector = embedding.length > 0 ? serializeF32(embedding) : null; // 退化模式（无 embeddings）存 NULL
    const res = this.db
      .prepare(
        `INSERT INTO chunks (id, source, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(chunk.id, chunk.source, chunk.chunkIndex, chunk.content, vector);
    const rowid = Number(res.lastInsertRowid);
    this.db
      .prepare(`INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)`)
      .run(rowid, addCjkSpacing(chunk.content)); // 索引 CJK 单字分词版，chunks.content 仍存原文
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO documents (
           source, title, tags_json, mime_type, byte_size, content_hash, chunk_count,
           version, chunk_strategy, chunk_size, chunk_overlap, separators_json,
           semantic_threshold, created_at, updated_at
         ) VALUES (?, ?, '[]', 'application/octet-stream', 0, '', 1, 1, 'fixed', 500, 50, '[]', NULL, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           chunk_count = (SELECT COUNT(*) FROM chunks WHERE source = excluded.source),
           updated_at = excluded.updated_at`,
      )
      .run(chunk.source, chunk.source, now, now);
  }

  /** 向量生成成功后一次性替换来源，任何写入失败都会回滚并保留旧版本。 */
  replaceSource(
    source: string,
    rows: Array<{ chunk: Chunk; embedding: Float32Array }>,
    metadata: DocumentWriteMetadata,
  ): void {
    const now = new Date().toISOString();
    const ocrApplied = metadata.ocrApplied ? 1 : 0;
    const ocrStatus = metadata.ocrStatus ?? "none";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteSourceRows(source);
      for (const { chunk, embedding } of rows) this.insertChunkRow(chunk, embedding);
      this.db
        .prepare(
          `INSERT INTO documents (
             source, title, tags_json, mime_type, byte_size, content_hash, chunk_count,
             version, chunk_strategy, chunk_size, chunk_overlap, separators_json,
             semantic_threshold, ocr_applied, ocr_status, created_at, updated_at
           ) VALUES (?, ?, '[]', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source) DO UPDATE SET
           allowed_groups_json = documents.allowed_groups_json,
             mime_type = excluded.mime_type,
             byte_size = excluded.byte_size,
             content_hash = excluded.content_hash,
             chunk_count = excluded.chunk_count,
             version = documents.version + 1,
             chunk_strategy = excluded.chunk_strategy,
             chunk_size = excluded.chunk_size,
             chunk_overlap = excluded.chunk_overlap,
             separators_json = excluded.separators_json,
             semantic_threshold = excluded.semantic_threshold,
             ocr_applied = excluded.ocr_applied,
             ocr_status = excluded.ocr_status,
             updated_at = excluded.updated_at`,
        )
        .run(
          source,
          source,
          metadata.mimeType,
          metadata.byteSize,
          metadata.contentHash,
          rows.length,
          metadata.chunkStrategy,
          metadata.chunkSize,
          metadata.chunkOverlap,
          JSON.stringify(metadata.separators),
          metadata.semanticThreshold,
          ocrApplied,
          ocrStatus,
          now,
          now,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  vectorSearch(embedding: number[], k: number, sources?: readonly string[]): ScoredChunk[] {
    if (sources?.length === 0) return [];
    const sourceFilter = sources ? ` AND source IN (${sources.map(() => "?").join(", ")})` : "";
    const where = `embedding IS NOT NULL${sourceFilter}`;
    const q = Float32Array.from(embedding);
    const allRows = () =>
      this.db
        .prepare(
          `SELECT rowid, id, source, chunk_index, content, embedding FROM chunks
           WHERE ${where}`,
        )
        .all(...(sources ?? [])) as unknown as ChunkRow[];
    const sortAll = () => {
      return allRows()
        .map((r) => ({ chunk: toChunk(r), score: cosine(q, deserializeF32(r.embedding)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((e) => ({ ...e.chunk, score: e.score }));
    };
    const count = this.db
      .prepare(`SELECT COUNT(*) AS count FROM chunks WHERE ${where}`)
      .get(...(sources ?? [])) as { count: number };
    // Preserve slice coercion for legacy limits; sorting is sufficient when all rows are requested.
    if (!Number.isInteger(k) || k <= 0 || k >= Number(count.count)) return sortAll();
    const heap: RankedChunk[] = [];
    let order = 0;
    const consume = (rows: ChunkRow[]): boolean => {
      for (const row of rows) {
        const score = cosine(q, deserializeF32(row.embedding));
        // NaN/Infinity changes the full-sort comparator order; retain that exceptional fallback.
        if (!Number.isFinite(score)) return false;
        if (heap.length < k || score > heap[0]!.score) {
          retainTopK(heap, { chunk: toChunk(row), score, order }, k);
        }
        order += 1;
      }
      return true;
    };
    const finishHeap = () =>
      heap
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .map(({ chunk, score }) => ({ ...chunk, score }));
    // Small candidate sets are faster with SQLite's native sort than with repeated scans
    // or a JavaScript heap; the unconditional row cap keeps this fast path memory-bounded.
    if (Number(count.count) <= this.vectorScanEagerRowLimit) return sortAll();
    if (sources) {
      // The legacy query uses idx_chunks_source for source filters, which yields sources
      // in B-tree order. Scanning each source separately preserves that tie order while
      // keeping both the query and loaded candidate set bounded.
      const sourceRows = this.db
        .prepare(
          `SELECT DISTINCT source FROM chunks
           WHERE embedding IS NOT NULL AND source IN (${sources.map(() => "?").join(", ")})
           ORDER BY source`,
        )
        .all(...sources) as unknown as Array<{ source: string }>;
      const scanSource = this.db.prepare(
        `SELECT rowid, id, source, chunk_index, content, embedding FROM chunks
         WHERE embedding IS NOT NULL AND source = ? AND rowid > ?
         ORDER BY rowid
         LIMIT ?`,
      );
      for (const { source } of sourceRows) {
        let cursor = 0;
        while (true) {
          const rows = scanSource.all(
            source,
            cursor,
            this.vectorScanBatchSize,
          ) as unknown as ChunkRow[];
          if (rows.length === 0) break;
          if (!consume(rows)) return sortAll();
          cursor = rows[rows.length - 1]!.rowid;
        }
      }
    } else {
      const scan = this.db.prepare(
        `SELECT rowid, id, source, chunk_index, content, embedding FROM chunks
         WHERE embedding IS NOT NULL AND rowid > ?
         ORDER BY rowid
         LIMIT ?`,
      );
      let cursor = 0;
      while (true) {
        const rows = scan.all(cursor, this.vectorScanBatchSize) as unknown as ChunkRow[];
        if (rows.length === 0) break;
        if (!consume(rows)) return sortAll();
        cursor = rows[rows.length - 1]!.rowid;
      }
    }
    return finishHeap();
  }

  /**
   * BM25 关键词检索。query 为原始用户查询（内部做 CJK 切分与转义）：
   * 先 AND 精确匹配；无结果时自动降级为 OR，避免口语化查询（含"怎么办/如何"等）全军覆没。
   */
  keywordSearch(query: string, k: number, sources?: readonly string[]): ScoredChunk[] {
    if (sources?.length === 0) return [];
    const andQuery = escapeFtsQuery(query);
    const and = this.matchQuery(andQuery, k, sources);
    if (and.length > 0) return and;
    const orQuery = escapeFtsQueryOr(query);
    return orQuery ? this.matchQuery(orQuery, k, sources) : [];
  }

  private matchQuery(query: string, k: number, sources?: readonly string[]): ScoredChunk[] {
    if (!query.trim()) return [];
    const sourceFilter = sources ? ` AND c.source IN (${sources.map(() => "?").join(", ")})` : "";
    const rows = this.db
      .prepare(
        `SELECT c.rowid, c.id, c.source, c.chunk_index, c.content,
                bm25(chunks_fts) AS score
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH ?${sourceFilter}
         ORDER BY score
         LIMIT ?`,
      )
      .all(query, ...(sources ?? []), k) as unknown as Array<ChunkRow & { score: number }>;
    // SQLite bm25() 返回负数，越大（越接近 0）越相关；取绝对值便于展示。
    return rows.map((r) => ({ ...toChunk(r), score: Math.abs(r.score) }));
  }

  removeBySource(source: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteSourceRows(source);
      this.db.prepare(`DELETE FROM documents WHERE source = ?`).run(source);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSources(): string[] {
    const rows = this.db
      .prepare(`SELECT source FROM documents ORDER BY source`)
      .all() as unknown as Array<{ source: string }>;
    return rows.map((r) => r.source);
  }

  listDocuments(): DocumentInfo[] {
    const rows = this.db
      .prepare(`SELECT * FROM documents ORDER BY updated_at DESC, source`)
      .all() as unknown as DocumentRow[];
    return rows.map(toDocument);
  }

  updateDocument(source: string, patch: DocumentMetadataPatch): DocumentInfo | null {
    const current = this.db
      .prepare(`SELECT * FROM documents WHERE source = ?`)
      .get(source) as unknown as DocumentRow | undefined;
    if (!current) return null;
    const title = patch.title ?? current.title;
    const tags = patch.tags ?? parseStringArray(current.tags_json);
    const allowedGroups =
      patch.allowedGroups ?? parseStringArray(current.allowed_groups_json ?? "[]");
    this.db
      .prepare(
        `UPDATE documents
         SET title = ?, tags_json = ?, allowed_groups_json = ?, updated_at = ?
         WHERE source = ?`,
      )
      .run(
        title,
        JSON.stringify(tags),
        JSON.stringify(allowedGroups),
        new Date().toISOString(),
        source,
      );
    const updated = this.db
      .prepare(`SELECT * FROM documents WHERE source = ?`)
      .get(source) as unknown as DocumentRow;
    return toDocument(updated);
  }

  countChunks(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as unknown as {
      n: number;
    };
    return row.n;
  }

  /**
   * 列出某来源的全部分块元信息，供"查看文件分块详情"使用。
   * 不返回向量二进制，hasEmbedding 用 boolean 标识。
   */
  listChunksBySource(source: string): ChunkInfo[] {
    const rows = this.db
      .prepare(
        `SELECT id, source, chunk_index, content,
                LENGTH(content) AS length, embedding IS NOT NULL AS has_embedding
         FROM chunks WHERE source = ? ORDER BY chunk_index`,
      )
      .all(source) as unknown as Array<{
      id: string;
      source: string;
      chunk_index: number;
      content: string;
      length: number;
      has_embedding: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      chunkIndex: r.chunk_index,
      content: r.content,
      length: r.length,
      hasEmbedding: Boolean(r.has_embedding),
    }));
  }

  /**
   * 按 id 批量回取真实分块（图谱关系回溯用）。
   * 来源白名单下推到 SQL：空数组直接返回 []，避免"不过滤"退化成越权读取。
   * 不保证返回顺序——调用方按自己的候选排名重排。
   */
  getChunksByIds(ids: readonly string[], sources?: readonly string[]): Chunk[] {
    if (ids.length === 0 || sources?.length === 0) return [];
    const rows: Array<{ id: string; source: string; chunk_index: number; content: string }> = [];
    // SQLite 绑定变量数有上限（旧版本 999），候选窗口很大时分批查，避免整批失败。
    const batchSize = 500;
    for (let start = 0; start < ids.length; start += batchSize) {
      const batch = ids.slice(start, start + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const sourceFilter = sources ? ` AND source IN (${sources.map(() => "?").join(", ")})` : "";
      const batchRows = this.db
        .prepare(
          `SELECT id, source, chunk_index, content FROM chunks
           WHERE id IN (${placeholders})${sourceFilter}`,
        )
        .all(...batch, ...(sources ?? [])) as unknown as Array<{
        id: string;
        source: string;
        chunk_index: number;
        content: string;
      }>;
      rows.push(...batchRows);
    }
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      chunkIndex: r.chunk_index,
      content: r.content,
    }));
  }

  close(): void {
    this.db.close();
  }

  private insertChunkRow(chunk: Chunk, embedding: Float32Array): void {
    const vector = embedding.length > 0 ? serializeF32(embedding) : null;
    const res = this.db
      .prepare(
        `INSERT INTO chunks (id, source, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(chunk.id, chunk.source, chunk.chunkIndex, chunk.content, vector);
    this.db
      .prepare(`INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)`)
      .run(Number(res.lastInsertRowid), addCjkSpacing(chunk.content));
  }

  private deleteSourceRows(source: string): void {
    this.db
      .prepare(`DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE source = ?)`)
      .run(source);
    this.db.prepare(`DELETE FROM chunks WHERE source = ?`).run(source);
  }

  /** documents 表由旧版本创建时，CREATE TABLE IF NOT EXISTS 不会补新增列。 */
  private ensureDocumentColumns(): void {
    const columns = this.db.prepare(`PRAGMA table_info(documents)`).all() as unknown as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("chunk_strategy")) {
      this.db.exec(`ALTER TABLE documents ADD COLUMN chunk_strategy TEXT NOT NULL DEFAULT 'fixed'`);
    }
    if (!names.has("semantic_threshold")) {
      this.db.exec(`ALTER TABLE documents ADD COLUMN semantic_threshold REAL`);
    }
    if (!names.has("allowed_groups_json")) {
      this.db.exec(
        `ALTER TABLE documents ADD COLUMN allowed_groups_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }
    if (!names.has("ocr_applied")) {
      this.db.exec(`ALTER TABLE documents ADD COLUMN ocr_applied INTEGER NOT NULL DEFAULT 0`);
    }
    if (!names.has("ocr_status")) {
      this.db.exec(`ALTER TABLE documents ADD COLUMN ocr_status TEXT NOT NULL DEFAULT 'none'`);
    }
  }

  /** 为升级前只有 chunks 表的数据库补齐目录，不改变原分块数据。 */
  private migrateLegacyDocuments(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO documents (
           source, title, tags_json, mime_type, byte_size, content_hash, chunk_count,
           version, chunk_strategy, chunk_size, chunk_overlap, separators_json,
           semantic_threshold, created_at, updated_at
         )
         SELECT source, source, '[]', 'application/octet-stream', 0, '', COUNT(*),
                1, 'fixed', 500, 50, '[]', NULL, ?, ?
         FROM chunks
         GROUP BY source
         ON CONFLICT(source) DO NOTHING`,
      )
      .run(now, now);
  }
}
