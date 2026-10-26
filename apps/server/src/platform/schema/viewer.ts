/**
 * viewer 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */

export const DDL = `

    -- 短时身份断言的重放防护。jti 全库唯一；过期行按需清理。
    CREATE TABLE IF NOT EXISTS viewer_assertion_replays (
      replay_key TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_viewer_assertion_replays_expires
      ON viewer_assertion_replays(expires_at);`;
