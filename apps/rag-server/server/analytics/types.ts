/**
 * 查询运营数据的对外类型。
 *
 * 写入契约（`QueryEventInput`）与读取契约（`QueryEventDetail`、`AnalyticsOverview`）
 * 都在这里，路由与 store 共用同一份定义，避免各写一份导致字段漂移。
 */
import type { QueryEventAttribution } from "./quality.js";

export type QueryFeedbackRating = "positive" | "negative";
export type { QueryEventAttribution } from "./quality.js";

export interface RetrievalTraceHit {
  id: string;
  source: string;
  chunkIndex: number;
  content: string;
  score: number;
  rank: number;
}

export interface RetrievalTraceChunk extends RetrievalTraceHit {
  vectorScore: number | null;
  vectorRank: number | null;
  keywordScore: number | null;
  keywordRank: number | null;
  /** 图谱第三路的原始分/排名；未命中为 null（旧 trace 无此字段）。 */
  graphScore?: number | null;
  graphRank?: number | null;
  rrfScore: number;
  channels: Array<"vector" | "keyword" | "graph">;
}

/**
 * 完整检索链路：审计详情按 queryId 回放的唯一数据源。候选 content 截断存，融合块存全量。
 * graph* 均为可选：旧 trace_json 反序列化后没有这些键，读取方不得假设它们存在。
 */
export interface RetrievalTrace {
  store: string;
  embeddingsEnabled: boolean;
  candidates: number;
  rrfK: number;
  timingsMs: {
    vectorMs: number | null;
    keywordMs: number;
    fusionMs: number;
    graphMs?: number | null;
  };
  visibleSources?: string[];
  viewerGroups?: string[];
  vectorHits: RetrievalTraceHit[];
  keywordHits: RetrievalTraceHit[];
  /** 关键词通道是否启用；仅「仅向量」模式写 false，旧 trace 缺省视为启用。 */
  keywordEnabled?: boolean;
  /** 图谱通道候选（融合前）；未启用/旧 trace 缺省。 */
  graphHits?: RetrievalTraceHit[];
  graphEnabled?: boolean;
  /** 图谱子图序列化文本（prompt 增强用），超长已截断。 */
  graphContext?: string | null;
  fused: RetrievalTraceChunk[];
  formatted?: string | null;
  answer?: string | null;
  truncated: boolean;
}

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
  /** 完整链路明细：有则持久化到 trace_json，审计详情回放用。 */
  trace?: RetrievalTrace | null;
}

export interface QueryEventDetail {
  id: string;
  query: string;
  sources: string[];
  sourceCount: number;
  topK: number;
  generate: boolean;
  crag: boolean;
  hitCount: number;
  answerGenerated: boolean;
  answer: string | null;
  attribution: QueryEventAttribution;
  assessment: string | null;
  actions: string[];
  latencyMs: number;
  error: string | null;
  createdAt: string;
  feedback: QueryFeedbackRating | null;
  feedbackComment: string | null;
  trace: RetrievalTrace | null;
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

export interface MetricsRow {
  queries: number;
  failed: number;
  no_hits: number;
  average_latency_ms: number | null;
}

export interface FeedbackRow {
  positive: number;
  negative: number;
}
