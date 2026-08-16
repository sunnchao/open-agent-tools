/**
 * 内置 query_sql（方案 C：Agent 侧直连数据库）。
 *
 * 背景：MCP Worker 容器 network:"none" + 无 env，工具容器无法连库。
 * 方案 C = server（Agent）持有 REPORT_DATABASE_URL，直连 MySQL 执行 LLM 生成的只读 SQL。
 *
 * 安全：护栏（黑名单/单语句/SELECT 限定）+ SELECT 外层包 LIMIT + 只读账号建议。
 */
import { createMysqlPool, type MysqlPool } from "@open-agent-tools/database/mysql";

export const QUERY_SQL_TOOL = {
  type: "function" as const,
  function: {
    name: "query_sql",
    description:
      "执行只读 SELECT 查询 NEW-API 运营数据（数据表 schema 见系统提示中的 schema 上下文）。" +
      "返回 JSON 行数组。规则：表名/列名用反引号；时间戳为 Unix 秒；大表必须带 WHERE 过滤。" +
      "示例：SELECT user_id, model_name, quota, created_at FROM `logs` WHERE type=2 LIMIT 20",
    parameters: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "只读 SELECT 语句，由 LLM 生成，工具内置护栏",
        },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
} as const;

const BLOCKED =
  /\b(drop|truncate|delete|update|insert|alter|create|grant|revoke|copy|vacuum|rename|replace|load_file|outfile|dumpfile|sleep|benchmark|shutdown)\b/i;

let pool: MysqlPool | null = null;

function getPool(): MysqlPool {
  const url = process.env.REPORT_DATABASE_URL;
  if (!url) throw new Error("REPORT_DATABASE_URL is not configured");
  pool ??= createMysqlPool(url, { connectionLimit: 5 });
  return pool;
}

/** 护栏：黑名单 + 单语句 + SELECT 限定。 */
export function validateQuerySql(sql: string): void {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("SQL 不能为空");
  }
  if (BLOCKED.test(sql)) {
    throw new Error("SQL 包含被禁止的关键字（仅允许只读 SELECT）");
  }
  const statements = sql.split(";").filter((s) => s.trim().length > 0);
  if (statements.length > 1) {
    throw new Error("仅允许单条 SQL 语句");
  }
  if (!/^\s*(select|show|describe|explain)\b/i.test(sql.trim())) {
    throw new Error("仅允许 SELECT 类只读语句");
  }
}

/** 执行只读 SQL，返回行数组或错误。 */
export async function executeQuerySql(sql: string): Promise<{ ok: boolean; rows?: unknown[]; error?: string; durationMs: number }> {
  const started = Date.now();
  try {
    validateQuerySql(sql);
    const wrapped = `SELECT * FROM (${sql.replace(/;\s*$/, "")}) _q LIMIT 100`;
    const [rows] = await getPool().pool.query({ sql: wrapped, timeout: 10_000 });
    return { ok: true, rows: (rows as unknown[]).slice(0, 100), durationMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
  }
}

/** 测试辅助：重置连接池。 */
export function __resetPool(): void {
  void pool?.close();
  pool = null;
}
