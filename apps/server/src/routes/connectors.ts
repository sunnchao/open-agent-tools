import { Router, type Request, type Response } from "express";
import { errorMessage as errorText } from "@open-agent-tools/api-contracts/values";
import { runConnectorSync } from "../connectors/sync.js";
import {
  createConnector,
  deleteConnector,
  getConnector,
  listConnectors,
  listSyncRuns,
  updateConnector,
  type ConnectorInput,
} from "../connectors/store.js";
import { CONNECTOR_TYPES, isConnectorType } from "../connectors/types.js";
import { logTrace, truncate } from "../trace.js";

export const connectorsRouter: Router = Router();

/** 只有这些类型强依赖 baseUrl;feishu/yuque 有官方默认域名可以省略。 */
const BASE_URL_REQUIRED = new Set(["http", "local-dir", "confluence"]);

function connectorPayload(body: unknown): Partial<ConnectorInput> {
  const value = body as Record<string, unknown> | undefined;
  return {
    ...(typeof value?.name === "string" ? { name: value.name } : {}),
    ...(typeof value?.type === "string" ? { type: value.type as ConnectorInput["type"] } : {}),
    ...(typeof value?.baseUrl === "string" || value?.baseUrl === null
      ? { baseUrl: value.baseUrl as string | null }
      : {}),
    ...(value?.credentials !== undefined
      ? { credentials: value.credentials as Record<string, string> | null }
      : {}),
    ...(value?.filter !== undefined ? { filter: value.filter as ConnectorInput["filter"] } : {}),
    ...(typeof value?.enabled === "boolean" ? { enabled: value.enabled } : {}),
  };
}

/** 连接器类型清单(供前端下拉与图例使用)。 */
connectorsRouter.get("/api/admin/connectors/types", (_req: Request, res: Response) => {
  res.json({ types: CONNECTOR_TYPES });
});

connectorsRouter.get("/api/admin/connectors", (_req: Request, res: Response) => {
  res.json({ connectors: listConnectors({ includeDisabled: true }) });
});

connectorsRouter.post("/api/admin/connectors", (req: Request, res: Response) => {
  const payload = connectorPayload(req.body);
  if (!isConnectorType(payload.type)) {
    res
      .status(400)
      .json({ error: "type must be one of http, local-dir, feishu, yuque, confluence" });
    return;
  }
  if (BASE_URL_REQUIRED.has(payload.type) && !payload.baseUrl?.trim()) {
    res.status(400).json({ error: `${payload.type} connector requires baseUrl` });
    return;
  }
  try {
    res.status(201).json({ connector: createConnector(payload as ConnectorInput) });
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});

connectorsRouter.put("/api/admin/connectors/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const payload = connectorPayload(req.body);
  const existing = getConnector(id);
  if (!existing) {
    res.status(404).json({ error: "connector not found" });
    return;
  }
  const nextType = payload.type ?? existing.type;
  if (!isConnectorType(nextType)) {
    res
      .status(400)
      .json({ error: "type must be one of http, local-dir, feishu, yuque, confluence" });
    return;
  }
  const nextBaseUrl = payload.baseUrl === undefined ? existing.baseUrl : payload.baseUrl;
  if (BASE_URL_REQUIRED.has(nextType) && !nextBaseUrl?.trim()) {
    res.status(400).json({ error: `${nextType} connector requires baseUrl` });
    return;
  }
  try {
    res.json({ connector: updateConnector(id, payload) });
  } catch (error) {
    res.status(400).json({ error: errorText(error) });
  }
});

connectorsRouter.delete("/api/admin/connectors/:id", (req: Request, res: Response) => {
  const result = deleteConnector(req.params.id as string);
  if (result === "not_found") {
    res.status(404).json({ error: "connector not found" });
    return;
  }
  res.status(204).end();
});

connectorsRouter.post("/api/admin/connectors/:id/sync", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!getConnector(id)) {
    res.status(404).json({ error: "connector not found" });
    return;
  }
  try {
    const run = await runConnectorSync({ connectorId: id });
    logTrace("connectors.sync", {
      connectorId: id,
      status: run.status,
      pulled: run.pulled,
      ingested: run.ingested,
      skipped: run.skipped,
      failed: run.failed,
    });
    // 只回传脱敏后的配置:getConnector 带解密凭据,绝不能透出到浏览器。
    const connector = listConnectors({ includeDisabled: true }).find((item) => item.id === id);
    res.json({ run, connector: connector ?? null });
  } catch (error) {
    const message = errorText(error);
    logTrace("connectors.sync_error", { connectorId: id, error: truncate(message, 300) }, "warn");
    res.status(message.includes("not found") ? 404 : 502).json({ error: message });
  }
});

connectorsRouter.get("/api/admin/connectors/:id/runs", (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!getConnector(id)) {
    res.status(404).json({ error: "connector not found" });
    return;
  }
  const limit = Number(req.query.limit);
  res.json({ runs: listSyncRuns(id, Number.isFinite(limit) ? limit : 10) });
});
