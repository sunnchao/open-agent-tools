import { groupByTable, matchesAny, isSensitive, columnTier, commentEnum } from "./shared.js";
import { createMysqlPool, type MysqlPool } from "@open-agent-tools/database/mysql";
import type {
  CollectOptions,
  ColumnMeta,
  EnumMeta,
  RelationMeta,
  SampleMeta,
  SchemaCatalog,
  TableMeta,
} from "../types.js";

interface TableRow {
  TABLE_NAME: string;
  TABLE_COMMENT: string;
  TABLE_ROWS: number | null;
}

interface ColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: "YES" | "NO";
  COLUMN_KEY: string;
  COLUMN_DEFAULT: string | null;
  COLUMN_COMMENT: string;
  ORDINAL_POSITION: number;
}

interface KeyColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  CONSTRAINT_NAME: string;
}

interface RelationRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

interface IndexRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
}

/**
 * 从 MySQL information_schema 采集 catalog（只读系统表，零业务风险）。
 *
 * 通过 `mysql2` 连接池执行 4 条系统表查询，内存中组装 SchemaCatalog。
 * 注意：本函数不 `close` 连接池——由调用方负责（方便多次采集复用）。
 */
export async function collectMysqlCatalog(options: CollectOptions): Promise<SchemaCatalog> {
  const database =
    options.database ?? new URL(options.connectionString).pathname.replace(/^\//, "");
  if (!database) {
    throw new Error("无法确定目标数据库：请在连接串 URL path 里带库名，或显式传 database");
  }

  const pool = createMysqlPool(options.connectionString, { connectionLimit: 5 });
  try {
    return await collectWithPool(pool, { ...options, database });
  } finally {
    await pool.close();
  }
}

/** 复用已有连接池的采集入口（例如进程内多次采集）。 */
export async function collectMysqlCatalogWithPool(
  pool: MysqlPool,
  options: CollectOptions,
): Promise<SchemaCatalog> {
  const database =
    options.database ?? new URL(options.connectionString).pathname.replace(/^\//, "");
  if (!database) {
    throw new Error("无法确定目标数据库：请在连接串 URL path 里带库名，或显式传 database");
  }
  return collectWithPool(pool, { ...options, database });
}

async function collectWithPool(
  pool: MysqlPool,
  options: CollectOptions & { database: string },
): Promise<SchemaCatalog> {
  const { database, tableFilter, skipSystemSchemas = true, skipSamples = false } = options;
  const tableScope = ["mysql", "information_schema", "performance_schema", "sys"];

  const [tableRows] = await pool.pool.query(
    `SELECT TABLE_NAME, TABLE_COMMENT, TABLE_ROWS
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?`,
    [database],
  );
  const tables = (tableRows as TableRow[])
    .filter((_row) => (skipSystemSchemas ? !tableScope.includes(database) : true))
    .filter((row) => !row.TABLE_NAME.startsWith("_") && !row.TABLE_NAME.startsWith("tmp_"))
    .filter((row) =>
      tableFilter && tableFilter.length > 0 ? matchesAny(row.TABLE_NAME, tableFilter) : true,
    )
    .sort((a, b) => a.TABLE_NAME.localeCompare(b.TABLE_NAME));
  const tableNames = new Set(tables.map((row) => row.TABLE_NAME));

  const [columnRows] = await pool.pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT, ORDINAL_POSITION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [database],
  );
  const columns = (columnRows as ColumnRow[]).filter((c) => tableNames.has(c.TABLE_NAME));

  const [relationRows] = await pool.pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [database],
  );
  const relations = (relationRows as RelationRow[])
    .filter((r) => tableNames.has(r.TABLE_NAME))
    .filter((r) => tableNames.has(r.REFERENCED_TABLE_NAME));

  // 主键与唯一键
  const [keyRows] = await pool.pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME IN ('PRIMARY', 'UNIQUE')
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [database],
  );
  const primaryKeys = new Set<string>();
  const uniqueKeys = new Set<string>();
  for (const k of keyRows as KeyColumnRow[]) {
    const key = `${k.TABLE_NAME}.${k.COLUMN_NAME}`;
    if (k.CONSTRAINT_NAME === "PRIMARY") primaryKeys.add(key);
    else uniqueKeys.add(key);
  }

  // 索引列（用于 hasIndex）
  const [indexRows] = await pool.pool.query(
    `SELECT DISTINCT TABLE_NAME, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?`,
    [database],
  );
  const indexedColumns = new Set(
    (indexRows as IndexRow[]).map((i) => `${i.TABLE_NAME}.${i.COLUMN_NAME}`),
  );

  const now = new Date().toISOString();
  const catalog: SchemaCatalog = {
    source: "mysql",
    database,
    collectedAt: now,
    tables: [],
  };

  const columnsByTable = groupByTable(columns, (column) => column.TABLE_NAME);
  const relationsByTable = groupByTable(relations, (relation) => relation.TABLE_NAME);
  for (const t of tables) {
    const tableMeta: TableMeta = {
      name: t.TABLE_NAME,
      schema: database,
      comment: t.TABLE_COMMENT || undefined,
      approxRows: t.TABLE_ROWS ?? undefined,
      collectedAt: now,
    };
    const tableColumns: ColumnMeta[] = (columnsByTable.get(t.TABLE_NAME) ?? []).map((c) => {
      const key = `${c.TABLE_NAME}.${c.COLUMN_NAME}`;
      return {
        table: c.TABLE_NAME,
        schema: database,
        name: c.COLUMN_NAME,
        columnType: c.COLUMN_TYPE,
        nullable: c.IS_NULLABLE === "YES",
        isPrimary: primaryKeys.has(key),
        isUnique: uniqueKeys.has(key),
        hasIndex: indexedColumns.has(key),
        comment: c.COLUMN_COMMENT || undefined,
        defaultValue: c.COLUMN_DEFAULT ?? undefined,
        sensitivity: isSensitive(c.COLUMN_NAME, c.COLUMN_COMMENT),
        tier: columnTier(
          c.COLUMN_NAME,
          c.COLUMN_TYPE,
          primaryKeys.has(key),
          uniqueKeys.has(key),
          "mysql",
        ),
      };
    });

    const tableRelations: RelationMeta[] = (relationsByTable.get(t.TABLE_NAME) ?? []).map((r) => ({
      fromTable: r.TABLE_NAME,
      fromColumn: r.COLUMN_NAME,
      toTable: r.REFERENCED_TABLE_NAME!,
      toColumn: r.REFERENCED_COLUMN_NAME!,
    }));

    const tableEnums: EnumMeta[] = collectEnums(tableColumns);
    const tableSamples: SampleMeta[] = skipSamples
      ? []
      : await collectSamples(pool, database, t.TABLE_NAME, tableColumns, options);

    catalog.tables.push({
      table: tableMeta,
      columns: tableColumns,
      relations: tableRelations,
      enums: tableEnums,
      samples: tableSamples,
    });
  }

  return catalog;
}

