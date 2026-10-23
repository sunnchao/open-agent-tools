import { Router, type Request, type Response } from "express";
import { optionalString as nonEmptyString } from "@open-agent-tools/api-contracts/values";
import { logTrace, truncate } from "../trace.js";
import {
  exportTableGraph,
  getSchemaGraph,
  loadSchemaCatalog,
  rebuildSchemaGraph,
} from "../schemaSources/runtime.js";
import type { SchemaSourceWithSecret } from "../schemaSources/store.js";
import { resolveSchemaSource } from "../schemaSources/resolve.js";
import { runSchemaText2Sql, type HistoryTurn } from "../oneapiDemo/text2sql.js";
import {
  getQueryAudit,
  getQueryAuditDetail,
  listQueryAudits,
  resolveOperatorActor,
  type QueryAuditFilters,
  type QueryAuditStatus,
  type QueryAuditSource,
  type QueryEntrypoint,
  type QuerySqlSource,
} from "../observatory/queryAudit.js";
import { resolveWorkspace } from "../workspace.js";
import { AUDIT_EXPORT_COLUMNS, listAuditExportRows } from "../export/auditExport.js";
import { parseExportFormat, sendExport } from "../export/respond.js";
import { writeSseData } from "../sse.js";

export const observatoryRouter: Router = Router();

observatoryRouter.get("/api/observatory/audits", (req: Request, res: Response) => {
  const parsed = parseAuditQuery(req);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { filters, limit, offset } = parsed.value;
  res.json(listQueryAudits({ ...filters, limit, offset }));
});

/**
 * 审计导出(等保/内审):复用列表页的筛选条件,把审计摘要导成 CSV/JSON。
 *
 * 筛选解析与列表接口共用 `parseAuditQuery`,保证「列表看到的」与「导出的」是同一批数据。
 * 结果有条数硬上限,超限截断并通过 `x-export-truncated` 明示。
 */
observatoryRouter.get("/api/observatory/audits/export", (req: Request, res: Response) => {
  const format = parseExportFormat(req.query.format);
  if (!format) {
    res.status(400).json({ error: "format 必须为 csv 或 json" });
    return;
  }
  const parsed = parseAuditQuery(req);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { rows, truncated } = listAuditExportRows(parsed.value.filters);
  logTrace("observatory.audits_export", {
    format,
    workspace: parsed.value.filters.workspace,
    rows: rows.length,
    truncated,
  });
  sendExport(res, {
    format,
    columns: AUDIT_EXPORT_COLUMNS,
    rows,
    filenameBase: "query-audits",
    truncated,
  });
});

interface ParsedAuditQuery {
  filters: Omit<QueryAuditFilters, "limit" | "offset">;
  limit: number;
  offset: number;
}

/**
 * 解析审计列表/导出的公共筛选条件。行为与历史列表接口保持一致:
 * 校验顺序(status → from/to → limit/offset → 枚举 → workspace)与错误文案均不变。
 */
