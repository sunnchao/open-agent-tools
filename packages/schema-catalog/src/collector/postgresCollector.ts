import { groupByTable, matchesAny, isSensitive, columnTier, commentEnum } from "./shared.js";
import { createPostgresPool, type PostgresPool } from "@open-agent-tools/database/postgres";
import type {
  CollectOptions,
  ColumnMeta,
  EnumMeta,
  RelationMeta,
  SampleMeta,
  SchemaCatalog,
  TableMeta,
} from "../types.js";
import { quotePostgresIdentifier } from "../sql.js";

interface TableRow {
  table_schema: string;
  table_name: string;
  table_comment: string | null;
  approx_rows: number | string | null;
}

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  column_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  column_comment: string | null;
  ordinal_position: number;
}

interface KeyRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  constraint_type: "PRIMARY KEY" | "UNIQUE";
}

interface RelationRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

interface IndexRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

/**
 * 从 PostgreSQL 系统目录采集 catalog。
 *
 * 采集只读 information_schema / pg_catalog，连接池由本函数创建并关闭；
 * 调用方若需要复用连接，可使用 `collectPostgresCatalogWithPool`。
 */
export async function collectPostgresCatalog(options: CollectOptions): Promise<SchemaCatalog> {
  const database = databaseFromOptions(options);
  const pool = createPostgresPool(options.connectionString, {
    max: 5,
    ...(options.database ? { database } : {}),
  });
  try {
    return await collectWithPool(pool, { ...options, database });
  } finally {
    await pool.close();
  }
}

/** 复用已有连接池的 PostgreSQL 采集入口。 */
export async function collectPostgresCatalogWithPool(
  pool: PostgresPool,
  options: CollectOptions,
): Promise<SchemaCatalog> {
  return collectWithPool(pool, { ...options, database: databaseFromOptions(options) });
}

