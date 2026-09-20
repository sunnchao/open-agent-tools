import assert from "node:assert/strict";
import { test } from "node:test";
import { collectPostgresCatalog, collectPostgresCatalogWithPool } from "./postgresCollector.js";

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

test("collectPostgresCatalog 需要连接串里的库名", async () => {
  await assert.rejects(
    () =>
      collectPostgresCatalog({
        connectionString: "postgresql://user:pass@localhost:5432/",
        database: "",
      }),
    /无法确定目标数据库/,
  );
});

test("collectPostgresCatalogWithPool 映射表、字段、索引和外键", async () => {
  const query = async (sql: string) => {
    if (sql.includes("pg_stat_user_tables")) {
      return {
        rows: [
          {
            table_schema: "reporting",
            table_name: "orders",
            table_comment: "订单",
            approx_rows: "12",
          },
          {
            table_schema: "reporting",
            table_name: "users",
            table_comment: "用户",
            approx_rows: "3",
          },
        ],
      };
    }
    if (sql.includes("information_schema.columns")) {
      return {
        rows: [
          {
            table_schema: "reporting",
            table_name: "orders",
            column_name: "id",
            column_type: "bigint",
            is_nullable: "NO",
            column_default: null,
            column_comment: "主键",
            ordinal_position: 1,
          },
          {
            table_schema: "reporting",
            table_name: "orders",
            column_name: "user_id",
            column_type: "bigint",
            is_nullable: "NO",
            column_default: null,
            column_comment: null,
            ordinal_position: 2,
          },
          {
            table_schema: "reporting",
            table_name: "users",
            column_name: "id",
            column_type: "bigint",
            is_nullable: "NO",
            column_default: null,
            column_comment: "主键",
            ordinal_position: 1,
          },
        ],
      };
    }
    if (sql.includes("referential_constraints")) {
      return {
        rows: [
          {
            table_schema: "reporting",
            table_name: "orders",
            column_name: "user_id",
            foreign_table_schema: "reporting",
            foreign_table_name: "users",
            foreign_column_name: "id",
          },
        ],
      };
    }
    if (sql.includes("constraint_type IN")) {
      return {
        rows: [
          {
            table_schema: "reporting",
            table_name: "orders",
            column_name: "id",
            constraint_type: "PRIMARY KEY",
          },
          {
            table_schema: "reporting",
            table_name: "users",
            column_name: "id",
            constraint_type: "PRIMARY KEY",
          },
        ],
      };
    }
    if (sql.includes("pg_index")) {
      return {
        rows: [
          { table_schema: "reporting", table_name: "orders", column_name: "id" },
          { table_schema: "reporting", table_name: "orders", column_name: "user_id" },
          { table_schema: "reporting", table_name: "users", column_name: "id" },
        ],
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const catalog = await collectPostgresCatalogWithPool(
    { pool: { query }, close: async () => undefined } as never,
    {
      connectionString: "postgresql://u:p@localhost/analytics",
      database: "analytics",
      schema: "reporting",
      skipSamples: true,
    },
  );

  assert.equal(catalog.source, "postgresql");
  assert.equal(catalog.database, "reporting");
  assert.equal(catalog.tables.length, 2);
  const orders = catalog.tables.find((table) => table.table.name === "orders");
  assert.equal(orders?.table.approxRows, 12);
  assert.equal(orders?.columns.find((column) => column.name === "id")?.isPrimary, true);
  assert.equal(orders?.columns.find((column) => column.name === "user_id")?.hasIndex, true);
  assert.deepEqual(orders?.relations, [
    {
      fromTable: "orders",
      fromColumn: "user_id",
      toTable: "users",
      toColumn: "id",
    },
  ]);
});

test("collectPostgresCatalog 采集指定 schema", { skip: !POSTGRES_TEST_URL }, async () => {
  const catalog = await collectPostgresCatalog({
    connectionString: POSTGRES_TEST_URL!,
    schema: process.env.POSTGRES_TEST_SCHEMA || "public",
    skipSamples: true,
  });
  assert.equal(catalog.source, "postgresql");
  assert.equal(catalog.database, process.env.POSTGRES_TEST_SCHEMA || "public");
  assert.ok(catalog.tables.every((table) => table.table.schema === catalog.database));
});