function parseAuditQuery(
  req: Request,
): { ok: true; value: ParsedAuditQuery } | { ok: false; error: string } {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const from = optionalTimestamp(req.query.from);
  const to = optionalTimestamp(req.query.to);
  if (status && !["running", "succeeded", "failed", "clarifying"].includes(status)) {
    return { ok: false, error: "无效的审计状态" };
  }
  if (
    (req.query.from !== undefined && !from) ||
    (req.query.to !== undefined && !to) ||
    (from && to && from > to)
  ) {
    return { ok: false, error: "from/to 必须为有效且先后有序的 ISO 时间" };
  }
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return { ok: false, error: "limit 必须为 1–100,offset 必须为非负整数" };
  }
  const entrypoint = optionalEnum<QueryEntrypoint>(req.query.entrypoint, [
    "observatory",
    "chat",
    "workflow",
    "rerun",
    "unknown",
  ]);
  const sqlSource = optionalEnum<QuerySqlSource>(req.query.sqlSource, [
    "generated",
    "edited",
    "original",
  ]);
  const source = optionalEnum<QueryAuditSource>(req.query.source, [
    "generated",
    "rerun",
    "workflow",
    "chat",
    "clarification",
  ]);
  if (
    (req.query.entrypoint !== undefined && !entrypoint) ||
    (req.query.source !== undefined && !source) ||
    (req.query.sqlSource !== undefined && !sqlSource)
  ) {
    return { ok: false, error: "无效的审计筛选条件" };
  }
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    return { ok: false, error: `workspace not found: ${workspace.requested}` };
  }
  return {
    ok: true,
    value: {
      limit,
      offset,
      filters: {
        sourceId: requestedSourceId(req),
        status: status as QueryAuditStatus | undefined,
        actor: typeof req.query.actor === "string" ? req.query.actor.trim() : undefined,
        ...(entrypoint ? { entrypoint } : {}),
        ...(source ? { source } : {}),
        ...(sqlSource ? { sqlSource } : {}),
        parentAuditId:
          typeof req.query.parentAuditId === "string" ? req.query.parentAuditId.trim() : undefined,
        workspace: workspace.workspaceId,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        search: typeof req.query.search === "string" ? req.query.search.trim() : undefined,
      },
    },
  };
}

observatoryRouter.get("/api/observatory/audits/:id", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const detail = getQueryAuditDetail(String(req.params.id), workspace.workspaceId);
  if (!detail) {
    res.status(404).json({ error: "审计记录不存在" });
    return;
  }
  res.json(detail);
});

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

function optionalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizedSql(sql: string | null | undefined): string {
  return (sql ?? "")
    .trim()
    .replace(/;\s*$/, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>+\-*/])\s*/g, "$1")
    .toLowerCase();
}

function rejectRerunContext(req: Request): string | undefined {
  if (
    req.body?.connectionString !== undefined ||
    req.body?.permissionContext !== undefined ||
    req.body?.industries !== undefined ||
    req.body?.orgNos !== undefined ||
    req.body?.sourceId !== undefined ||
    req.body?.workspace !== undefined
  ) {
    return "重跑不接受连接串、数据源、workspace 或权限上下文";
  }
  return undefined;
}

function requestedSourceId(req: Request): string | undefined {
  if (typeof req.query.sourceId === "string" && req.query.sourceId.trim()) {
    return req.query.sourceId.trim();
  }
  if (typeof req.body?.sourceId === "string" && req.body.sourceId.trim()) {
    return req.body.sourceId.trim();
  }
  return undefined;
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
      const source = resolveSchemaSource(requestedSourceId(req));
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
      const source = resolveSchemaSource(requestedSourceId(req));
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
    const workspace = resolveWorkspace(req);
    if (!workspace.ok) {
      res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
      return;
    }
    const actor = resolveOperatorActor(req, { allowExplicitOperator: false });
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
    const suppliedOriginalQuestion = nonEmptyString(req.body?.originalQuestion);
    const originalQuestion =
      suppliedOriginalQuestion ?? history.find((turn) => turn.role === "user")?.content ?? question;
    const turnQuestion =
      suppliedOriginalQuestion && suppliedOriginalQuestion !== question ? question : undefined;
    try {
      const streaming =
        req.accepts(["text/event-stream", "application/json"]) === "text/event-stream" &&
        req.get("accept")?.includes("text/event-stream");
      const send = (event: unknown) => {
        if (!res.destroyed && !res.writableEnded) {
          writeSseData(res, event);
        }
      };
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (streaming) {
        res.set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
        }, 15_000);
        res.on("close", () => clearInterval(heartbeat));
      }
      try {
        const result = await runSchemaText2Sql(
          requestedSourceId(req),
          question,
          history,
          streaming ? send : undefined,
          {
            audit: {
              actor,
              entrypoint: "observatory",
              source: "generated",
              workspace: workspace.workspaceId,
              originalQuestion,
            },
            ...(turnQuestion ? { turnQuestion } : {}),
          },
        );
        if (streaming) {
          send({ type: "result", result });
          res.end();
        } else {
          const sourceFailed =
            result.steps.find((step) => step.id === "source")?.status === "failed";
          res
            .status(sourceFailed ? (result.error?.includes("not found") ? 404 : 500) : 200)
            .json(result);
        }
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTrace("observatory.query", { error: truncate(message, 200) }, "warn");
      if (res.headersSent) {
        if (!res.destroyed) {
          writeSseData(res, { type: "error", error: message });
          res.end();
        }
      } else {
        res.status(message.includes("not found") ? 404 : 500).json({ error: message });
      }
    }
  },
);

