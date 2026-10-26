/**
 * memory 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */

export const DDL = `

    -- ---- 长期记忆（P1）----
    -- 事实只做逻辑失效（status + valid_to），保留历史以回答“以前怎样”。
    CREATE TABLE IF NOT EXISTS im_memory_facts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      channel_id TEXT,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('person', 'group')),
      scope_key TEXT NOT NULL,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'decision', 'constraint')),
      slug TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'expired')),
      confidence TEXT NOT NULL DEFAULT 'unknown',
      unreviewed INTEGER NOT NULL DEFAULT 1,
      source_session_id TEXT,
      source_message_id TEXT,
      valid_from TEXT,
      valid_to TEXT,
      recorded_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      supersedes_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_im_memory_facts_scope
      ON im_memory_facts(workspace_id, scope_kind, scope_key, status, updated_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS im_memory_facts_fts USING fts5(
      fact_id UNINDEXED,
      slug,
      subject,
      body,
      tokenize='trigram'
    );

    -- 会话滚动摘要：covered_through_position 只进不退。
    CREATE TABLE IF NOT EXISTS im_memory_summaries (
      session_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL DEFAULT '',
      covered_through_position INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- 血缘：事实 ↔ 来源会话/消息，供 forget 精确定位。
    CREATE TABLE IF NOT EXISTS im_memory_lineage (
      fact_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT,
      actor TEXT,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_im_memory_lineage_session
      ON im_memory_lineage(session_id);

    -- 已遗忘会话：抽取与回填据此跳过，防止“删了又回来”。
    CREATE TABLE IF NOT EXISTS im_forgotten_sessions (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      forgotten_at INTEGER NOT NULL,
      reason TEXT,
      PRIMARY KEY (workspace_id, session_id)
    );

    -- 平台外部身份 → canonical person；ID 类型参与唯一键，避免 staffId/openId 混用。
    CREATE TABLE IF NOT EXISTS im_person_links (
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      id_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (channel_id, platform, id_type, external_id)
    );`;
