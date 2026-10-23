/**
 * SQL 问数和 AI Query 共用的 SQL 校验与执行原语。
 *
 * 安全：护栏（黑名单/单语句/SELECT 限定）+ 最多返回 100 行 + 只读账号建议。
 */
import { createMysqlPool, type MysqlPool } from "@open-agent-tools/database/mysql";
import { createPostgresPool } from "@open-agent-tools/database/postgres";
import { quotePostgresIdentifier } from "@open-agent-tools/schema-catalog";

const BLOCKED =
  /\b(drop|truncate|delete|update|insert|alter|create|grant|revoke|copy|vacuum|rename|replace|load_file|outfile|dumpfile|sleep|benchmark|shutdown)\b/i;

/** 问数结果硬上限。用户要求更少时保留其 LIMIT；未写或超过上限时钳到此值。 */
export const QUERY_ROW_CAP = 100;

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

/**
 * 把显式 LIMIT 钳到 QUERY_ROW_CAP。
 * 未写 LIMIT 表示用户已确认查询全部，不再补默认上限。
 * 已有 LIMIT 时直接改写该数字：MySQL 不允许派生表里再带 LIMIT，不能再外包一层。
 */
export function capQuerySql(sql: string, cap = QUERY_ROW_CAP): string {
  const body = sql.replace(/;\s*$/, "").trim();
  const limited = body.match(/\blimit\s+(\d+)\s*$/i);
  if (!limited || limited.index === undefined) return body;
  const requested = Number(limited[1]);
  const next = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), cap) : cap;
  return `${body.slice(0, limited.index)}LIMIT ${next}`;
}

export interface QuerySqlResult {
  ok: boolean;
  rows?: unknown[];
  /** 原 SQL 的 LIMIT 超过安全上限，执行前已被钳制。 */
  truncated?: boolean;
  error?: string;
  durationMs: number;
}

/** 执行只读 SQL，返回行数组或错误。params 用于权限 IN 列表绑定，禁止把授权值拼进 SQL。 */
export async function executeQuerySql(
  sql: string,
  params: unknown[] = [],
): Promise<QuerySqlResult> {
  const started = Date.now();
  try {
    validateQuerySql(sql);
    const wrapped = capQuerySql(sql);
    const [rows] = await getPool().pool.query({ sql: wrapped, timeout: 10_000, values: params });
    return {
      ok: true,
      rows: (rows as unknown[]).slice(0, QUERY_ROW_CAP),
      truncated: wrapped !== sql.replace(/;\s*$/, "").trim(),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

/** 按已配置 Schema 源执行查询；连接只在本次请求内存活，避免多源凭据交叉复用。 */
export async function executeQuerySqlWithConnection(
  sql: string,
  connectionString: string,
  params: unknown[] = [],
  options?: {
    connector?: "mysql" | "postgresql";
    database?: string;
    schema?: string;
  },
): Promise<QuerySqlResult> {
  const started = Date.now();
  if (options?.connector === "postgresql") {
    let sourcePool: ReturnType<typeof createPostgresPool> | null = null;
    try {
      validateQuerySql(sql);
      sourcePool = createPostgresPool(connectionString, {
        max: 1,
        ...(options.database ? { database: options.database } : {}),
      });
      const client = await sourcePool.pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query("SET LOCAL statement_timeout = '10s'");
        if (options.schema) {
          await client.query(`SET LOCAL search_path TO ${quotePostgresIdentifier(options.schema)}`);
        }
        const wrapped = capQuerySql(sql);
        const result = await client.query(wrapped, params);
        return {
          ok: true,
          rows: result.rows.slice(0, QUERY_ROW_CAP),
          truncated: wrapped !== sql.replace(/;\s*$/, "").trim(),
          durationMs: Date.now() - started,
        };
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    } finally {
      await sourcePool?.close();
    }
  }
  let sourcePool: MysqlPool | null = null;
  try {
    validateQuerySql(sql);
    sourcePool = createMysqlPool(connectionString, {
      connectionLimit: 1,
      ...(options?.database ? { database: options.database } : {}),
    });
    const wrapped = capQuerySql(sql);
    const [rows] = await sourcePool.pool.query({ sql: wrapped, timeout: 10_000, values: params });
    return {
      ok: true,
      rows: (rows as unknown[]).slice(0, QUERY_ROW_CAP),
      truncated: wrapped !== sql.replace(/;\s*$/, "").trim(),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  } finally {
    await sourcePool?.close();
  }
}

/** 测试辅助：重置连接池。 */
export function __resetPool(): void {
  void pool?.close();
  pool = null;
}
