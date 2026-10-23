import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { NextFunction, Request, Response } from "express";
import { nonNegativeInteger } from "@open-agent-tools/api-contracts/values";

type UsageSource = "rag_query" | "rag_graph";

interface TokenUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
}

interface RagUsageEvent {
  id: string;
  source: UsageSource;
  workspaceId: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  status: "ok" | "error";
  createdAt: number;
}

interface UsageContext {
  store: RagUsageStore;
  workspaceId: string;
  usage: TokenUsage;
}

const storage = new AsyncLocalStorage<UsageContext>();
const emptyUsage = (): TokenUsage => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  toolCalls: 0,
  toolErrors: 0,
});

/** An append-only outbox lets Studio import background graph usage after the upload has returned. */
export class RagUsageStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_usage_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rag_usage_workspace_source
        ON rag_usage_events(workspace_id, source);
    `);
  }

  record(event: RagUsageEvent): void {
    try {
      this.db
        .prepare(
          `
        INSERT INTO rag_usage_events
          (id, workspace_id, source, model, input_tokens, output_tokens, duration_ms, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          event.id,
          event.workspaceId,
          event.source,
          event.model,
          event.inputTokens,
          event.outputTokens,
          event.durationMs,
          event.status,
          event.createdAt,
        );
    } catch (error) {
      console.error(`[rag-usage] failed to record usage: ${String(error)}`);
    }
  }

  events(after: number, limit = 500) {
    const rows = this.db
      .prepare(
        `
      SELECT sequence, id, workspace_id, source, model, input_tokens, output_tokens,
             duration_ms, status, created_at
      FROM rag_usage_events WHERE sequence > ? ORDER BY sequence LIMIT ?
    `,
      )
      .all(after, limit + 1) as unknown as Array<{
      sequence: number;
      id: string;
      workspace_id: string;
      source: UsageSource;
      model: string;
      input_tokens: number;
      output_tokens: number;
      duration_ms: number;
      status: "ok" | "error";
      created_at: number;
    }>;
    const visible = rows.slice(0, limit);
    return {
      events: visible.map((row) => ({
        id: row.id,
        kind: "chat" as const,
        source: row.source,
        workspaceId: row.workspace_id,
        providerId: "rag-server",
        model: row.model,
        requests: 1,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        durationMs: row.duration_ms,
        status: row.status,
        createdAt: row.created_at,
      })),
      nextCursor: visible.at(-1)?.sequence ?? after,
      hasMore: rows.length > limit,
    };
  }

  graphUsage(workspaceId: string): TokenUsage {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM rag_usage_events WHERE workspace_id = ? AND source = 'rag_graph'
    `,
      )
      .get(workspaceId) as { requests: number; input_tokens: number; output_tokens: number };
    return {
      ...emptyUsage(),
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.input_tokens + row.output_tokens,
    };
  }

  close(): void {
    this.db.close();
  }
}

export function ragUsageMiddleware(store: RagUsageStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const workspaceId = req.header("x-workspace-id")?.trim() || "default";
    const context = { store, workspaceId, usage: emptyUsage() };
    const json = res.json;
    const showUsage =
      req.method === "POST" &&
      ["/api/query", "/api/graph/extract", "/api/graph/reconcile", "/api/graph/retrieve"].includes(
        req.path,
      );
    const graphStatus = req.method === "GET" && req.path === "/api/graph/sync-status";
    if (showUsage || graphStatus) {
      res.json = function (body: unknown) {
        return json.call(this, {
          ...(body as Record<string, unknown>),
          usage: graphStatus ? store.graphUsage(workspaceId) : { ...context.usage },
        });
      };
    }
    storage.run(context, next);
  };
}

export async function trackRagLlm<
  T extends {
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
    response_metadata?: Record<string, unknown>;
  },
>(source: UsageSource, model: string, run: () => Promise<T>): Promise<T> {
  const context = storage.getStore();
  if (!context) return run();
  const startedAt = Date.now();
  const event: RagUsageEvent = {
    id: randomUUID(),
    source,
    workspaceId: context.workspaceId,
    model,
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    status: "ok",
    createdAt: startedAt,
  };
  context.usage.requests += 1;
  try {
    const response = await run();
    const fallback = response.response_metadata?.tokenUsage as
      | {
          promptTokens?: number;
          completionTokens?: number;
        }
      | undefined;
    event.inputTokens = nonNegativeInteger(
      response.usage_metadata?.input_tokens ?? fallback?.promptTokens,
    );
    event.outputTokens = nonNegativeInteger(
      response.usage_metadata?.output_tokens ?? fallback?.completionTokens,
    );
    context.usage.inputTokens += event.inputTokens;
    context.usage.outputTokens += event.outputTokens;
    context.usage.totalTokens += event.inputTokens + event.outputTokens;
    return response;
  } catch (error) {
    event.status = "error";
    throw error;
  } finally {
    event.durationMs = Date.now() - startedAt;
    context.store.record(event);
  }
}