observatoryRouter.post("/api/observatory/query/rerun", async (req: Request, res: Response) => {
  const parentAuditId =
    typeof req.body?.parentAuditId === "string" ? req.body.parentAuditId.trim() : "";
  const sql = typeof req.body?.sql === "string" ? req.body.sql.trim() : "";
  if (!parentAuditId) {
    res.status(400).json({ error: "parentAuditId 不能为空" });
    return;
  }
  if (!sql) {
    res.status(400).json({ error: "sql 不能为空" });
    return;
  }
  // 明确拒绝越权上下文：重跑只接受父审计 + SQL，其余一律由服务端解析。
  const contextError = rejectRerunContext(req);
  if (contextError) {
    res.status(400).json({ error: contextError });
    return;
  }
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const parent = getQueryAudit(parentAuditId);
  if (!parent || parent.workspace !== workspace.workspaceId) {
    res.status(404).json({ error: "父审计不存在" });
    return;
  }
  if (parent.parentAuditId) {
    res.status(400).json({ error: "仅允许从根审计创建重跑子记录，避免出现链式放大" });
    return;
  }
  if (parent.status === "running") {
    res.status(409).json({ error: "父审计仍在执行，不能重跑" });
    return;
  }
  if (!parent.sourceId) {
    res.status(400).json({ error: "父审计缺少数据源，无法重跑" });
    return;
  }
  // 是否“原样重跑”只能由服务端比较得出；客户端传入的 sqlSource 一律忽略。
  const expectedSql = parent.executedSql ?? parent.generatedSql ?? parent.sql;
  const sqlSource: QuerySqlSource =
    normalizedSql(sql) === normalizedSql(expectedSql) ? "original" : "edited";
  const actor = resolveOperatorActor(req, { allowExplicitOperator: false });
  const question = parent.originalQuestion || parent.question;
  const clarificationHistory: HistoryTurn[] = parent.clarification
    ? [
        { role: "user", content: parent.originalQuestion || question },
        {
          role: "assistant",
          content: JSON.stringify({ clarification: parent.clarification }),
        },
      ]
    : [];
  const streaming =
    req.accepts(["text/event-stream", "application/json"]) === "text/event-stream" &&
    req.get("accept")?.includes("text/event-stream");
  const send = (event: unknown) => {
    if (!res.destroyed && !res.writableEnded) {
      writeSseData(res, event);
    }
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (streaming) {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
    }, 15_000);
    res.on("close", () => clearInterval(heartbeat));
  }
  try {
    const result = await runSchemaText2Sql(
      parent.sourceId,
      question,
      clarificationHistory,
      streaming ? send : undefined,
      {
        audit: {
          actor,
          entrypoint: "rerun",
          source: "rerun",
          sqlSource,
          parentAuditId: parent.id,
          workspace: workspace.workspaceId,
          originalQuestion: question,
          generatedSql: parent.generatedSql,
          executedSql: sql,
        },
        rerun: {
          sql,
          generatedSql: parent.generatedSql,
          sqlSource,
        },
      },
    );
    if (streaming) {
      send({ type: "result", result });
      res.end();
    } else {
      res.status(result.error ? 400 : 200).json(result);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (res.headersSent) {
      if (!res.destroyed) {
        writeSseData(res, { type: "error", error: message });
        res.end();
      }
    } else {
      res.status(400).json({ error: message });
    }
  } finally {
    clearInterval(heartbeat);
  }
});