async function collectWithPool(
  pool: PostgresPool,
  options: CollectOptions & { database: string },
): Promise<SchemaCatalog> {
  const { tableFilter, skipSamples = false } = options;
  const schema = options.schema?.trim() || "public";
  const [tableResult, columnResult, keyResult, relationResult, indexResult] = await Promise.all([
    pool.pool.query<TableRow>(
      `
      SELECT t.table_schema,
             t.table_name,
             obj_description(format('%I.%I', t.table_schema, t.table_name)::regclass, 'pg_class') AS table_comment,
             COALESCE(s.n_live_tup, 0) AS approx_rows
        FROM information_schema.tables t
        LEFT JOIN pg_stat_user_tables s
          ON s.schemaname = t.table_schema AND s.relname = t.table_name
       WHERE t.table_catalog = current_database()
         AND t.table_type = 'BASE TABLE'
         AND t.table_schema = $1
       ORDER BY t.table_schema, t.table_name
    `,
      [schema],
    ),
    pool.pool.query<ColumnRow>(
      `
      SELECT c.table_schema,
             c.table_name,
             c.column_name,
             format_type(a.atttypid, a.atttypmod) AS column_type,
             c.is_nullable,
             c.column_default,
             col_description(a.attrelid, a.attnum) AS column_comment,
             c.ordinal_position
        FROM information_schema.columns c
        JOIN pg_namespace n ON n.nspname = c.table_schema
        JOIN pg_class r ON r.relnamespace = n.oid AND r.relname = c.table_name
        JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.column_name
       WHERE c.table_catalog = current_database()
         AND c.table_schema = $1
       ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `,
      [schema],
    ),
    pool.pool.query<KeyRow>(
      `
      SELECT kcu.table_schema,
             kcu.table_name,
             kcu.column_name,
             tc.constraint_type
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_catalog = tc.constraint_catalog
         AND kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
         AND kcu.table_name = tc.table_name
       WHERE tc.table_catalog = current_database()
         AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
         AND tc.table_schema = $1
    `,
      [schema],
    ),
    pool.pool.query<RelationRow>(
      `
      SELECT kcu.table_schema,
             kcu.table_name,
             kcu.column_name,
             referenced.table_schema AS foreign_table_schema,
             referenced.table_name AS foreign_table_name,
             referenced.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_catalog = tc.constraint_catalog
         AND kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
         AND kcu.table_name = tc.table_name
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_catalog = tc.constraint_catalog
         AND rc.constraint_schema = tc.constraint_schema
         AND rc.constraint_name = tc.constraint_name
        JOIN information_schema.key_column_usage referenced
          ON referenced.constraint_catalog = rc.unique_constraint_catalog
         AND referenced.constraint_schema = rc.unique_constraint_schema
         AND referenced.constraint_name = rc.unique_constraint_name
         AND referenced.ordinal_position = kcu.position_in_unique_constraint
       WHERE tc.table_catalog = current_database()
         AND tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1
         AND referenced.table_schema = $1
    `,
      [schema],
    ),
    pool.pool.query<IndexRow>(
      `
      SELECT n.nspname AS table_schema,
             c.relname AS table_name,
             a.attname AS column_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_index i ON i.indrelid = c.oid
        JOIN LATERAL unnest(i.indkey) AS key(attnum) ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = key.attnum
       WHERE c.relkind IN ('r', 'p')
         AND n.nspname = $1
    `,
      [schema],
    ),
  ]);

  const tables = tableResult.rows
    .filter((row) => !row.table_name.startsWith("_") && !row.table_name.startsWith("tmp_"))
    .filter((row) =>
      tableFilter && tableFilter.length > 0 ? matchesAny(row.table_name, tableFilter) : true,
    );
  const tableKeys = new Set(tables.map((row) => tableKey(row.table_schema, row.table_name)));
  const columns = columnResult.rows.filter((row) =>
    tableKeys.has(tableKey(row.table_schema, row.table_name)),
  );
  const keys = keyResult.rows.filter((row) =>
    tableKeys.has(tableKey(row.table_schema, row.table_name)),
  );
  const relations = relationResult.rows.filter(
    (row) =>
      tableKeys.has(tableKey(row.table_schema, row.table_name)) &&
      tableKeys.has(tableKey(row.foreign_table_schema, row.foreign_table_name)),
  );
  const indexedColumns = new Set(
    indexResult.rows.map((row) =>
      tableColumnKey(row.table_schema, row.table_name, row.column_name),
    ),
  );
  const primaryKeys = new Set(
    keys
      .filter((row) => row.constraint_type === "PRIMARY KEY")
      .map((row) => tableColumnKey(row.table_schema, row.table_name, row.column_name)),
  );
  const uniqueKeys = new Set(
    keys
      .filter((row) => row.constraint_type === "UNIQUE")
      .map((row) => tableColumnKey(row.table_schema, row.table_name, row.column_name)),
  );
  const now = new Date().toISOString();
  const catalog: SchemaCatalog = {
    source: "postgresql",
    database: schema,
    collectedAt: now,
    tables: [],
  };

  const columnsByTable = groupByTable(columns, tableKeyForRow);
  const relationsByTable = groupByTable(relations, tableKeyForRow);
  for (const table of tables) {
    const tableKey = tableKeyForRow(table);
    const tableColumns: ColumnMeta[] = (columnsByTable.get(tableKey) ?? []).map((column) => {
      const key = tableColumnKey(column.table_schema, column.table_name, column.column_name);
      const isPrimary = primaryKeys.has(key);
      const isUnique = uniqueKeys.has(key);
      return {
        table: column.table_name,
        schema: column.table_schema,
        name: column.column_name,
        columnType: column.column_type,
        nullable: column.is_nullable === "YES",
        isPrimary,
        isUnique,
        hasIndex: indexedColumns.has(key),
        comment: column.column_comment || undefined,
        defaultValue: column.column_default ?? undefined,
        sensitivity: isSensitive(column.column_name, column.column_comment ?? undefined),
        tier: columnTier(column.column_name, column.column_type, isPrimary, isUnique, "postgresql"),
      };
    });
    const tableRelations: RelationMeta[] = (relationsByTable.get(tableKey) ?? []).map(
      (relation) => ({
        fromTable: relation.table_name,
        fromColumn: relation.column_name,
        toTable: relation.foreign_table_name,
        toColumn: relation.foreign_column_name,
      }),
    );
    const tableEnums: EnumMeta[] = tableColumns.flatMap((column) => {
      const parsed = commentEnum(column);
      return parsed ? [parsed] : [];
    });
    const tableSamples: SampleMeta[] = skipSamples
      ? []
      : await collectSamples(pool, table, tableColumns, options);

    const tableMeta: TableMeta = {
      name: table.table_name,
      schema: table.table_schema,
      comment: table.table_comment || undefined,
      approxRows: Number(table.approx_rows ?? 0),
      collectedAt: now,
    };
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

function databaseFromOptions(options: CollectOptions): string {
  const database = options.database?.trim() || decodeDatabase(new URL(options.connectionString));
  if (!database) {
    throw new Error("无法确定目标数据库：请在连接串 URL path 里带库名，或显式传 database");
  }
  return database;
}

function decodeDatabase(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function tableKeyForRow(row: { table_schema: string; table_name: string }): string {
  return tableKey(row.table_schema, row.table_name);
}

function tableColumnKey(schema: string, table: string, column: string): string {
  return `${schema}.${table}.${column}`;
}

async function collectSamples(
  pool: PostgresPool,
  table: TableRow,
  columns: ColumnMeta[],
  options: CollectOptions,
): Promise<SampleMeta[]> {
  const candidates = columns.filter((column) => {
    const name = column.name.toLowerCase();
    return (
      (column.hasIndex &&
        /(status|state|type|kind|category|org|dept|source|channel|is_|flag|code|no)$/.test(name)) ||
      (/(status|state|type|kind|category|org|dept|source|channel|is_|flag|code|no)/.test(name) &&
        !/^(id|created|updated|modified|deleted)/.test(name))
    );
  });
  const results: SampleMeta[] = [];
  for (const column of candidates.slice(0, options.sampleTableLimit ?? 20)) {
    const identifier = quotePostgresIdentifier(column.name);
    const tableIdentifier = `${quotePostgresIdentifier(table.table_schema)}.${quotePostgresIdentifier(table.table_name)}`;
    try {
      const result = await pool.pool.query<{ v: unknown; cnt: number | string }>(
        `SELECT ${identifier} AS v, COUNT(*) AS cnt
           FROM ${tableIdentifier}
          WHERE ${identifier} IS NOT NULL
          GROUP BY ${identifier}
          ORDER BY cnt DESC
          LIMIT $1`,
        [options.sampleTopK ?? 8],
      );
      const topValues = result.rows.map((row) => ({
        value: String(row.v),
        count: Number(row.cnt),
      }));
      if (topValues.length > 0) {
        results.push({
          table: table.table_name,
          column: column.name,
          distinctCount: -1,
          topValues,
        });
      }
    } catch {
      // 采样失败（权限/超时）降级跳过，不阻断采集。
    }
  }
  return results;
}
