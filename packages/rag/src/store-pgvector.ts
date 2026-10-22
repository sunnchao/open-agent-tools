/**
 * PostgreSQL + pgvector 版 VectorStore 实现。
 *
 * 与 `SqliteVectorStore` / `ElasticsearchVectorStore` 实现同一份 `VectorStore` 接口
 * （见 `types.ts`），调用方（`ingest.ts / retriever.ts / Rag` 门面）无需改动：
 *   - `<prefix>_chunks` 表：`id / source / chunk_index / content` + `embedding vector(dims)`，
 *     向量召回走 pgvector 的 `<=>` 余弦距离（HNSW 索引）；
 *   - `<prefix>_documents` 表：文档目录（标题/标签/ACL/版本/切分参数/OCR 标记），
 *     与 SQLite `documents` 表、ES `<prefix>-documents` 索引一一对应。
 *
 * 设计取舍（诚实声明）：
 * 1. `replaceSource` 用单条事务（`BEGIN … COMMIT`）包住「删旧分块 + 写新分块 + upsert 目录」，
 *    比 ES 的 delete_by_query + bulk 三步 best-effort 更接近原子；embedding 失败时旧版本保留。
 * 2. `vector.dims` 在建表时固定，换 embedding 模型必须先删表重建，否则写入会因维度不符报错。
 * 3. 关键词通道是本文件里的**朴素 ILIKE 兜底**：PostgreSQL 默认全文检索不支持中文分词，
 *    ILIKE 子串匹配召回稳定但排序只有「命中词数」一个信号。生产请用
 *    `HybridVectorStore`（向量走 PG、BM25 走 Elasticsearch），或给 PG 装 zhparser/pg_jieba
 *    后改写 `keywordSearch`。这里不假装它能替代 BM25。
 */
import { Pool, type PoolConfig } from "pg";
import type {
  Chunk,
  ChunkInfo,
  DocumentInfo,
  DocumentMetadataPatch,
  DocumentWriteMetadata,
  ScoredChunk,
  VectorStore,
} from "./types.js";

export interface PgVectorStoreOptions {
  /** PostgreSQL 连接串，如 `postgresql://postgres:postgres@localhost:5432/mcp_management`。 */
  connectionString?: string;
  /** 外部注入连接池（测试复用 / 应用侧已有池时用）；传入后 `close()` 不会关闭它。 */
  pool?: Pool;
  /** 透传给 `pg` 连接池的额外选项（ssl、max、statement_timeout 等）。 */
  poolOptions?: Omit<PoolConfig, "connectionString">;
  /**
   * 表名前缀，实际表为 `<prefix>_chunks` / `<prefix>_documents`，默认 `rag`。
   * 只允许字母、数字、下划线，避免 SQL 标识符注入。
   */
  tablePrefix?: string;
  /**
   * 向量维度。缺省 1536（`text-embedding-3-small`）。
   * 首次建表时若还没见过非空向量就用它；见过非空向量则以实际维度为准。
   * 表已建好且维度不同会直接抛错，需删表重建（见 README 的迁移说明）。
   */
  dims?: number;
  /** 距离度量，默认 `cosine`（与 ES 的 `similarity: cosine` 对齐）。 */
  metric?: "cosine" | "l2" | "inner_product";
  /** 是否自动执行 `CREATE EXTENSION IF NOT EXISTS vector`，默认 true。 */
  createExtension?: boolean;
  /** 是否自动建 HNSW 向量索引，默认 true；维度超限（>2000）时自动跳过并告警。 */
  createIndex?: boolean;
}

const DEFAULT_DIMS = 1536;
const INSERT_BATCH = 500;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 度量 → pgvector 距离算子 / 索引 opclass。 */
const METRICS = {
  cosine: { operator: "<=>", opclass: "vector_cosine_ops", name: "cosine" },
  l2: { operator: "<->", opclass: "vector_l2_ops", name: "l2" },
  inner_product: { operator: "<#>", opclass: "vector_ip_ops", name: "inner_product" },
} as const;

