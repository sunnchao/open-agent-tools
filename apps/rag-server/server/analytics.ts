import { DatabaseSync } from "node:sqlite";

export type QueryFeedbackRating = "positive" | "negative";

export interface QueryEventInput {
  id: string;
  query: string;
  sources?: string[];
  topK: number;
  generate: boolean;
  crag: boolean;
  hits: Array<{ source: string }>;
  answerGenerated: boolean;
  latencyMs: number;
  error?: string;
  createdAt?: string;
}

export interface AnalyticsOverview {
  periodDays: number;
  totals: {
    queries: number;
    failed: number;
    noHits: number;
    noHitRate: number;
    averageLatencyMs: number;
    positiveFeedback: number;
    negativeFeedback: number;
    helpfulRate: number | null;
  };
  daily: Array<{ date: string; queries: number; noHits: number; failed: number }>;
  topSources: Array<{ source: string; hits: number; queries: number }>;
  recent: Array<{
    id: string;
    query: string;
    hitCount: number;
    latencyMs: number;
    error: string | null;
    feedback: QueryFeedbackRating | null;
    createdAt: string;
  }>;
}

interface MetricsRow {
  queries: number;
  failed: number;
  no_hits: number;
  average_latency_ms: number | null;
}

interface FeedbackRow {
  positive: number;
  negative: number;
}

/** 产品内查询运营数据。Langfuse 负责模型 trace，此处只保存可治理的业务指标。 */
export class RagAnalyticsStore {
  private db: DatabaseSync;

