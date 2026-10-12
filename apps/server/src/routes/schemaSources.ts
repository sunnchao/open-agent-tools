import { Router, type Request, type Response } from "express";
import {
  inferReferences,
  invalidateSchemaSource,
  loadSchemaCatalog,
  removeSchemaSourceRuntime,
  rebuildSchemaGraph,
} from "../schemaSources/runtime.js";
import {
  createSchemaSource,
  deleteSchemaSource,
  duplicateSchemaSource,
  getSchemaSource,
  listSchemaSources,
  probeSchemaSource,
  probeStoredSchemaSource,
  setDefaultSchemaSource,
  updateSchemaSource,
  updateSchemaSourceSyncState,
  type SchemaSemanticProfile,
  type SchemaSourceConnector,
  type SchemaSourceInput,
} from "../schemaSources/store.js";

export const schemaSourcesRouter: Router = Router();

function sourcePayload(body: unknown): Partial<SchemaSourceInput> {
  const value = body as Record<string, unknown> | undefined;
  return {
    ...(typeof value?.name === "string" ? { name: value.name } : {}),
    ...(typeof value?.connector === "string"
      ? { connector: value.connector as SchemaSourceConnector }
      : {}),
    ...(typeof value?.connectionString === "string"
      ? { connectionString: value.connectionString }
      : {}),
    ...(typeof value?.host === "string" ? { host: value.host } : {}),
    ...(value?.port !== undefined ? { port: value.port as number } : {}),
    ...(typeof value?.username === "string" ? { username: value.username } : {}),
    ...(typeof value?.password === "string" ? { password: value.password } : {}),
    ...(typeof value?.databaseName === "string" || value?.databaseName === null
      ? { databaseName: value.databaseName as string | null }
      : {}),
    ...(typeof value?.schemaName === "string" || value?.schemaName === null
      ? { schemaName: value.schemaName as string | null }
      : {}),
    ...(Array.isArray(value?.tableFilter)
      ? {
          tableFilter: value.tableFilter.filter((item): item is string => typeof item === "string"),
        }
      : {}),
    ...(typeof value?.semanticProfile === "string"
      ? { semanticProfile: value.semanticProfile as SchemaSemanticProfile }
      : {}),
    ...(typeof value?.enabled === "boolean" ? { enabled: value.enabled } : {}),
  };
}

schemaSourcesRouter.get("/api/schema-sources", (_req: Request, res: Response) => {
  res.json({
    sources: listSchemaSources().map((source) => ({
      id: source.id,
      name: source.name,
      connector: source.connector,
      databaseName: source.databaseName,
      schemaName: source.schemaName,
      semanticProfile: source.semanticProfile,
      isDefault: source.isDefault,
      managedByEnv: source.managedByEnv,
      syncStatus: source.syncStatus,
      lastSyncedAt: source.lastSyncedAt,
      tableCount: source.tableCount,
      relationCount: source.relationCount,
    })),
  });
});

schemaSourcesRouter.get("/api/admin/schema-sources", (_req: Request, res: Response) => {
  res.json({ sources: listSchemaSources({ includeDisabled: true }) });
});

schemaSourcesRouter.post("/api/admin/schema-sources", (req: Request, res: Response) => {
  try {
    res.status(201).json({
      source: createSchemaSource(sourcePayload(req.body) as SchemaSourceInput),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

schemaSourcesRouter.put("/api/admin/schema-sources/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const source = updateSchemaSource(id, sourcePayload(req.body));
    if (!source) {
      res.status(404).json({ error: "schema source not found" });
      return;
    }
    invalidateSchemaSource(id);
    updateSchemaSourceSyncState(id, { status: "idle", error: null });
    res.json({ source });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

schemaSourcesRouter.put("/api/admin/schema-sources/:id/default", (req: Request, res: Response) => {
  try {
    const source = setDefaultSchemaSource(req.params.id as string);
    if (!source) {
      res.status(404).json({ error: "schema source not found" });
      return;
    }
    res.json({ source });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

schemaSourcesRouter.delete("/api/admin/schema-sources/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const result = deleteSchemaSource(id);
  if (result === "not_found") {
    res.status(404).json({ error: "schema source not found" });
    return;
  }
  if (result === "default") {
    res.status(409).json({ error: "default schema source cannot be deleted" });
    return;
  }
  if (result === "managed") {
    res.status(409).json({ error: "environment schema source is managed by configuration" });
    return;
  }
  removeSchemaSourceRuntime(id);
  res.status(204).end();
});

schemaSourcesRouter.post(
  "/api/admin/schema-sources/:id/duplicate",
  (req: Request, res: Response) => {
    try {
      const source = duplicateSchemaSource(req.params.id as string);
      if (!source) {
        res.status(404).json({ error: "schema source not found" });
        return;
      }
      res.status(201).json({ source });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },
);

schemaSourcesRouter.post(
  "/api/admin/schema-sources/:id/sync",
  async (req: Request, res: Response) => {
    try {
      const sourceId = req.params.id as string;
      const graph = await rebuildSchemaGraph(sourceId);
      const source = listSchemaSources({ includeDisabled: true }).find(
        (item) => item.id === sourceId,
      );
      res.json({ source, stats: graph.getStats() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes("not found") ? 404 : 502).json({ error: message });
    }
  },
);

schemaSourcesRouter.get(
  "/api/admin/schema-sources/:id/catalog",
  async (req: Request, res: Response) => {
    try {
      const sourceId = req.params.id as string;
      const catalog = await loadSchemaCatalog(sourceId);
      const source = getSchemaSource(sourceId, { requireEnabled: true });
      if (!source) {
        res.status(404).json({ error: "schema source not found" });
        return;
      }
      res.json({
        sourceId,
        database: catalog.database,
        collectedAt: catalog.collectedAt,
        relationCount: inferReferences(catalog, source.semanticProfile).length,
        tables: catalog.tables.map((table) => ({
          name: table.table.name,
          comment: table.table.comment ?? "",
          rows: table.table.approxRows ?? 0,
          columnCount: table.columns.length,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes("not found") ? 404 : 502).json({ error: message });
    }
  },
);

schemaSourcesRouter.post("/api/admin/schema-sources/test", async (req: Request, res: Response) => {
  try {
    const result = await probeSchemaSource(sourcePayload(req.body));
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

schemaSourcesRouter.post(
  "/api/admin/schema-sources/:id/test",
  async (req: Request, res: Response) => {
    try {
      const result = await probeStoredSchemaSource(
        req.params.id as string,
        sourcePayload(req.body),
      );
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === "schema source not found" ? 404 : 502).json({ error: message });
    }
  },
);
