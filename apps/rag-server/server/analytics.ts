import { DatabaseSync } from "node:sqlite";
import {
  deriveQueryAttribution,
  NO_ANSWER_ATTRIBUTIONS,
  type NoAnswerAttributionValue,
  type QualityReport,
  type QueryEventAttribution,
} from "./quality.js";

export type QueryFeedbackRating = "positive" | "negative";
export type { QueryEventAttribution } from "./quality.js";

export interface QueryEventInput {
  id: string;
  query: string;
  sources?: string[];
  sourceCount: number;
  topK: number;
  generate: boolean;
  crag: boolean;
  hits: Array<{ source: string }>;
  answerGenerated: boolean;
  answer?: string | null;
  assessment?: "correct" | "ambiguous" | "incorrect";
  actions?: string[];
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
    attribution: QueryEventAttribution;
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
        id                  TEXT PRIMARY KEY,
        query               TEXT NOT NULL,
        source_filter_json  TEXT NOT NULL,
        source_count        INTEGER NOT NULL DEFAULT 0,
        top_k               INTEGER NOT NULL,
        generate            INTEGER NOT NULL,
        crag                INTEGER NOT NULL,
        hit_count           INTEGER NOT NULL,
        answer_generated    INTEGER NOT NULL,
        attribution         TEXT NOT NULL DEFAULT 'unknown',
        crag_assessment     TEXT,
        crag_actions_json   TEXT NOT NULL DEFAULT '[]',
        latency_ms          INTEGER NOT NULL,
        error               TEXT,
        created_at          TEXT NOT NULL
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
    this.migrateQueryEvents();
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
    const attribution = deriveQueryAttribution({
      error: input.error,
      crag: input.crag,
      generate: input.generate,
      hits: input.hits.length,
      sourceCount: input.sourceCount,
      answerGenerated: input.answerGenerated,
      answer: input.answer ?? null,
      generationAttempted: input.generate && input.hits.length > 0,
      assessment: input.assessment,
      actions: input.actions,
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO rag_query_events (
             id, query, source_filter_json, source_count, top_k, generate, crag, hit_count,
             answer_generated, attribution, crag_assessment, crag_actions_json,
             latency_ms, error, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.query,
          JSON.stringify(input.sources ?? []),
          Math.max(0, Math.round(input.sourceCount)),
          input.topK,
          input.generate ? 1 : 0,
          input.crag ? 1 : 0,
          input.hits.length,
          input.answerGenerated ? 1 : 0,
          attribution,
          input.assessment ?? null,
          JSON.stringify(input.actions ?? []),
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
        `SELECT q.id, q.query, q.hit_count, q.latency_ms, q.error, q.attribution,
                f.rating, q.created_at
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
      attribution: QueryEventAttribution;
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
        attribution: row.attribution,
        createdAt: row.created_at,
      })),
    };
  }

  qualityReport(periodDays: 7 | 30): QualityReport {
    const start = startOfUtcDay(Date.now() - (periodDays - 1) * 86_400_000);
    const attributionRows = this.db
      .prepare(
        `SELECT attribution, COUNT(*) AS count
         FROM rag_query_events
         WHERE created_at >= ?
         GROUP BY attribution`,
      )
      .all(start) as unknown as Array<{ attribution: QueryEventAttribution; count: number }>;
    const attribution: QualityReport["attribution"] = {
      answered: 0,
      no_documents: 0,
      retrieval_miss: 0,
      low_relevance: 0,
      model_refusal: 0,
      error: 0,
      unknown: 0,
    };
    let queries = 0;
    for (const row of attributionRows) {
      const count = Number(row.count ?? 0);
      queries += count;
      if (row.attribution in attribution) {
        attribution[row.attribution] += count;
      } else {
        attribution.unknown += count;
      }
    }
    const answered = attribution.answered;
    const noAnswer = NO_ANSWER_ATTRIBUTIONS.reduce((sum, value) => sum + attribution[value], 0);
    const hitRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM rag_query_events
         WHERE created_at >= ? AND hit_count > 0`,
      )
      .get(start) as unknown as { count: number };
    const hits = Number(hitRow.count ?? 0);
    const topRows = this.db
      .prepare(
        `SELECT query, attribution, COUNT(*) AS count
         FROM rag_query_events
         WHERE created_at >= ? AND attribution IN (${NO_ANSWER_ATTRIBUTIONS.map(() => "?").join(", ")})
         GROUP BY query, attribution
         ORDER BY count DESC, MAX(created_at) DESC, query
         LIMIT 10`,
      )
      .all(start, ...NO_ANSWER_ATTRIBUTIONS) as unknown as Array<{
      query: string;
      attribution: NoAnswerAttributionValue;
      count: number;
    }>;
    const trendRows = this.db
      .prepare(
        `SELECT
           substr(created_at, 1, 10) AS date,
           COUNT(*) AS queries,
           SUM(CASE WHEN attribution = 'answered' THEN 1 ELSE 0 END) AS answered,
           SUM(CASE WHEN attribution IN (${NO_ANSWER_ATTRIBUTIONS.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS no_answer,
           SUM(CASE WHEN hit_count > 0 THEN 1 ELSE 0 END) AS hits
         FROM rag_query_events
         WHERE created_at >= ?
         GROUP BY substr(created_at, 1, 10)
         ORDER BY date`,
      )
      .all(...NO_ANSWER_ATTRIBUTIONS, start) as unknown as Array<{
      date: string;
      queries: number;
      answered: number;
      no_answer: number;
      hits: number;
    }>;
    const trendMap = new Map(trendRows.map((row) => [row.date, row]));
    const trend = Array.from({ length: periodDays }, (_, index) => {
      const date = new Date(Date.parse(start) + index * 86_400_000).toISOString().slice(0, 10);
      const row = trendMap.get(date);
      const dailyAnswered = Number(row?.answered ?? 0);
      const dailyNoAnswer = Number(row?.no_answer ?? 0);
      const dailyQueries = Number(row?.queries ?? 0);
      const dailyHits = Number(row?.hits ?? 0);
      return {
        date,
        queries: dailyQueries,
        answered: dailyAnswered,
        noAnswer: dailyNoAnswer,
        hitRate: dailyQueries > 0 ? dailyHits / dailyQueries : 0,
        noAnswerRate: dailyQueries > 0 ? dailyNoAnswer / dailyQueries : 0,
      };
    });
    return {
      periodDays,
      generatedAt: new Date().toISOString(),
      totals: {
        queries,
        answered,
        hits,
        noAnswer,
        hitRate: queries > 0 ? hits / queries : 0,
        noAnswerRate: queries > 0 ? noAnswer / queries : 0,
      },
      attribution,
      topUnanswered: topRows.map((row) => ({
        query: row.query,
        count: Number(row.count ?? 0),
        attribution: row.attribution,
      })),
      trend,
    };
  }

  close(): void {
    this.db.close();
  }

  /** 兼容已有 SQLite：旧事件没有可回溯的判定，只能标记为 unknown。 */
  private migrateQueryEvents(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(rag_query_events)").all() as unknown as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    const migrations = [
      [
        "source_count",
        "ALTER TABLE rag_query_events ADD COLUMN source_count INTEGER NOT NULL DEFAULT 0",
      ],
      [
        "attribution",
        "ALTER TABLE rag_query_events ADD COLUMN attribution TEXT NOT NULL DEFAULT 'unknown'",
      ],
      ["crag_assessment", "ALTER TABLE rag_query_events ADD COLUMN crag_assessment TEXT"],
      [
        "crag_actions_json",
        "ALTER TABLE rag_query_events ADD COLUMN crag_actions_json TEXT NOT NULL DEFAULT '[]'",
      ],
    ] as const;
    for (const [column, sql] of migrations) {
      if (!columns.has(column)) this.db.exec(sql);
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_rag_query_events_attribution ON rag_query_events(attribution)",
    );
  }
}

function startOfUtcDay(time: number): string {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}
