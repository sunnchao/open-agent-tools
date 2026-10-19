import { Router, type Request, type Response } from "express";
import type { CaliberConfigInput, DraftSlots } from "@open-agent-tools/query-resolver";
import { resolveCaliberQuery } from "../caliber/service.js";
import {
  createCaliberConfig,
  deleteCaliberConfig,
  getCaliberConfig,
  listCaliberConfigs,
  setDefaultCaliberConfig,
  updateCaliberConfig,
  type CaliberConfigRecordInput,
} from "../caliber/store.js";

export const caliberRouter: Router = Router();

function publicRecord(record: {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  enabled: boolean;
  updatedAt: string;
}) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    isDefault: record.isDefault,
    enabled: record.enabled,
    updatedAt: record.updatedAt,
  };
}

function configPayload(body: unknown): Partial<Omit<CaliberConfigRecordInput, "id">> {
  const value = body as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") return {};
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(value.config !== undefined ? { config: value.config as CaliberConfigInput } : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(typeof value.isDefault === "boolean" ? { isDefault: value.isDefault } : {}),
  };
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not found") ? 404 : 400;
}

caliberRouter.get("/api/caliber-configs", (_req: Request, res: Response) => {
  res.json({ configs: listCaliberConfigs().map(publicRecord) });
});

caliberRouter.get("/api/admin/caliber-configs", (_req: Request, res: Response) => {
  res.json({ configs: listCaliberConfigs({ includeDisabled: true }) });
});

caliberRouter.get("/api/admin/caliber-configs/:id", (req: Request, res: Response) => {
  const record = getCaliberConfig(req.params.id as string);
  if (!record) {
    res.status(404).json({ error: "caliber config not found" });
    return;
  }
  res.json({ config: record });
});

caliberRouter.post("/api/admin/caliber-configs", (req: Request, res: Response) => {
  try {
    res.status(201).json({
      config: createCaliberConfig(configPayload(req.body) as CaliberConfigRecordInput),
    });
  } catch (error) {
    res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

caliberRouter.put("/api/admin/caliber-configs/:id", (req: Request, res: Response) => {
  try {
    const record = updateCaliberConfig(req.params.id as string, configPayload(req.body));
    if (!record) {
      res.status(404).json({ error: "caliber config not found" });
      return;
    }
    res.json({ config: record });
  } catch (error) {
    res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

caliberRouter.put("/api/admin/caliber-configs/:id/default", (req: Request, res: Response) => {
  try {
    const record = setDefaultCaliberConfig(req.params.id as string);
    if (!record) {
      res.status(404).json({ error: "caliber config not found" });
      return;
    }
    res.json({ config: record });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

caliberRouter.delete("/api/admin/caliber-configs/:id", (req: Request, res: Response) => {
  const result = deleteCaliberConfig(req.params.id as string);
  if (result === "not_found") {
    res.status(404).json({ error: "caliber config not found" });
    return;
  }
  if (result === "default") {
    res.status(409).json({ error: "default caliber config cannot be deleted" });
    return;
  }
  res.status(204).end();
});

/** 使用指定（或默认）口径配置解析 utterance 的四类槽位。 */
caliberRouter.post("/api/caliber/resolve", async (req: Request, res: Response) => {
  const utterance = typeof req.body?.utterance === "string" ? req.body.utterance.trim() : "";
  if (!utterance) {
    res.status(400).json({ error: "utterance 不能为空" });
    return;
  }
  const ctx = resolveContext(req.body?.context);
  try {
    const result = await resolveCaliberQuery({
      ...(typeof req.body?.configId === "string" ? { configId: req.body.configId } : {}),
      utterance,
      ...(req.body?.partial && typeof req.body.partial === "object"
        ? { partial: req.body.partial as DraftSlots }
        : {}),
      ctx,
    });
    res.json(result);
  } catch (error) {
    res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function resolveContext(value: unknown): Record<string, unknown> {
  const ctx = (value ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof ctx.timezone === "string") out.timezone = ctx.timezone;
  if (Array.isArray(ctx.authorizedOrgs)) {
    out.authorizedOrgs = ctx.authorizedOrgs.filter((org): org is string => typeof org === "string");
  }
  if (typeof ctx.now === "string") {
    const parsed = new Date(ctx.now);
    if (!Number.isNaN(parsed.getTime())) out.now = parsed;
  }
  if (typeof ctx.expenseDefault === "string") out.expenseDefault = ctx.expenseDefault;
  if (typeof ctx.statusDefault === "string") out.statusDefault = ctx.statusDefault;
  if (typeof ctx.timeFieldDefault === "string") out.timeFieldDefault = ctx.timeFieldDefault;
  return out;
}
