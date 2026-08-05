import { DatabaseSync } from "node:sqlite";
import type { Chunk, ChunkInfo, ScoredChunk, VectorStore } from "./types.js";
import { addCjkSpacing, cosine, deserializeF32, escapeFtsQuery, escapeFtsQueryOr, serializeF32 } from "./utils.js";

export interface SqliteStoreOptions {
  /** SQLite 数据库文件路径，如 "./rag.db"。 */
  dbPath: string;
}

interface ChunkRow {
  rowid: number;
  id: string;
  source: string;
  chunk_index: number;
  content: string;
  embedding: Uint8Array;
}

function toChunk(r: ChunkRow): Chunk {
  return { id: r.id, source: r.source, chunkIndex: r.chunk_index, content: r.content };
}

/**
 * SQLite + FTS5 存储实现（路线 A）：
 * - `chunks` 表存原文与向量（Float32 BLOB），整数 rowid 与 FTS 表关联；
 * - `chunks_fts` 是独立 FTS5 虚拟表，索引 CJK 单字分词后的文本，提供 BM25 检索；
 * - 向量检索为暴力余弦 kNN（文档量 < 10 万 chunk 时毫秒级可接受）。
 */
export class SqliteVectorStore implements VectorStore {
  private db: DatabaseSync;

  constructor(opts: SqliteStoreOptions) {
    this.db = new DatabaseSync(opts.dbPath);
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
    `);
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
  }

  vectorSearch(embedding: number[], k: number): ScoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT rowid, id, source, chunk_index, content, embedding FROM chunks
         WHERE embedding IS NOT NULL`,
      )
      .all() as unknown as ChunkRow[];
    const q = Float32Array.from(embedding);
    return rows
      .map((r) => ({ chunk: toChunk(r), score: cosine(q, deserializeF32(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((e) => ({ ...e.chunk, score: e.score }));
  }

  /**
   * BM25 关键词检索。query 为原始用户查询（内部做 CJK 切分与转义）：
   * 先 AND 精确匹配；无结果时自动降级为 OR，避免口语化查询（含"怎么办/如何"等）全军覆没。
   */
  keywordSearch(query: string, k: number): ScoredChunk[] {
    const andQuery = escapeFtsQuery(query);
    const and = this.matchQuery(andQuery, k);
    if (and.length > 0) return and;
    const orQuery = escapeFtsQueryOr(query);
    return orQuery ? this.matchQuery(orQuery, k) : [];
  }

  private matchQuery(query: string, k: number): ScoredChunk[] {
    if (!query.trim()) return [];
    const rows = this.db
      .prepare(
        `SELECT c.rowid, c.id, c.source, c.chunk_index, c.content,
                bm25(chunks_fts) AS score
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(query, k) as unknown as Array<ChunkRow & { score: number }>;
    // SQLite bm25() 返回负数，越大（越接近 0）越相关；取绝对值便于展示。
    return rows.map((r) => ({ ...toChunk(r), score: Math.abs(r.score) }));
  }

  removeBySource(source: string): void {
    this.db
      .prepare(
        `DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE source = ?)`,
      )
      .run(source);
    this.db.prepare(`DELETE FROM chunks WHERE source = ?`).run(source);
  }

  listSources(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT source FROM chunks ORDER BY source`)
      .all() as unknown as Array<{ source: string }>;
    return rows.map((r) => r.source);
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

  close(): void {
    this.db.close();
  }
}
