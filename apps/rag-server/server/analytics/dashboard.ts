/**
 * 运营看板聚合：概览与质量报告。
 *
 * 全部为只读查询，不做写入，也不持有连接。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  NO_ANSWER_ATTRIBUTIONS,
  type NoAnswerAttributionValue,
  type QualityReport,
} from "./quality.js";
import type {
  AnalyticsOverview,
  FeedbackRow,
  MetricsRow,
  QueryEventAttribution,
  QueryFeedbackRating,
} from "./types.js";

export function overview(db: DatabaseSync, periodDays = 14): AnalyticsOverview {
  const days = Math.max(1, Math.min(90, Math.floor(periodDays) || 14));
  const start = startOfUtcDay(Date.now() - (days - 1) * 86_400_000);
  const metrics = db
    .prepare(
      `SELECT
         COUNT(*) AS queries,
         SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN error IS NULL AND hit_count = 0 THEN 1 ELSE 0 END) AS no_hits,
         AVG(latency_ms) AS average_latency_ms
       FROM rag_query_events WHERE created_at >= ?`,
    )
    .get(start) as unknown as MetricsRow;
  const feedback = db
    .prepare(
      `SELECT
         SUM(CASE WHEN f.rating = 'positive' THEN 1 ELSE 0 END) AS positive,
         SUM(CASE WHEN f.rating = 'negative' THEN 1 ELSE 0 END) AS negative
       FROM rag_query_feedback f
       JOIN rag_query_events q ON q.id = f.query_id
       WHERE q.created_at >= ?`,
    )
    .get(start) as unknown as FeedbackRow;
  const dailyRows = db
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
  const topSourceRows = db
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
  const recentRows = db
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

export function qualityReport(db: DatabaseSync, periodDays: 7 | 30): QualityReport {
  const start = startOfUtcDay(Date.now() - (periodDays - 1) * 86_400_000);
  const attributionRows = db
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
  const hitRow = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM rag_query_events
       WHERE created_at >= ? AND hit_count > 0`,
    )
    .get(start) as unknown as { count: number };
  const hits = Number(hitRow.count ?? 0);
  const topRows = db
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
  const trendRows = db
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

export function startOfUtcDay(time: number): string {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}
