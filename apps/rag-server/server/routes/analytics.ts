import { Router, type Request, type Response } from "express";
import type { RagAnalyticsStore } from "../analytics.js";

export interface AnalyticsRouterOptions {
  analytics: Pick<RagAnalyticsStore, "overview" | "qualityReport">;
}

export function parseQualityReportDays(value: unknown): 7 | 30 {
  const days = Number(value ?? 7);
  if (days === 7 || days === 30) return days;
  throw new Error("days must be 7 or 30");
}

/** 问答质量周报：只接受产品约定的 7/30 天窗口。 */
export function analyticsRouter(opts: AnalyticsRouterOptions): Router {
  const router = Router();
  router.get("/overview", (req: Request, res: Response) => {
    res.json(opts.analytics.overview(Number(req.query.days) || 14));
  });
  router.get("/quality-report", (req: Request, res: Response) => {
    try {
      res.json(opts.analytics.qualityReport(parseQualityReportDays(req.query.days)));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