/** Float32Array / number[] → pgvector 字面量 `[1,2,3]`。 */
function toVectorLiteral(values: ArrayLike<number>): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; i += 1) parts.push(String(values[i] ?? 0));
  return `[${parts.join(",")}]`;
}

/** ILIKE 模式里的 `%` / `_` / `\` 需要转义，否则用户查询会被当成通配符。 */
function escapeLike(term: string): string {
  return term.replace(/([%_\\])/g, "\\$1");
}

/**
 * 把用户查询拆成 ILIKE 子串候选。
 *
 * 中文不做单字切分：`ILIKE '%中国%'` 比逐字匹配精确得多，召回下限交给向量通道兜。
 * 同时保留整条查询作为一个候选，覆盖「短语连续出现」这类高置信命中。
 */
export function buildPgKeywordTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const tokens = trimmed
    .split(/[\s,，。、;；:：!！?？()（）[\]{}"'`~@#$%^&*+=|\\/<>-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  // 纯标点查询会退化出 `%!!!%` 这类无意义模式，先滤掉不含字母/数字/汉字的候选。
  const meaningful = (value: string) => /[\p{L}\p{N}]/u.test(value);
  // 整条查询优先（命中即高相关），随后是拆词结果；去重保序。
  return [...new Set([trimmed, ...tokens])].filter(meaningful).slice(0, 16);
}

interface ChunkRow {
  id: string;
  source: string;
  chunk_index: number;
  content: string;
  score?: number;
}

interface DocumentRow {
  source: string;
  title: string;
  tags: unknown;
  allowed_groups: unknown;
  mime_type: string;
  byte_size: string | number;
  content_hash: string;
  chunk_count: number;
  version: number;
  chunk_strategy: string;
  chunk_size: number;
  chunk_overlap: number;
  separators: unknown;
  semantic_threshold: number | string | null;
  ocr_applied: boolean;
  ocr_status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toDocumentInfo(row: DocumentRow): DocumentInfo {
  const status = row.ocr_status as DocumentInfo["ocrStatus"];
  return {
    source: row.source,
    title: row.title,
    tags: toStringArray(row.tags),
    allowedGroups: toStringArray(row.allowed_groups),
    mimeType: row.mime_type ?? "application/octet-stream",
    byteSize: Number(row.byte_size ?? 0),
    contentHash: row.content_hash ?? "",
    chunks: Number(row.chunk_count ?? 0),
    version: Number(row.version ?? 1),
    chunkStrategy: row.chunk_strategy === "semantic" ? "semantic" : "fixed",
    chunkSize: Number(row.chunk_size ?? 500),
    chunkOverlap: Number(row.chunk_overlap ?? 50),
    separators: toStringArray(row.separators),
    semanticThreshold:
      row.semantic_threshold === null || row.semantic_threshold === undefined
        ? null
        : Number(row.semantic_threshold),
    ocrApplied: Boolean(row.ocr_applied),
    ocrStatus:
      status === "ocr" ||
      status === "ocr_needed" ||
      status === "ocr_failed" ||
      status === "text_layer"
        ? status
        : "none",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toScoredChunk(row: ChunkRow): ScoredChunk {
  return {
    id: row.id,
    source: row.source,
    chunkIndex: row.chunk_index,
    content: row.content,
    score: Number(row.score ?? 0),
  };
}

/**
 * PostgreSQL（pgvector）存储：实现 `VectorStore` 的异步版本。
 *
 * 所有写入都在事务里完成；`ensureSchema()` 幂等，首次访问自动建扩展、建表、建索引。
 */
export class PgVectorStore implements VectorStore {
  private pool: Pool;
  private owned: boolean;
  private tablePrefix: string;
  private chunksTable: string;
  private documentsTable: string;
  private dims: number;
  private metric: (typeof METRICS)[keyof typeof METRICS];
  private createExtension: boolean;
  private createIndex: boolean;
  private ready?: Promise<void>;

  constructor(opts: PgVectorStoreOptions = {}) {
    const prefix = (opts.tablePrefix ?? "rag").trim() || "rag";
    if (!IDENT_RE.test(prefix)) {
      throw new Error(
        `invalid tablePrefix "${prefix}": only letters, digits and underscore are allowed`,
      );
    }
    this.tablePrefix = prefix;
    this.chunksTable = `${prefix}_chunks`;
    this.documentsTable = `${prefix}_documents`;
    this.dims = opts.dims && opts.dims > 0 ? opts.dims : DEFAULT_DIMS;
    this.metric = METRICS[opts.metric ?? "cosine"];
    this.createExtension = opts.createExtension ?? true;
    this.createIndex = opts.createIndex ?? true;
    if (opts.pool) {
      this.pool = opts.pool;
      this.owned = false;
    } else {
      if (!opts.connectionString) {
        throw new Error("PgVectorStore requires either `connectionString` or an injected `pool`");
      }
      this.pool = new Pool({ connectionString: opts.connectionString, ...(opts.poolOptions ?? {}) });
      this.owned = true;
    }
  }

  /** 实际表名，便于运维排查（健康检查 / 文档里展示）。 */
  get tables(): { chunks: string; documents: string } {
    return { chunks: this.chunksTable, documents: this.documentsTable };
  }

  /** 当前生效的向量维度（首写时可能由实际向量长度覆盖）。 */
  get dimensions(): number {
    return this.dims;
  }

  /** 连通性探测：连接池可用且能执行查询即视为健康。 */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /** 幂等建扩展 / 建表 / 建索引；并发调用共享同一个 Promise。 */
  async ensureSchema(): Promise<void> {
    this.ready ??= this.createSchema();
    return this.ready;
  }

  private async createSchema(): Promise<void> {
    if (this.createExtension) {
      await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.chunksTable} (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content     TEXT NOT NULL,
        embedding   vector(${this.dims}),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.chunksTable}_source_idx ON ${this.chunksTable}(source)`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.documentsTable} (
        source             TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        tags               JSONB NOT NULL DEFAULT '[]'::jsonb,
        allowed_groups     JSONB NOT NULL DEFAULT '[]'::jsonb,
        mime_type          TEXT NOT NULL DEFAULT 'application/octet-stream',
        byte_size          BIGINT NOT NULL DEFAULT 0,
        content_hash       TEXT NOT NULL DEFAULT '',
        chunk_count        INTEGER NOT NULL DEFAULT 0,
        version            INTEGER NOT NULL DEFAULT 1,
        chunk_strategy     TEXT NOT NULL DEFAULT 'fixed',
        chunk_size         INTEGER NOT NULL DEFAULT 500,
        chunk_overlap      INTEGER NOT NULL DEFAULT 50,
        separators         JSONB NOT NULL DEFAULT '[]'::jsonb,
        semantic_threshold DOUBLE PRECISION,
        ocr_applied        BOOLEAN NOT NULL DEFAULT false,
        ocr_status         TEXT NOT NULL DEFAULT 'none',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.documentsTable}_updated_idx ON ${this.documentsTable}(updated_at DESC)`,
    );

    // 表可能是上一个维度建的：维度不一致时必须显式报错，否则写入会得到晦涩的 pgvector 报错。
    const dims = await this.existingDims();
    if (dims !== null && dims > 0 && dims !== this.dims) {
      throw new Error(
        `${this.chunksTable}.embedding has dims=${dims} but store was configured with dims=${this.dims}; ` +
          `drop the table and re-ingest, or set RAG_PG_DIMS=${dims}`,
      );
    }

    if (this.createIndex) {
      try {
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS ${this.chunksTable}_embedding_idx ` +
            `ON ${this.chunksTable} USING hnsw (embedding ${this.metric.opclass})`,
        );
      } catch (error) {
        // HNSW 对维度有上限（vector 类型 2000），超限退化顺序扫描仍然可用，不阻塞写入。
        console.warn(
          `[rag] pgvector HNSW index unavailable on ${this.chunksTable}, falling back to sequential scan: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** 读取已存在表的向量维度；表不存在或未声明维度时返回 null。 */
  private async existingDims(): Promise<number | null> {
    const res = await this.pool.query<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute
        WHERE attrelid = to_regclass($1) AND attname = 'embedding' AND NOT attisdropped`,
      [this.chunksTable],
    );
    const typmod = res.rows[0]?.atttypmod;
    return typeof typmod === "number" ? typmod : null;
  }

  /** 测试/重建用：删掉两张表与索引（维度变更时必须走这里）。 */
  async destroyTables(): Promise<void> {
    await this.pool.query(`DROP TABLE IF EXISTS ${this.chunksTable}`);
    await this.pool.query(`DROP TABLE IF EXISTS ${this.documentsTable}`);
    this.ready = undefined;
  }

  private async ensure(): Promise<void> {
    if (!this.ready) await this.ensureSchema();
    await this.ready;
  }

  async insert(chunk: Chunk, embedding: Float32Array): Promise<void> {
    if (embedding.length > 0 && !this.ready) this.dims = embedding.length;
    await this.ensure();
    const now = new Date();
    await this.pool.query(
      `INSERT INTO ${this.chunksTable} (id, source, chunk_index, content, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         chunk_index = EXCLUDED.chunk_index,
         embedding = EXCLUDED.embedding`,
      [
        chunk.id,
        chunk.source,
        chunk.chunkIndex,
        chunk.content,
        embedding.length > 0 ? toVectorLiteral(embedding) : null,
      ],
    );
    await this.pool.query(
      `INSERT INTO ${this.documentsTable} (source, title, chunk_count, created_at, updated_at)
       VALUES ($1, $1, 1, $2, $2)
       ON CONFLICT (source) DO UPDATE SET
         chunk_count = (SELECT count(*) FROM ${this.chunksTable} WHERE source = EXCLUDED.source),
         updated_at = EXCLUDED.updated_at`,
      [chunk.source, now],
    );
  }

  /**
   * 事务内替换来源：删旧分块 → 写新分块 → upsert 目录。
   * 任意一步失败整体回滚，旧版本仍然可检索。
   */
  async replaceSource(
    source: string,
    rows: Array<{ chunk: Chunk; embedding: Float32Array }>,
    metadata: DocumentWriteMetadata,
  ): Promise<void> {
    const firstVector = rows.find((row) => row.embedding.length > 0)?.embedding;
    // 首次建表前允许按实际向量长度定维度（与 ES 实现的行为一致）。
    if (firstVector && !this.ready) this.dims = firstVector.length;
    await this.ensure();

    const now = new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.chunksTable} WHERE source = $1`, [source]);

      for (let start = 0; start < rows.length; start += INSERT_BATCH) {
        const batch = rows.slice(start, start + INSERT_BATCH);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        batch.forEach(({ chunk, embedding }, index) => {
          const base = index * 5;
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector)`);
          values.push(
            chunk.id,
            chunk.source,
            chunk.chunkIndex,
            chunk.content,
            embedding.length > 0 ? toVectorLiteral(embedding) : null,
          );
        });
        await client.query(
          `INSERT INTO ${this.chunksTable} (id, source, chunk_index, content, embedding)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (id) DO UPDATE SET
             source = EXCLUDED.source,
             chunk_index = EXCLUDED.chunk_index,
             content = EXCLUDED.content,
             embedding = EXCLUDED.embedding`,
          values,
        );
      }

      // 目录：title / tags / allowed_groups 属于人工运营数据，重传不覆盖（与 SQLite/ES 一致）。
      await client.query(
        `INSERT INTO ${this.documentsTable} (
           source, title, tags, allowed_groups, mime_type, byte_size, content_hash, chunk_count,
           version, chunk_strategy, chunk_size, chunk_overlap, separators,
           semantic_threshold, ocr_applied, ocr_status, created_at, updated_at
         ) VALUES (
           $1, $1, '[]'::jsonb, '[]'::jsonb, $2, $3, $4, $5,
           1, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $13
         )
         ON CONFLICT (source) DO UPDATE SET
           mime_type = EXCLUDED.mime_type,
           byte_size = EXCLUDED.byte_size,
           content_hash = EXCLUDED.content_hash,
           chunk_count = EXCLUDED.chunk_count,
           version = ${this.documentsTable}.version + 1,
           chunk_strategy = EXCLUDED.chunk_strategy,
           chunk_size = EXCLUDED.chunk_size,
           chunk_overlap = EXCLUDED.chunk_overlap,
           separators = EXCLUDED.separators,
           semantic_threshold = EXCLUDED.semantic_threshold,
           ocr_applied = EXCLUDED.ocr_applied,
           ocr_status = EXCLUDED.ocr_status,
           updated_at = EXCLUDED.updated_at`,
        [
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
          metadata.ocrApplied ?? false,
          metadata.ocrStatus ?? "none",
          now,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async vectorSearch(
    embedding: number[],
    k: number,
    sources?: readonly string[],
  ): Promise<ScoredChunk[]> {
    if (sources?.length === 0) return [];
    if (embedding.length === 0) return [];
    if (embedding.length !== this.dims) {
      throw new Error(
        `query embedding has dims=${embedding.length} but ${this.chunksTable}.embedding expects ${this.dims}; ` +
          `check the embedding model against RAG_PG_DIMS`,
      );
    }
    await this.ensure();
    const operator = this.metric.operator;
    const similarity = this.metric.name === "inner_product" ? null : `1 - (embedding ${operator} $1::vector)`;
    const scoreExpr =
      similarity ?? `-(embedding ${operator} $1::vector)`; /* inner_product：距离取负即相似度 */
    const params: unknown[] = [toVectorLiteral(embedding), k];
    const sourceFilter = sources ? ` AND source = ANY($3::text[])` : "";
    if (sources) params.push([...sources]);
    const res = await this.pool.query<ChunkRow>(
      `SELECT id, source, chunk_index, content, ${scoreExpr} AS score
         FROM ${this.chunksTable}
        WHERE embedding IS NOT NULL${sourceFilter}
        ORDER BY embedding ${operator} $1::vector
        LIMIT $2`,
      params,
    );
    return res.rows.map(toScoredChunk);
  }

  /**
   * 关键词检索（ILIKE 兜底，非 BM25）。
   *
   * 先按「整条查询」+「拆词」构造子串候选，命中词数多的排前面；
   * 需要真正的 BM25 请用 `HybridVectorStore` 把该通道交给 Elasticsearch。
   */
  async keywordSearch(
    query: string,
    k: number,
    sources?: readonly string[],
  ): Promise<ScoredChunk[]> {
    if (sources?.length === 0) return [];
    const terms = buildPgKeywordTerms(query);
    if (terms.length === 0) return [];
    await this.ensure();
    const patterns = terms.map((term) => `%${escapeLike(term)}%`);
    const params: unknown[] = [patterns, k];
    const sourceFilter = sources ? ` AND c.source = ANY($3::text[])` : "";
    if (sources) params.push([...sources]);
    const res = await this.pool.query<ChunkRow>(
      `SELECT c.id, c.source, c.chunk_index, c.content,
              (SELECT count(*) FROM unnest($1::text[]) AS t(pattern)
                WHERE c.content ILIKE t.pattern) AS score
         FROM ${this.chunksTable} c
        WHERE c.content ILIKE ANY($1::text[])${sourceFilter}
        ORDER BY score DESC, c.chunk_index ASC
        LIMIT $2`,
      params,
    );
    return res.rows.map((row) => toScoredChunk({ ...row, score: Number(row.score ?? 0) }));
  }

  async removeBySource(source: string): Promise<void> {
    await this.ensure();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.chunksTable} WHERE source = $1`, [source]);
      await client.query(`DELETE FROM ${this.documentsTable} WHERE source = $1`, [source]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listSources(): Promise<string[]> {
    await this.ensure();
    const res = await this.pool.query<{ source: string }>(
      `SELECT source FROM ${this.documentsTable} ORDER BY source`,
    );
    return res.rows.map((row) => row.source);
  }

  async listDocuments(): Promise<DocumentInfo[]> {
    await this.ensure();
    const res = await this.pool.query<DocumentRow>(
      `SELECT * FROM ${this.documentsTable} ORDER BY updated_at DESC, source ASC`,
    );
    return res.rows.map(toDocumentInfo);
  }

  async updateDocument(source: string, patch: DocumentMetadataPatch): Promise<DocumentInfo | null> {
    await this.ensure();
    const current = await this.getDocumentRow(source);
    if (!current) return null;
    const title = patch.title ?? current.title;
    const tags = patch.tags ? [...patch.tags] : toStringArray(current.tags);
    const allowedGroups = patch.allowedGroups
      ? [...patch.allowedGroups]
      : toStringArray(current.allowed_groups);
    const res = await this.pool.query<DocumentRow>(
      `UPDATE ${this.documentsTable}
          SET title = $1, tags = $2::jsonb, allowed_groups = $3::jsonb, updated_at = now()
        WHERE source = $4
        RETURNING *`,
      [title, JSON.stringify(tags), JSON.stringify(allowedGroups), source],
    );
    const row = res.rows[0];
    return row ? toDocumentInfo(row) : null;
  }

  async countChunks(): Promise<number> {
    await this.ensure();
    const res = await this.pool.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM ${this.chunksTable}`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async listChunksBySource(source: string): Promise<ChunkInfo[]> {
    await this.ensure();
    const res = await this.pool.query<{
      id: string;
      source: string;
      chunk_index: number;
      content: string;
      length: number;
      has_embedding: boolean;
    }>(
      `SELECT id, source, chunk_index, content,
              length(content) AS length, (embedding IS NOT NULL) AS has_embedding
         FROM ${this.chunksTable}
        WHERE source = $1
        ORDER BY chunk_index ASC`,
      [source],
    );
    return res.rows.map((row) => ({
      id: row.id,
      source: row.source,
      chunkIndex: row.chunk_index,
      content: row.content,
      length: Number(row.length ?? 0),
      hasEmbedding: Boolean(row.has_embedding),
    }));
  }

  /**
   * 按 id 批量回取真实分块（图谱关系回溯用）。
   * 来源白名单在 SQL 阶段下推；空数组直接返回 []，避免退化成越权读取。
   */
  async getChunksByIds(ids: readonly string[], sources?: readonly string[]): Promise<Chunk[]> {
    if (ids.length === 0 || sources?.length === 0) return [];
    await this.ensure();
    const params: unknown[] = [[...ids]];
    const sourceFilter = sources ? ` AND source = ANY($2::text[])` : "";
    if (sources) params.push([...sources]);
    const res = await this.pool.query<{
      id: string;
      source: string;
      chunk_index: number;
      content: string;
    }>(
      `SELECT id, source, chunk_index, content
         FROM ${this.chunksTable}
        WHERE id = ANY($1::text[])${sourceFilter}`,
      params,
    );
    return res.rows.map((row) => ({
      id: row.id,
      source: row.source,
      chunkIndex: row.chunk_index,
      content: row.content,
    }));
  }

  async close(): Promise<void> {
    if (this.owned) await this.pool.end();
  }

  private async getDocumentRow(source: string): Promise<DocumentRow | null> {
    const res = await this.pool.query<DocumentRow>(
      `SELECT * FROM ${this.documentsTable} WHERE source = $1`,
      [source],
    );
    return res.rows[0] ?? null;
  }
}
