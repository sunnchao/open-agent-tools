/**
 * IM / Web 共用的长期记忆存储（P0–P1）。
 *
 * 三层：原始消息与审计（证据，不在此模块）、会话摘要、长期事实。
 * 事实只做“逻辑失效”（status=superseded + valid_to），永不物理覆盖，
 * 否则答不了“以前是怎样”。物理删除只走 forget。
 */
import { randomUUID } from "node:crypto";
import { openDb } from "../../platform/db.js";

export const MEMORY_KINDS = ["preference", "fact", "decision", "constraint"] as const;
export const MEMORY_SCOPES = ["person", "group"] as const;
export const MEMORY_CONFIDENCES = ["high", "medium", "low", "unknown"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScopeKind = (typeof MEMORY_SCOPES)[number];
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

export interface MemoryFact {
  id: string;
  workspaceId: string;
  channelId: string | null;
  scopeKind: MemoryScopeKind;
  scopeKey: string;
  subject: string;
  kind: MemoryKind;
  slug: string;
  body: string;
  status: "active" | "superseded" | "expired";
  confidence: MemoryConfidence;
  unreviewed: boolean;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: number;
  updatedAt: number;
  supersedesId: string | null;
}

export interface MemoryFactInput {
  workspaceId: string;
  channelId?: string | null;
  scopeKind: MemoryScopeKind;
  scopeKey: string;
  subject: string;
  kind: MemoryKind;
  slug: string;
  body: string;
  confidence?: MemoryConfidence;
  unreviewed?: boolean;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  validFrom?: string | null;
  /** 为 true 时同一 (scope, subject, slug) 的 active 旧行转为 superseded。 */
  supersede?: boolean;
  recordedAt?: number;
}

export interface MemorySearchMatch extends MemoryFact {
  score: number;
}

const FACT_COLUMNS = `
  id, workspace_id AS workspaceId, channel_id AS channelId,
  scope_kind AS scopeKind, scope_key AS scopeKey, subject, kind, slug, body, status,
  confidence, unreviewed, source_session_id AS sourceSessionId,
  source_message_id AS sourceMessageId, valid_from AS validFrom, valid_to AS validTo,
  recorded_at AS recordedAt, updated_at AS updatedAt, supersedes_id AS supersedesId
`;

interface FactRow extends Omit<MemoryFact, "unreviewed"> {
  unreviewed: number;
}

function toFact(row: FactRow): MemoryFact {
  return { ...row, unreviewed: row.unreviewed === 1 };
}

/** 事实写入：supersede=true 时先失效同主体同 slug 的 active 行（保留历史）。 */
export function writeFact(input: MemoryFactInput): MemoryFact {
  const database = openDb();
  const recordedAt = input.recordedAt ?? Date.now();
  const id = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    let supersedesId: string | null = null;
    if (input.supersede !== false) {
      const previous = database
        .prepare(
          `SELECT id FROM im_memory_facts
           WHERE workspace_id = ? AND scope_kind = ? AND scope_key = ? AND subject = ? AND slug = ?
             AND status = 'active'
           ORDER BY recorded_at DESC LIMIT 1`,
        )
        .get(input.workspaceId, input.scopeKind, input.scopeKey, input.subject, input.slug) as
        | { id: string }
        | undefined;
      if (previous) {
        supersedesId = previous.id;
        database
          .prepare(
            `UPDATE im_memory_facts SET status = 'superseded', valid_to = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.validFrom ?? new Date().toISOString().slice(0, 10), recordedAt, previous.id);
      }
    }
    database
      .prepare(
        `INSERT INTO im_memory_facts
          (id, workspace_id, channel_id, scope_kind, scope_key, subject, kind, slug, body, status,
           confidence, unreviewed, source_session_id, source_message_id, valid_from, valid_to,
           recorded_at, updated_at, supersedes_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.channelId ?? null,
        input.scopeKind,
        input.scopeKey,
        input.subject,
        input.kind,
        input.slug,
        input.body,
        input.confidence ?? "unknown",
        input.unreviewed === false ? 0 : 1,
        input.sourceSessionId ?? null,
        input.sourceMessageId ?? null,
        input.validFrom ?? null,
        recordedAt,
        recordedAt,
        supersedesId,
      );
    database
      .prepare(
        `INSERT INTO im_memory_facts_fts (fact_id, slug, subject, body) VALUES (?, ?, ?, ?)`,
      )
      .run(id, input.slug, input.subject, input.body);
    database.exec("COMMIT");
    return getFact(id)!;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getFact(id: string): MemoryFact | null {
  const row = openDb()
    .prepare(`SELECT ${FACT_COLUMNS} FROM im_memory_facts WHERE id = ?`)
    .get(id) as FactRow | undefined;
  return row ? toFact(row) : null;
}

export interface FactPage {
  facts: MemoryFact[];
  /** 满足筛选条件的总条数（不受 limit/offset 限制）。 */
  total: number;
}

export function listFactsPage(options: {
  workspaceId: string;
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
  status?: "active" | "superseded" | "all";
  includeUnreviewed?: boolean;
  /** 关键词：走 FTS + 子串兜底，与召回同一套匹配规则。 */
  keyword?: string;
  limit?: number;
  offset?: number;
}): FactPage {
  const conditions = ["workspace_id = ?"];
  const params: Array<string | number> = [options.workspaceId];
  if (options.scopeKind) {
    conditions.push("scope_kind = ?");
    params.push(options.scopeKind);
  }
  if (options.scopeKey) {
    conditions.push("scope_key = ?");
    params.push(options.scopeKey);
  }
  if ((options.status ?? "active") !== "all") {
    conditions.push("status = ?");
    params.push(options.status ?? "active");
  }
  if (!options.includeUnreviewed) conditions.push("unreviewed = 0");
  const keyword = options.keyword?.trim().toLowerCase();
  if (keyword) {
    conditions.push("(lower(slug) LIKE ? OR lower(subject) LIKE ? OR lower(body) LIKE ?)");
    const pattern = `%${keyword.replace(/[%_]/g, "")}%`;
    params.push(pattern, pattern, pattern);
  }
  const where = conditions.join(" AND ");
  const database = openDb();
  const total = Number(
    (database.prepare(`SELECT COUNT(*) AS n FROM im_memory_facts WHERE ${where}`).get(...params) as {
      n: number;
    }).n,
  );
  const rows = database
    .prepare(
      `SELECT ${FACT_COLUMNS} FROM im_memory_facts WHERE ${where}
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit ?? 200, options.offset ?? 0) as unknown as FactRow[];
  return { facts: rows.map(toFact), total };
}

/**
 * 版本链：同一 (workspace, scope, subject, slug) 的全部版本，按记录时间升序。
 * supersede 只做逻辑失效，因此这里能看到“以前是怎样”。
 */
export function listFactHistory(fact: MemoryFact): MemoryFact[] {
  const rows = openDb()
    .prepare(
      `SELECT ${FACT_COLUMNS} FROM im_memory_facts
       WHERE workspace_id = ? AND scope_kind = ? AND scope_key = ? AND subject = ? AND slug = ?
       ORDER BY recorded_at ASC`,
    )
    .all(
      fact.workspaceId,
      fact.scopeKind,
      fact.scopeKey,
      fact.subject,
      fact.slug,
    ) as unknown as FactRow[];
  return rows.map(toFact);
}

export function listFacts(options: {
  workspaceId: string;
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
  status?: "active" | "superseded" | "all";
  includeUnreviewed?: boolean;
  limit?: number;
}): MemoryFact[] {
  return listFactsPage({ ...options, offset: 0 }).facts;
}

export function setFactReview(id: string, accepted: boolean): MemoryFact | null {
  const database = openDb();
  if (accepted) {
    database.prepare(`UPDATE im_memory_facts SET unreviewed = 0, updated_at = ? WHERE id = ?`).run(
      Date.now(),
      id,
    );
  } else {
    database.prepare(`DELETE FROM im_memory_facts_fts WHERE fact_id = ?`).run(id);
    database.prepare(`DELETE FROM im_memory_facts WHERE id = ?`).run(id);
  }
  return accepted ? getFact(id) : null;
}

/**
 * 召回：FTS 命中 + 子串兜底 + 新近度加权。
 * 只返回已审核的 active 事实；群作用域额外允许同群事实。
 */
export function searchFacts(
  query: string,
  options: {
    workspaceId: string;
    scopeKey?: string;
    limit?: number;
    includeGroup?: boolean;
  },
): MemorySearchMatch[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const database = openDb();
  const ftsIds = new Set<string>();
  if (normalized.length >= 2) {
    try {
      const rows = database
        .prepare(
          `SELECT fact_id AS id FROM im_memory_facts_fts WHERE im_memory_facts_fts MATCH ? LIMIT 100`,
        )
        .all(`"${normalized.replace(/"/g, '""')}"`) as Array<{ id: string }>;
      for (const row of rows) ftsIds.add(row.id);
    } catch {
      // trigram 对短查询可能报错，子串兜底仍然生效。
    }
  }

  const conditions = ["workspace_id = ?", "status = 'active'", "unreviewed = 0"];
  const params: Array<string | number> = [options.workspaceId];
  if (options.scopeKey) {
    conditions.push(
      options.includeGroup === false
        ? "(scope_kind = 'person' AND scope_key = ?)"
        : "((scope_kind = 'person' AND scope_key = ?) OR scope_kind = 'group')",
    );
    params.push(options.scopeKey);
  }
  const rows = database
    .prepare(
      `SELECT ${FACT_COLUMNS} FROM im_memory_facts WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC LIMIT 400`,
    )
    .all(...params) as unknown as FactRow[];

  const now = Date.now();
  const matches: MemorySearchMatch[] = [];
  for (const row of rows) {
    const fact = toFact(row);
    let relevance = ftsIds.has(fact.id) ? 1 : 0;
    if (fact.slug.toLowerCase().includes(normalized)) relevance += 1.4;
    if (fact.subject.toLowerCase().includes(normalized)) relevance += 1.2;
    if (fact.body.toLowerCase().includes(normalized)) relevance += 1;
    if (relevance === 0) continue;
    const ageDays = Math.max(0, (now - fact.updatedAt) / 86_400_000);
    const recency = 1 + 0.2 / (1 + ageDays / 30);
    matches.push({ ...fact, score: relevance * recency });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 8);
}

/** 会话摘要（P1）：游标单调前进，后写覆盖只允许覆盖更旧的游标。 */
export function upsertSummary(input: {
  sessionId: string;
  summary: string;
  coveredThroughPosition: number;
}): boolean {
  const result = openDb()
    .prepare(
      `INSERT INTO im_memory_summaries (session_id, summary, covered_through_position, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         summary = excluded.summary,
         covered_through_position = excluded.covered_through_position,
         updated_at = excluded.updated_at
       WHERE excluded.covered_through_position >= im_memory_summaries.covered_through_position`,
    )
    .run(input.sessionId, input.summary, input.coveredThroughPosition, Date.now());
  return result.changes > 0;
}

export function getSummary(
  sessionId: string,
): { summary: string; coveredThroughPosition: number } | null {
  const row = openDb()
    .prepare(
      `SELECT summary, covered_through_position AS coveredThroughPosition
       FROM im_memory_summaries WHERE session_id = ?`,
    )
    .get(sessionId) as { summary: string; coveredThroughPosition: number } | undefined;
  return row ?? null;
}

/** 血缘：事实与来源会话/消息，供 forget 定位。 */
export function recordLineage(input: {
  factId: string;
  sessionId: string;
  messageId?: string | null;
  actor?: string | null;
}): void {
  openDb()
    .prepare(
      `INSERT INTO im_memory_lineage (fact_id, session_id, message_id, actor, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.factId, input.sessionId, input.messageId ?? null, input.actor ?? null, Date.now());
}

/** 平台外部身份 → canonical person。 */
export function resolvePersonId(input: {
  workspaceId: string;
  channelId: string;
  platform: string;
  idType: string;
  externalId: string;
}): string {
  const database = openDb();
  const existing = database
    .prepare(
      `SELECT person_id AS personId FROM im_person_links
       WHERE channel_id = ? AND platform = ? AND id_type = ? AND external_id = ?`,
    )
    .get(input.channelId, input.platform, input.idType, input.externalId) as
    | { personId: string }
    | undefined;
  if (existing) return existing.personId;
  const personId = `person:${input.channelId}:${input.idType}:${input.externalId}`;
  database
    .prepare(
      `INSERT INTO im_person_links
        (workspace_id, channel_id, platform, id_type, external_id, person_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, platform, id_type, external_id) DO NOTHING`,
    )
    .run(
      input.workspaceId,
      input.channelId,
      input.platform,
      input.idType,
      input.externalId,
      personId,
      Date.now(),
    );
  return personId;
}

export interface ForgetTargets {
  factIds: string[];
  /** 将随会话一起删除的摘要条数（仅 sessionId 选择器）。 */
  summaries: number;
  /** 将随会话一起删除的血缘行数（仅 sessionId 选择器）。 */
  lineage: number;
}

/**
 * 定位遗忘目标。预览与实际删除共用同一函数，避免“看到的”和“删掉的”不一致。
 */
export function locateForgetTargets(input: {
  workspaceId: string;
  sessionId?: string;
  personId?: string;
}): ForgetTargets {
  const database = openDb();
  const factIds = new Set<string>();
  if (input.sessionId) {
    const rows = database
      .prepare(`SELECT fact_id AS id FROM im_memory_lineage WHERE session_id = ?`)
      .all(input.sessionId) as Array<{ id: string }>;
    for (const row of rows) factIds.add(row.id);
  }
  if (input.personId) {
    const rows = database
      .prepare(
        `SELECT id FROM im_memory_facts
         WHERE workspace_id = ? AND scope_kind = 'person' AND scope_key = ?`,
      )
      .all(input.workspaceId, input.personId) as Array<{ id: string }>;
    for (const row of rows) factIds.add(row.id);
  }
  const count = (sql: string, ...params: Array<string>): number =>
    Number((database.prepare(sql).get(...params) as { n: number }).n);
  return {
    factIds: [...factIds],
    summaries: input.sessionId
      ? count(`SELECT COUNT(*) AS n FROM im_memory_summaries WHERE session_id = ?`, input.sessionId)
      : 0,
    lineage: input.sessionId
      ? count(`SELECT COUNT(*) AS n FROM im_memory_lineage WHERE session_id = ?`, input.sessionId)
      : 0,
  };
}

export interface MemoryStats {
  active: number;
  unreviewed: number;
  superseded: number;
  expired: number;
  persons: number;
  groups: number;
  byKind: Record<string, number>;
  byScope: Record<string, number>;
}

/** 总览统计：一次事务内多条 COUNT，不把全表拉到应用层。 */
export function getMemoryStats(workspaceId: string): MemoryStats {
  const database = openDb();
  const scalar = (sql: string, ...params: Array<string>): number =>
    Number((database.prepare(sql).get(...params) as { n: number }).n);
  const byKind: Record<string, number> = {};
  for (const row of database
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM im_memory_facts
       WHERE workspace_id = ? AND status = 'active' GROUP BY kind`,
    )
    .all(workspaceId) as Array<{ kind: string; n: number }>) {
    byKind[row.kind] = Number(row.n);
  }
  const byScope: Record<string, number> = {};
  for (const row of database
    .prepare(
      `SELECT scope_kind AS scope, COUNT(*) AS n FROM im_memory_facts
       WHERE workspace_id = ? AND status = 'active' GROUP BY scope_kind`,
    )
    .all(workspaceId) as Array<{ scope: string; n: number }>) {
    byScope[row.scope] = Number(row.n);
  }
  return {
    active: scalar(
      `SELECT COUNT(*) AS n FROM im_memory_facts WHERE workspace_id = ? AND status = 'active'`,
      workspaceId,
    ),
    unreviewed: scalar(
      `SELECT COUNT(*) AS n FROM im_memory_facts WHERE workspace_id = ? AND unreviewed = 1`,
      workspaceId,
    ),
    superseded: scalar(
      `SELECT COUNT(*) AS n FROM im_memory_facts WHERE workspace_id = ? AND status = 'superseded'`,
      workspaceId,
    ),
    expired: scalar(
      `SELECT COUNT(*) AS n FROM im_memory_facts WHERE workspace_id = ? AND status = 'expired'`,
      workspaceId,
    ),
    persons: scalar(
      `SELECT COUNT(DISTINCT scope_key) AS n FROM im_memory_facts
       WHERE workspace_id = ? AND scope_kind = 'person' AND status = 'active'`,
      workspaceId,
    ),
    groups: scalar(
      `SELECT COUNT(DISTINCT scope_key) AS n FROM im_memory_facts
       WHERE workspace_id = ? AND scope_kind = 'group' AND status = 'active'`,
      workspaceId,
    ),
    byKind,
    byScope,
  };
}

/** 近期变更流：按更新时间倒序，供总览展示“谁 · 什么 · 何时”。 */
export function listRecentFacts(workspaceId: string, limit = 20): MemoryFact[] {
  return listFactsPage({
    workspaceId,
    status: "all",
    includeUnreviewed: true,
    limit,
    offset: 0,
  }).facts;
}

/**
 * 遗忘：按会话或按人清除事实、摘要、FTS 与血缘，并登记 forgotten 防再摄入。
 * 返回各表删除计数，便于审计与 UI 展示。
 */
export function forgetMemory(input: {
  workspaceId: string;
  sessionId?: string;
  personId?: string;
  reason?: string;
}): { facts: number; summaries: number; lineage: number } {
  const database = openDb();
  const targets = locateForgetTargets(input);

  database.exec("BEGIN IMMEDIATE");
  try {
    // 先按会话清血缘：否则按 factId 删完后，按 sessionId 统计会变成 0，
    // 与预览数字对不上（预览用的是事务前的定位结果）。
    if (input.sessionId) {
      database.prepare(`DELETE FROM im_memory_lineage WHERE session_id = ?`).run(input.sessionId);
      database.prepare(`DELETE FROM im_memory_summaries WHERE session_id = ?`).run(input.sessionId);
    }
    for (const id of targets.factIds) {
      database.prepare(`DELETE FROM im_memory_facts_fts WHERE fact_id = ?`).run(id);
      database.prepare(`DELETE FROM im_memory_facts WHERE id = ?`).run(id);
      database.prepare(`DELETE FROM im_memory_lineage WHERE fact_id = ?`).run(id);
    }
    if (input.sessionId) {
      database
        .prepare(
          `INSERT INTO im_forgotten_sessions (workspace_id, session_id, forgotten_at, reason)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id, session_id) DO UPDATE SET
             forgotten_at = excluded.forgotten_at, reason = excluded.reason`,
        )
        .run(input.workspaceId, input.sessionId, Date.now(), input.reason ?? "manual");
    }
    database.exec("COMMIT");
    // 计数一律取事务前的定位结果，保证与预览逐项相等。
    return {
      facts: targets.factIds.length,
      summaries: targets.summaries,
      lineage: targets.lineage,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function isForgottenSession(workspaceId: string, sessionId: string): boolean {
  const row = openDb()
    .prepare(`SELECT 1 AS ok FROM im_forgotten_sessions WHERE workspace_id = ? AND session_id = ?`)
    .get(workspaceId, sessionId);
  return Boolean(row);
}
