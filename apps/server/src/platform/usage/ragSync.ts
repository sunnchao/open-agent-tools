import { getDbPath, openDb } from "../db.js";
import { recordUsageEvent, type UsageEventInput } from "./events.js";
import { logTrace } from "../trace.js";

interface RagUsagePage {
  events: Array<UsageEventInput & { id: string; createdAt: number }>;
  nextCursor: number;
  hasMore: boolean;
}

const pending = new Map<string, Promise<void>>();

/** Import the durable RAG outbox, including graph requests completed after an upload returned. */
export async function syncRagUsage(): Promise<void> {
  const baseUrl = (process.env.RAG_API_URL ?? "http://localhost:4001/api").replace(/\/$/, "");
  const key = `${getDbPath()}:${baseUrl}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const sync = importEvents(baseUrl)
    .catch((error: unknown) => {
      logTrace(
        "usage.rag_sync",
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "warn",
      );
    })
    .finally(() => pending.delete(key));
  pending.set(key, sync);
  return sync;
}

async function importEvents(baseUrl: string): Promise<void> {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_sync_cursors (
      source TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL
    );
  `);
  let cursor =
    (
      db.prepare("SELECT cursor FROM usage_sync_cursors WHERE source = ?").get(baseUrl) as
        { cursor: number } | undefined
    )?.cursor ?? 0;
  for (;;) {
    const token = process.env.RAG_ADMIN_TOKEN?.trim();
    const response = await fetch(`${baseUrl}/usage/events?after=${cursor}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    // Older RAG deployments keep their local Studio statistics available during upgrades.
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`RAG usage HTTP ${response.status}`);
    const page = (await response.json()) as RagUsagePage;
    if (
      !Array.isArray(page.events) ||
      !Number.isSafeInteger(page.nextCursor) ||
      page.nextCursor < cursor ||
      (page.hasMore && page.nextCursor <= cursor)
    ) {
      throw new Error("Invalid RAG usage page");
    }
    db.exec("BEGIN");
    try {
      for (const event of page.events) {
        if (
          (event.source !== "rag_query" && event.source !== "rag_graph") ||
          event.kind !== "chat" ||
          typeof event.id !== "string" ||
          !event.id ||
          !Number.isFinite(event.createdAt)
        )
          throw new Error("Invalid RAG usage event");
        if (!recordUsageEvent(event, { id: `rag:${event.id}`, createdAt: event.createdAt })) {
          throw new Error("Could not persist RAG usage event");
        }
      }
      db.prepare(
        `
        INSERT INTO usage_sync_cursors (source, cursor) VALUES (?, ?)
        ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor
      `,
      ).run(baseUrl, page.nextCursor);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    cursor = page.nextCursor;
    if (!page.hasMore) return;
  }
}
