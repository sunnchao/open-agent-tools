import assert from "node:assert/strict";
import { test } from "node:test";
import type { SchemaCatalog, TableCatalog } from "@open-agent-tools/schema-catalog";
import { validateSchemaSql } from "./text2sql.js";

function table(name: string): TableCatalog {
  return {
    table: { name, schema: "demo", collectedAt: "" },
    columns: [],
    relations: [],
    enums: [],
    samples: [],
  };
}

const catalog: SchemaCatalog = {
  source: "mysql",
  database: "demo",
  collectedAt: "",
  tables: [table("logs"), table("users")],
};

test("validateSchemaSql 通过当前源中的 SELECT", () => {
  assert.doesNotThrow(() =>
    validateSchemaSql("SELECT user_id, model_name FROM `logs` WHERE type=2", catalog),
  );
});

test("validateSchemaSql 拒绝其它 Schema 源的表", () => {
  assert.throws(() => validateSchemaSql("SELECT * FROM options", catalog), /当前 Schema 源/);
  assert.throws(() => validateSchemaSql("SELECT * FROM mysql.users", catalog), /跨 Schema/);
  assert.doesNotThrow(() => validateSchemaSql("SELECT * FROM demo.users", catalog));
});

test("validateSchemaSql 拒绝写操作", () => {
  assert.throws(() => validateSchemaSql("DELETE FROM logs", catalog), /禁止/);
});

test("validateSchemaSql 支持 PostgreSQL 双引号与实际 schema", () => {
  const postgresCatalog: SchemaCatalog = {
    ...catalog,
    source: "postgresql",
    database: "reporting",
    tables: catalog.tables.map((entry) => ({
      ...entry,
      table: { ...entry.table, schema: "reporting" },
    })),
  };
  assert.doesNotThrow(() =>
    validateSchemaSql('SELECT * FROM "reporting"."users"', postgresCatalog),
  );
  assert.throws(
    () => validateSchemaSql('SELECT * FROM "private"."users"', postgresCatalog),
    /跨 Schema/,
  );
});