  constructor(dbPath: string, retentionDays = 90) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_query_events (
        id                 TEXT PRIMARY KEY,
        query              TEXT NOT NULL,
        source_filter_json TEXT NOT NULL,
        top_k              INTEGER NOT NULL,
        generate           INTEGER NOT NULL,
        crag               INTEGER NOT NULL,
        hit_count          INTEGER NOT NULL,
        answer_generated   INTEGER NOT NULL,
        latency_ms         INTEGER NOT NULL,
        error              TEXT,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rag_query_events_created_at
        ON rag_query_events(created_at DESC);
      CREATE TABLE IF NOT EXISTS rag_query_hits (
        query_id TEXT NOT NULL REFERENCES rag_query_events(id) ON DELETE CASCADE,
        source   TEXT NOT NULL,
        hits     INTEGER NOT NULL,
        PRIMARY KEY (query_id, source)
      );
      CREATE INDEX IF NOT EXISTS idx_rag_query_hits_source ON rag_query_hits(source);
      CREATE TABLE IF NOT EXISTS rag_query_feedback (
        query_id   TEXT PRIMARY KEY REFERENCES rag_query_events(id) ON DELETE CASCADE,
        rating     TEXT NOT NULL CHECK (rating IN ('positive', 'negative')),
        comment    TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const days = Math.max(1, Math.min(3650, Math.floor(retentionDays) || 90));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare(`DELETE FROM rag_query_events WHERE created_at < ?`).run(cutoff);
  }

  recordQuery(input: QueryEventInput): void {
    const sourceHits = new Map<string, number>();
    for (const hit of input.hits) {
      if (!hit.source) continue;
      sourceHits.set(hit.source, (sourceHits.get(hit.source) ?? 0) + 1);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO rag_query_events (
             id, query, source_filter_json, top_k, generate, crag, hit_count,
             answer_generated, latency_ms, error, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.query,
          JSON.stringify(input.sources ?? []),
          input.topK,
          input.generate ? 1 : 0,
          input.crag ? 1 : 0,
          input.hits.length,
          input.answerGenerated ? 1 : 0,
          Math.max(0, Math.round(input.latencyMs)),
          input.error ?? null,
          input.createdAt ?? new Date().toISOString(),
        );
      const statement = this.db.prepare(
        `INSERT INTO rag_query_hits (query_id, source, hits) VALUES (?, ?, ?)`,
      );
      for (const [source, hits] of sourceHits) statement.run(input.id, source, hits);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveFeedback(
    queryId: string,
    rating: QueryFeedbackRating,
    comment?: string,
  ): { queryId: string; rating: QueryFeedbackRating; comment: string | null } | null {
    const event = this.db
      .prepare(`SELECT id FROM rag_query_events WHERE id = ?`)
      .get(queryId) as unknown as { id: string } | undefined;
    if (!event) return null;
    const now = new Date().toISOString();
    const normalizedComment = comment?.trim() || null;
    this.db
      .prepare(
        `INSERT INTO rag_query_feedback (query_id, rating, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(query_id) DO UPDATE SET
           rating = excluded.rating,
           comment = excluded.comment,
           updated_at = excluded.updated_at`,
      )
      .run(queryId, rating, normalizedComment, now, now);
    return { queryId, rating, comment: normalizedComment };
  }

  overview(periodDays = 14): AnalyticsOverview {
    const days = Math.max(1, Math.min(90, Math.floor(periodDays) || 14));
    const start = startOfUtcDay(Date.now() - (days - 1) * 86_400_000);
    const metrics = this.db
      .prepare(
        `SELECT
           COUNT(*) AS queries,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN error IS NULL AND hit_count = 0 THEN 1 ELSE 0 END) AS no_hits,
           AVG(latency_ms) AS average_latency_ms
         FROM rag_query_events WHERE created_at >= ?`,
      )
      .get(start) as unknown as MetricsRow;
    const feedback = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN f.rating = 'positive' THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN f.rating = 'negative' THEN 1 ELSE 0 END) AS negative
         FROM rag_query_feedback f
         JOIN rag_query_events q ON q.id = f.query_id
         WHERE q.created_at >= ?`,
      )
      .get(start) as unknown as FeedbackRow;
    const dailyRows = this.db
      .prepare(
        `SELECT
           substr(created_at, 1, 10) AS date,
           COUNT(*) AS queries,
           SUM(CASE WHEN error IS NULL AND hit_count = 0 THEN 1 ELSE 0 END) AS no_hits,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed
         FROM rag_query_events
         WHERE created_at >= ?
         GROUP BY substr(created_at, 1, 10)
         ORDER BY date`,
      )
      .all(start) as unknown as Array<{
      date: string;
      queries: number;
      no_hits: number;
      failed: number;
    }>;
    const dailyMap = new Map(dailyRows.map((row) => [row.date, row]));
    const daily = Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.parse(start) + index * 86_400_000).toISOString().slice(0, 10);
      const row = dailyMap.get(date);
      return {
        date,
        queries: row?.queries ?? 0,
        noHits: row?.no_hits ?? 0,
        failed: row?.failed ?? 0,
      };
    });
    const topSourceRows = this.db
      .prepare(
        `SELECT h.source, SUM(h.hits) AS hits, COUNT(*) AS queries
         FROM rag_query_hits h
         JOIN rag_query_events q ON q.id = h.query_id
         WHERE q.created_at >= ?
         GROUP BY h.source
         ORDER BY hits DESC, queries DESC, h.source
         LIMIT 8`,
      )
      .all(start) as unknown as Array<{ source: string; hits: number; queries: number }>;
    const recentRows = this.db
      .prepare(
        `SELECT q.id, q.query, q.hit_count, q.latency_ms, q.error, f.rating, q.created_at
         FROM rag_query_events q
         LEFT JOIN rag_query_feedback f ON f.query_id = q.id
         ORDER BY q.created_at DESC, q.rowid DESC
         LIMIT 20`,
      )
      .all() as unknown as Array<{
      id: string;
      query: string;
      hit_count: number;
      latency_ms: number;
      error: string | null;
      rating: QueryFeedbackRating | null;
      created_at: string;
    }>;
    const queries = Number(metrics.queries ?? 0);
    const failed = Number(metrics.failed ?? 0);
    const noHits = Number(metrics.no_hits ?? 0);
    const successful = Math.max(0, queries - failed);
    const positive = Number(feedback.positive ?? 0);
    const negative = Number(feedback.negative ?? 0);
    const rated = positive + negative;
    return {
      periodDays: days,
      totals: {
        queries,
        failed,
        noHits,
        noHitRate: successful > 0 ? noHits / successful : 0,
        averageLatencyMs: Math.round(Number(metrics.average_latency_ms ?? 0)),
        positiveFeedback: positive,
        negativeFeedback: negative,
        helpfulRate: rated > 0 ? positive / rated : null,
      },
      daily,
      topSources: topSourceRows.map((row) => ({
        source: row.source,
        hits: row.hits,
        queries: row.queries,
      })),
      recent: recentRows.map((row) => ({
        id: row.id,
        query: row.query,
        hitCount: row.hit_count,
        latencyMs: row.latency_ms,
        error: row.error,
        feedback: row.rating,
        createdAt: row.created_at,
      })),
    };
  }

  close(): void {
    this.db.close();
  }
}

function startOfUtcDay(time: number): string {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}
