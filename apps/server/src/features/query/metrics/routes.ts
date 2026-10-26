import { Router, type Request, type Response } from "express";
import { httpErrorStatus as errorStatus } from "../../../http/httpErrors.js";
import { METRIC_STATUSES, type MetricStatus } from "./caliber.js";
import { renderMetricPromptBlock, selectMetrics } from "./select.js";
import {
  createMetricDefinition,
  deleteMetricDefinition,
  getMetricDefinition,
  listMetricDefinitions,
  updateMetricDefinition,
  type MetricDefinitionInput,
} from "./store.js";

export const metricsRouter: Router = Router();

function isStatus(value: unknown): value is MetricStatus {
  return typeof value === "string" && (METRIC_STATUSES as readonly string[]).includes(value);
}

function metricPayload(body: unknown): Partial<MetricDefinitionInput> {
  const value = body as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") return {};
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.category === "string" || value.category === null
      ? { category: value.category as string | null }
      : {}),
    ...(typeof value.unit === "string" || value.unit === null
      ? { unit: value.unit as string | null }
      : {}),
    ...(value.caliber !== undefined ? { caliber: value.caliber as MetricDefinitionInput["caliber"] } : {}),
    ...(typeof value.sourceId === "string" || value.sourceId === null
      ? { sourceId: value.sourceId as string | null }
      : {}),
    ...(Array.isArray(value.tables)
      ? { tables: value.tables.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(Array.isArray(value.synonyms)
      ? { synonyms: value.synonyms.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(Array.isArray(value.tags)
      ? { tags: value.tags.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(isStatus(value.status) ? { status: value.status } : {}),
    ...(typeof value.owner === "string" || value.owner === null
      ? { owner: value.owner as string | null }
      : {}),
  };
}

metricsRouter.get("/api/metrics", (req: Request, res: Response) => {
  res.json({
    metrics: listMetricDefinitions({
      status: "active",
      ...(typeof req.query.category === "string" ? { category: req.query.category } : {}),
      ...(typeof req.query.sourceId === "string" ? { sourceId: req.query.sourceId } : {}),
    }),
  });
});

metricsRouter.get("/api/admin/metrics", (req: Request, res: Response) => {
  const status = isStatus(req.query.status) ? req.query.status : undefined;
  res.json({
    metrics: listMetricDefinitions({
      ...(status ? { status } : {}),
      ...(typeof req.query.category === "string" ? { category: req.query.category } : {}),
      ...(typeof req.query.sourceId === "string" ? { sourceId: req.query.sourceId } : {}),
    }),
  });
});

metricsRouter.get("/api/admin/metrics/:id", (req: Request, res: Response) => {
  const metric = getMetricDefinition(req.params.id as string);
  if (!metric) {
    res.status(404).json({ error: "metric not found" });
    return;
  }
  res.json({ metric });
});

metricsRouter.post("/api/admin/metrics", (req: Request, res: Response) => {
  try {
    res.status(201).json({ metric: createMetricDefinition(metricPayload(req.body) as MetricDefinitionInput) });
  } catch (error) {
    res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

metricsRouter.put("/api/admin/metrics/:id", (req: Request, res: Response) => {
  try {
    const metric = updateMetricDefinition(req.params.id as string, metricPayload(req.body));
    if (!metric) {
      res.status(404).json({ error: "metric not found" });
      return;
    }
    res.json({ metric });
  } catch (error) {
    res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

metricsRouter.delete("/api/admin/metrics/:id", (req: Request, res: Response) => {
  if (!deleteMetricDefinition(req.params.id as string)) {
    res.status(404).json({ error: "metric not found" });
    return;
  }
  res.status(204).end();
});

/** 按问题匹配指标口径，返回命中项与可直接注入 prompt 的文本块。 */
metricsRouter.post("/api/metrics/match", (req: Request, res: Response) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    res.status(400).json({ error: "question 不能为空" });
    return;
  }
  const limit = req.body?.limit === undefined ? 5 : Number(req.body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    res.status(400).json({ error: "limit 必须为 1–50 的整数" });
    return;
  }
  const matches = selectMetrics(question, {
    limit,
    ...(typeof req.body?.sourceId === "string" ? { sourceId: req.body.sourceId } : {}),
  });
  res.json({ matches, prompt: renderMetricPromptBlock(matches) });
});
