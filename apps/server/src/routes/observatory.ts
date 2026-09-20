import { Router, type Request, type Response } from "express";
import { logTrace, truncate } from "../trace.js";
import {
  exportTableGraph,
  getSchemaGraph,
  loadSchemaCatalog,
  rebuildSchemaGraph,
} from "../schemaSources/runtime.js";
import {
  getDefaultSchemaSource,
  getSchemaSource,
  type SchemaSourceWithSecret,
} from "../schemaSources/store.js";
import { runSchemaText2Sql, type HistoryTurn } from "../oneapiDemo/text2sql.js";

export const observatoryRouter: Router = Router();

function requestedSourceId(req: Request): string | undefined {
  if (typeof req.query.sourceId === "string" && req.query.sourceId.trim()) {
    return req.query.sourceId.trim();
  }
  if (typeof req.body?.sourceId === "string" && req.body.sourceId.trim()) {
    return req.body.sourceId.trim();
  }
  return undefined;
}

function resolveSource(sourceId?: string): SchemaSourceWithSecret {
  const source = sourceId
    ? getSchemaSource(sourceId, { requireEnabled: true })
    : getDefaultSchemaSource({ requireEnabled: true });
  if (!source)
    throw new Error(
      sourceId ? "schema source not found or disabled" : "no enabled schema source configured",
    );
  return source;
}

function publicSource(source: SchemaSourceWithSecret) {
  return {
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
  };
}

observatoryRouter.get(
  ["/api/observatory/graph", "/api/oneapi-demo/graph"],
  async (req: Request, res: Response) => {
    try {
      const source = resolveSource(requestedSourceId(req));
      const [catalog, graph] = await Promise.all([
        loadSchemaCatalog(source.id),
        getSchemaGraph(source.id),
      ]);
      const exported = exportTableGraph(graph);
      res.json({
        source: publicSource(source),
        database: catalog.database,
        collectedAt: catalog.collectedAt,
        tables: catalog.tables.map((table) => ({
          name: table.table.name,
          comment: table.table.comment ?? "",
          rows: table.table.approxRows ?? 0,
          columnCount: table.columns.length,
          columns: table.columns
            .filter((column) => column.sensitivity !== "sensitive")
            .map((column) => ({
              name: column.name,
              type: column.columnType,
              comment: column.comment ?? "",
            })),
        })),
        graph: exported,
        stats: graph.getStats(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTrace("observatory.graph", { error: truncate(message, 200) }, "warn");
      res.status(message.includes("not found") ? 404 : 500).json({ error: message });
    }
  },
);

observatoryRouter.post(
  ["/api/observatory/rebuild", "/api/oneapi-demo/rebuild"],
  async (req: Request, res: Response) => {
    try {
      const source = resolveSource(requestedSourceId(req));
      const graph = await rebuildSchemaGraph(source.id);
      res.json({
        ok: true,
        sourceId: source.id,
        stats: graph.getStats(),
        graph: exportTableGraph(graph),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes("not found") ? 404 : 500).json({ error: message });
    }
  },
);

observatoryRouter.post(
  ["/api/observatory/query", "/api/oneapi-demo/query"],
  async (req: Request, res: Response) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) {
      res.status(400).json({ error: "question 不能为空" });
      return;
    }
    const history: HistoryTurn[] = Array.isArray(req.body?.history)
      ? req.body.history
          .filter(
            (turn: unknown): turn is HistoryTurn =>
              Boolean(turn) &&
              typeof turn === "object" &&
              ((turn as HistoryTurn).role === "user" ||
                (turn as HistoryTurn).role === "assistant") &&
              typeof (turn as HistoryTurn).content === "string" &&
              (turn as HistoryTurn).content.trim().length > 0,
          )
          .map((turn: HistoryTurn) => ({ role: turn.role, content: turn.content.trim() }))
          .slice(-8)
      : [];
    try {
      res.json(await runSchemaText2Sql(requestedSourceId(req), question, history));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTrace("observatory.query", { error: truncate(message, 200) }, "warn");
      res.status(message.includes("not found") ? 404 : 500).json({ error: message });
    }
  },
);
