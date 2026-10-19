import { Router, type Request, type Response } from "express";
import type { RagAnalyticsStore } from "./analytics.js";

export interface QualityReportRouterOptions {
  analytics: Pick<RagAnalyticsStore, "qualityReport">;
}

export function parseQualityReportDays(value: unknown): 7 | 30 {
  const days = Number(value ?? 7);
  if (days === 7 || days === 30) return days;
  throw new Error("days must be 7 or 30");
}

/** 问答质量周报：只接受产品约定的 7/30 天窗口。 */
export function qualityReportRouter(opts: QualityReportRouterOptions): Router {
  const router = Router();
  router.get("/quality-report", (req: Request, res: Response) => {
    try {
      res.json(opts.analytics.qualityReport(parseQualityReportDays(req.query.days)));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
