/**
 * 单条查询的审计回放：事件行 + 反馈 + trace 反序列化。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  QueryEventAttribution,
  QueryEventDetail,
  QueryFeedbackRating,
  RetrievalTrace,
} from "./types.js";

export function getQueryDetail(db: DatabaseSync, queryId: string): QueryEventDetail | null {
  const row = db
    .prepare(
      `SELECT q.id, q.query, q.source_filter_json, q.source_count, q.top_k, q.generate, q.crag,
              q.hit_count, q.answer_generated, q.attribution, q.crag_assessment, q.crag_actions_json,
              q.latency_ms, q.error, q.created_at, q.trace_json,
              f.rating, f.comment
       FROM rag_query_events q
       LEFT JOIN rag_query_feedback f ON f.query_id = q.id
       WHERE q.id = ?`,
    )
    .get(queryId) as unknown as
    | {
        id: string;
        query: string;
        source_filter_json: string;
        source_count: number;
        top_k: number;
        generate: number;
        crag: number;
        hit_count: number;
        answer_generated: number;
        attribution: QueryEventAttribution;
        crag_assessment: string | null;
        crag_actions_json: string;
        latency_ms: number;
        error: string | null;
        created_at: string;
        trace_json: string | null;
        rating: QueryFeedbackRating | null;
        comment: string | null;
      }
    | undefined;
  if (!row) return null;
  let sources: string[] = [];
  try {
    const parsed = JSON.parse(row.source_filter_json) as unknown;
    if (Array.isArray(parsed)) sources = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    sources = [];
  }
  let actions: string[] = [];
  try {
    const parsed = JSON.parse(row.crag_actions_json) as unknown;
    if (Array.isArray(parsed)) actions = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    actions = [];
  }
  let trace: RetrievalTrace | null = null;
  if (row.trace_json) {
    try {
      trace = JSON.parse(row.trace_json) as RetrievalTrace;
    } catch {
      trace = null;
    }
  }
  return {
    id: row.id,
    query: row.query,
    sources,
    sourceCount: Number(row.source_count ?? 0),
    topK: Number(row.top_k ?? 5),
    generate: row.generate === 1,
    crag: row.crag === 1,
    hitCount: Number(row.hit_count ?? 0),
    answerGenerated: row.answer_generated === 1,
    answer: trace?.answer ?? null,
    attribution: row.attribution,
    assessment: row.crag_assessment,
    actions,
    latencyMs: Number(row.latency_ms ?? 0),
    error: row.error,
    createdAt: row.created_at,
    feedback: row.rating,
    feedbackComment: row.comment,
    trace,
  };
}
