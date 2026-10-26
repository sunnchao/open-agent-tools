/**
 * 查询运营数据的对外门面。
 *
 * 内部按关注点拆成四个模块，但对外仍是同一个 `RagAnalyticsStore` 类：
 * 路由与 runtime 的调用点（`analytics.recordQuery(...)`、
 * `Pick<RagAnalyticsStore, "overview" | "qualityReport">`）无需感知拆分。
 *
 * - `store.ts`：写入与补列迁移
 * - `dashboard.ts`：概览与质量报告
 * - `replay.ts`：单条审计回放
 * - `types.ts`：对外类型
 */
import type { DatabaseSync } from "node:sqlite";
import type { QualityReport } from "./quality.js";
import { qualityReport as readQualityReport, overview as readOverview } from "./dashboard.js";
import { getQueryDetail as readQueryDetail } from "./replay.js";
import { openAnalyticsStore, recordQuery, saveFeedback } from "./store.js";
import type {
  AnalyticsOverview,
  QueryEventDetail,
  QueryEventInput,
  QueryFeedbackRating,
} from "./types.js";

export type {
  AnalyticsOverview,
  QueryEventAttribution,
  QueryEventDetail,
  QueryEventInput,
  QueryFeedbackRating,
  RetrievalTrace,
  RetrievalTraceChunk,
  RetrievalTraceHit,
} from "./types.js";

/** 产品内查询运营数据。Langfuse 负责模型 trace，此处只保存可治理的业务指标。 */
export class RagAnalyticsStore {
  private db: DatabaseSync;

  constructor(dbPath: string, retentionDays = 90) {
    this.db = openAnalyticsStore(dbPath, retentionDays);
  }

  recordQuery(input: QueryEventInput): void {
    recordQuery(this.db, input);
  }

  saveFeedback(
    queryId: string,
    rating: QueryFeedbackRating,
    comment?: string,
  ): { queryId: string; rating: QueryFeedbackRating; comment: string | null } | null {
    return saveFeedback(this.db, queryId, rating, comment);
  }

  overview(periodDays = 14): AnalyticsOverview {
    return readOverview(this.db, periodDays);
  }

  qualityReport(periodDays: 7 | 30): QualityReport {
    return readQualityReport(this.db, periodDays);
  }

  getQueryDetail(queryId: string): QueryEventDetail | null {
    return readQueryDetail(this.db, queryId);
  }

  close(): void {
    this.db.close();
  }
}
