/**
 * 查询事件的持久化与补列迁移。
 *
 * 只负责写：事件行、命中行、反馈行，以及启动时的保留期清理。
 * 读侧聚合在 `dashboard.ts`，单条回放在 `replay.ts`。
 */
import { DatabaseSync } from "node:sqlite";
import { deriveQueryAttribution } from "./quality.js";
import type { QueryEventInput, QueryFeedbackRating } from "./types.js";

export function openAnalyticsStore(dbPath: string, retentionDays = 90): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_query_events (
      id                  TEXT PRIMARY KEY,
      query               TEXT NOT NULL,
      source_filter_json  TEXT NOT NULL,
      source_count        INTEGER NOT NULL DEFAULT 0,
      top_k               INTEGER NOT NULL,
      generate            INTEGER NOT NULL,
      crag                INTEGER NOT NULL,
      hit_count           INTEGER NOT NULL,
      answer_generated    INTEGER NOT NULL,
      attribution         TEXT NOT NULL DEFAULT 'unknown',
      crag_assessment     TEXT,
      crag_actions_json   TEXT NOT NULL DEFAULT '[]',
      latency_ms          INTEGER NOT NULL,
      error               TEXT,
      created_at          TEXT NOT NULL,
      trace_json          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rag_query_events_created_at
      ON rag_query_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS rag_query_hits (
      query_id TEXT NOT NULL REFERENCES rag_query_events(id) ON DELETE CASCADE,
      source   TEXT NOT NULL,
      hits     INTEGER NOT NULL,
      PRIMARY KEY (query_id, source)
    );
    CREATE INDEX IF NOT EXISTS idx_rag_query_hits_source ON rag_query_hits(source);
    CREATE TABLE IF NOT EXISTS rag_query_feedback (
      query_id   TEXT PRIMARY KEY REFERENCES rag_query_events(id) ON DELETE CASCADE,
      rating     TEXT NOT NULL CHECK (rating IN ('positive', 'negative')),
      comment    TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  migrateQueryEvents(db);
  const days = Math.max(1, Math.min(3650, Math.floor(retentionDays) || 90));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  db.prepare(`DELETE FROM rag_query_events WHERE created_at < ?`).run(cutoff);
  return db;
}

export function recordQuery(db: DatabaseSync, input: QueryEventInput): void {
  const sourceHits = new Map<string, number>();
  for (const hit of input.hits) {
    if (!hit.source) continue;
    sourceHits.set(hit.source, (sourceHits.get(hit.source) ?? 0) + 1);
  }
  const attribution = deriveQueryAttribution({
    error: input.error,
    crag: input.crag,
    generate: input.generate,
    hits: input.hits.length,
    sourceCount: input.sourceCount,
    answerGenerated: input.answerGenerated,
    answer: input.answer ?? null,
    generationAttempted: input.generate && input.hits.length > 0,
    assessment: input.assessment,
    actions: input.actions,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO rag_query_events (
           id, query, source_filter_json, source_count, top_k, generate, crag, hit_count,
           answer_generated, attribution, crag_assessment, crag_actions_json,
           latency_ms, error, created_at, trace_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.query,
      JSON.stringify(input.sources ?? []),
      Math.max(0, Math.round(input.sourceCount)),
      input.topK,
      input.generate ? 1 : 0,
      input.crag ? 1 : 0,
      input.hits.length,
      input.answerGenerated ? 1 : 0,
      attribution,
      input.assessment ?? null,
      JSON.stringify(input.actions ?? []),
      Math.max(0, Math.round(input.latencyMs)),
      input.error ?? null,
      input.createdAt ?? new Date().toISOString(),
      input.trace ? JSON.stringify(input.trace) : null,
    );
    const statement = db.prepare(
      `INSERT INTO rag_query_hits (query_id, source, hits) VALUES (?, ?, ?)`,
    );
    for (const [source, hits] of sourceHits) statement.run(input.id, source, hits);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveFeedback(
  db: DatabaseSync,
  queryId: string,
  rating: QueryFeedbackRating,
  comment?: string,
): { queryId: string; rating: QueryFeedbackRating; comment: string | null } | null {
  const event = db
    .prepare(`SELECT id FROM rag_query_events WHERE id = ?`)
    .get(queryId) as unknown as { id: string } | undefined;
  if (!event) return null;
  const now = new Date().toISOString();
  const normalizedComment = comment?.trim() || null;
  db.prepare(
    `INSERT INTO rag_query_feedback (query_id, rating, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(query_id) DO UPDATE SET
         rating = excluded.rating,
         comment = excluded.comment,
         updated_at = excluded.updated_at`,
  ).run(queryId, rating, normalizedComment, now, now);
  return { queryId, rating, comment: normalizedComment };
}

function migrateQueryEvents(db: DatabaseSync): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(rag_query_events)").all() as unknown as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  const migrations = [
    [
      "source_count",
      "ALTER TABLE rag_query_events ADD COLUMN source_count INTEGER NOT NULL DEFAULT 0",
    ],
    [
      "attribution",
      "ALTER TABLE rag_query_events ADD COLUMN attribution TEXT NOT NULL DEFAULT 'unknown'",
    ],
    ["crag_assessment", "ALTER TABLE rag_query_events ADD COLUMN crag_assessment TEXT"],
    [
      "crag_actions_json",
      "ALTER TABLE rag_query_events ADD COLUMN crag_actions_json TEXT NOT NULL DEFAULT '[]'",
    ],
    ["trace_json", "ALTER TABLE rag_query_events ADD COLUMN trace_json TEXT"],
  ] as const;
  for (const [column, sql] of migrations) {
    if (!columns.has(column)) db.exec(sql);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_rag_query_events_attribution ON rag_query_events(attribution)",
  );
}