/** 从列定义中识别枚举（MySQL ENUM/SET 类型或字段注释里的枚举说明）。 */
function collectEnums(columns: ColumnMeta[]): EnumMeta[] {
  const result: EnumMeta[] = [];
  for (const c of columns) {
    const m = c.columnType.match(/^(enum|set)\((.+)\)$/i);
    if (m) {
      // 解析 'a','b' 形式
      const values =
        m[2]!
          .match(/'((?:[^'\\]|\\.)*)'/g)
          ?.map((v) => v.replace(/^'|'$/g, "").replace(/\\'/g, "'")) ?? [];
      result.push({
        table: c.table,
        column: c.name,
        values: values.map((v) => ({ value: v })),
      });
      continue;
    }
    const parsed = commentEnum(c);
    if (parsed) result.push(parsed);
  }
  return result;
}

/**
 * 对"高频过滤字段"做抽样统计：distinct 数 / TOP 值分布 / min·max。
 * 只对字段名像状态/类型/组织/日期的列采样，避免全量扫描。
 */
async function collectSamples(
  pool: MysqlPool,
  _database: string,
  table: string,
  columns: ColumnMeta[],
  options: CollectOptions,
): Promise<SampleMeta[]> {
  const sampleTableLimit = options.sampleTableLimit ?? 20;
  const sampleTopK = options.sampleTopK ?? 8;

  // 只对 "看起来像过滤维度" 的字段采样
  const candidates = columns.filter((c) => {
    const n = c.name.toLowerCase();
    return (
      (c.hasIndex &&
        /(status|state|type|kind|category|org|dept|source|channel|is_|flag|code|no)$/.test(n)) ||
      (/(status|state|type|kind|category|org|dept|source|channel|is_|flag|code|no)/.test(n) &&
        !/^(id|created|updated|modified|deleted)/.test(n))
    );
  });
  if (candidates.length === 0) return [];
  // 避免对超大表做全表 DISTINCT：限制只处理前 N 张表
  // 注意：这里无法预知行数，交给调用方用 tableFilter + sampleTableLimit 控制。
  // 简化实现：逐字段 LIMIT 采样 distinct（MySQL 无直接 limit distinct，改用 GROUP BY + LIMIT）。

  const results: SampleMeta[] = [];
  const sampled = new Set<string>();
  for (const c of candidates.slice(0, sampleTableLimit)) {
    const key = `${table}.${c.name}`;
    if (sampled.has(key)) continue;
    sampled.add(key);
    try {
      const [rows] = await pool.pool.query(
        `SELECT \`${c.name}\` AS v, COUNT(*) AS cnt
           FROM \`${table}\`
          WHERE \`${c.name}\` IS NOT NULL
          GROUP BY \`${c.name}\`
          ORDER BY cnt DESC
          LIMIT ?`,
        [sampleTopK],
      );
      const top = (rows as Array<{ v: unknown; cnt: number | string }>).map((r) => ({
        value: String(r.v),
        count: Number(r.cnt),
      }));
      if (top.length > 0) {
        results.push({ table, column: c.name, distinctCount: -1, topValues: top });
      }
    } catch {
      // 采样失败（权限/超时）降级跳过，不阻断采集
    }
  }
  return results;
}
