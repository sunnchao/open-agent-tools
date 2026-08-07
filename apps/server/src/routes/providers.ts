import { Router, type Request, type Response } from "express";
import {
  createProvider,
  deleteProvider,
  fetchProviderModels,
  listProviders,
  probeProviderModels,
  setDefaultProvider,
  updateProvider,
} from "../providers/store.js";
import { isProviderFormat, type ProviderFormat } from "../providers/formats.js";

export const providersRouter: ReturnType<typeof Router> = Router();

function providerPayload(body: unknown): {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  enabled?: boolean;
  format?: ProviderFormat;
} {
  const value = body as Record<string, unknown> | undefined;
  return {
    name: typeof value?.name === "string" ? value.name : "",
    baseUrl: typeof value?.baseUrl === "string" ? value.baseUrl : "",
    ...(typeof value?.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    models: Array.isArray(value?.models)
      ? value.models.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof value?.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(isProviderFormat(value?.format) ? { format: value.format } : {}),
  };
}

providersRouter.get("/api/providers", (_req: Request, res: Response) => {
  res.json({ providers: listProviders({ includeDisabled: true }) });
});

providersRouter.get("/api/admin/providers", (_req: Request, res: Response) => {
  res.json({ providers: listProviders({ includeDisabled: true }) });
});

providersRouter.post("/api/admin/providers", (req: Request, res: Response) => {
  try {
    res.status(201).json({ provider: createProvider(providerPayload(req.body)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

providersRouter.put("/api/admin/providers/:id", (req: Request, res: Response) => {
  try {
    const provider = updateProvider(req.params.id as string, providerPayload(req.body));
    if (!provider) {
      res.status(404).json({ error: "provider not found" });
      return;
    }
    res.json({ provider });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

providersRouter.put("/api/admin/providers/:id/default", (req: Request, res: Response) => {
  try {
    const provider = setDefaultProvider(req.params.id as string);
    if (!provider) {
      res.status(404).json({ error: "provider not found" });
      return;
    }
    res.json({ provider });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

providersRouter.delete("/api/admin/providers/:id", (req: Request, res: Response) => {
  const result = deleteProvider(req.params.id as string);
  if (result === "not_found") {
    res.status(404).json({ error: "provider not found" });
    return;
  }
  if (result === "default") {
    res.status(409).json({ error: "default provider cannot be deleted" });
    return;
  }
  res.status(204).end();
});

providersRouter.post("/api/admin/providers/fetch-models", async (req: Request, res: Response) => {
  // 按参数探测模型列表（新建 Provider 时，尚无入库记录）。
  try {
    const value = req.body as { baseUrl?: string; apiKey?: string } | undefined;
    const models = await probeProviderModels({
      baseUrl: typeof value?.baseUrl === "string" ? value.baseUrl : "",
      apiKey: typeof value?.apiKey === "string" && value.apiKey ? value.apiKey : null,
    });
    res.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message === "baseUrl is required" ? 400 : 502).json({ error: message });
  }
});

providersRouter.post(
  "/api/admin/providers/:id/fetch-models",
  async (req: Request, res: Response) => {
    try {
      res.json({ models: await fetchProviderModels(req.params.id as string) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === "provider not found" ? 404 : 502).json({ error: message });
    }
  },
);
