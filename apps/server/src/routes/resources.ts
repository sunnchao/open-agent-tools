import { Router, type Request, type Response } from "express";
import { loadResourceCatalog } from "../resources.js";
import { logDuration, logTrace, truncate } from "../trace.js";

export const resourcesRouter: ReturnType<typeof Router> = Router();

resourcesRouter.get("/api/resources", async (_req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const catalog = await loadResourceCatalog();
    logDuration("resources.loaded", startedAt, {
      mcpConfigured: catalog.mcp.configured,
      mcpServices: catalog.mcp.services.length,
      ragSources: catalog.rag.sources.length,
      ...(catalog.mcp.error ? { mcpError: truncate(catalog.mcp.error, 200) } : {}),
      ...(catalog.rag.error ? { ragError: truncate(catalog.rag.error, 200) } : {}),
    });
    res.json(catalog);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTrace("resources.error", { error: truncate(message, 200) }, "error");
    res.status(500).json({ error: message });
  }
});
