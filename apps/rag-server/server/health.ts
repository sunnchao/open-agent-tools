import { Router, type Request, type Response } from "express";

/**
 * 知识库存储后端。
 * - `sqlite`：单文件零运维（离线/测试）；
 * - `pgvector`：PostgreSQL + pgvector 存向量与目录（生产默认）；
 * - `elasticsearch`：单 ES 同时承载向量与关键词（旧行为，保留兼容）。
 * 混合部署（PG 向量 + ES 关键词）对外仍报 `pgvector`，用 `keywordStore` 标明关键词通道。
 */
export type StoreKind = "sqlite" | "pgvector" | "elasticsearch";

/** `/api/health` 的响应体：集中定义，避免生产入口与测试各自手写字段导致漂移。 */
export interface HealthPayloadOptions {
  storeKind: StoreKind;
  /** 关键词（BM25）通道的落地存储；与 `storeKind` 相同或未启用关键词通道时省略。 */
  keywordStore?: StoreKind;
  embeddingsEnabled: boolean;
  llmAvailable: boolean;
  ocrEnabled: boolean;
  ocrMinCharsPerPage: number;
  ocrMaxPagesSync: number;
  /** 图谱是否作为检索第三路参与 /api/query（RAG_GRAPH_RETRIEVAL 全局开关）。 */
  graphRetrieval: boolean;
}

export function healthPayload(options: HealthPayloadOptions): Record<string, unknown> {
  return {
    ok: true,
    store: options.storeKind,
    ...(options.keywordStore ? { keywordStore: options.keywordStore } : {}),
    embeddingsEnabled: options.embeddingsEnabled,
    llmAvailable: options.llmAvailable,
    ocrEnabled: options.ocrEnabled,
    ocrMinCharsPerPage: options.ocrMinCharsPerPage,
    ocrMaxPagesSync: options.ocrMaxPagesSync,
    graphRetrieval: options.graphRetrieval,
  };
}

/** 健康检查无需鉴权，便于探针与 BFF 在服务 token 未配置时仍能探测能力开关。 */
export function healthRouter(options: HealthPayloadOptions): Router {
  const router: Router = Router();
  router.get("/health", (_req: Request, res: Response) => {
    res.json(healthPayload(options));
  });
  return router;
}
