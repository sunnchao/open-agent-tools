import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichNewApiCatalog } from "./newapi.js";
import type { SchemaCatalog } from "../types.js";

function makeCatalog(): SchemaCatalog {
  return {
    source: "mysql",
    database: "newapi",
    collectedAt: "2026-08-16T00:00:00.000Z",
    tables: [
      {
        table: { name: "users", schema: "newapi", collectedAt: "" },
        columns: [
          { table: "users", schema: "newapi", name: "id", columnType: "bigint", nullable: false, isPrimary: true, isUnique: true, hasIndex: true, tier: "required", sensitivity: "normal" },
          { table: "users", schema: "newapi", name: "status", columnType: "bigint", nullable: false, isPrimary: false, isUnique: false, hasIndex: false, tier: "required", sensitivity: "normal" },
          { table: "users", schema: "newapi", name: "password", columnType: "longtext", nullable: false, isPrimary: false, isUnique: false, hasIndex: false, tier: "full", sensitivity: "normal" },
        ],
        relations: [],
        enums: [],
        samples: [],
      },
      {
        table: { name: "unknown_table", schema: "newapi", collectedAt: "" },
        columns: [{ table: "unknown_table", schema: "newapi", name: "id", columnType: "bigint", nullable: false, isPrimary: true, isUnique: true, hasIndex: true, tier: "required", sensitivity: "normal" }],
        relations: [],
        enums: [],
        samples: [],
      },
    ],
  };
}

test("enrichNewApiCatalog 补充表注释", () => {
  const r = enrichNewApiCatalog(makeCatalog());
  const users = r.tables.find((t) => t.table.name === "users")!;
  assert.ok(users.table.comment?.includes("用户"));
});

test("enrichNewApiCatalog 补充枚举含义（status → 启用/禁用）", () => {
  const r = enrichNewApiCatalog(makeCatalog());
  const users = r.tables.find((t) => t.table.name === "users")!;
  const statusCol = users.columns.find((c) => c.name === "status")!;
  assert.deepEqual(statusCol.enumHint, { "1": "启用", "2": "禁用" });
  const statusEnum = users.enums.find((e) => e.column === "status")!;
  assert.equal(statusEnum.values.length, 2);
  assert.equal(statusEnum.values[0]!.meaning, "启用");
});

test("enrichNewApiCatalog 标记敏感字段（password → sensitive）", () => {
  const r = enrichNewApiCatalog(makeCatalog());
  const users = r.tables.find((t) => t.table.name === "users")!;
  const password = users.columns.find((c) => c.name === "password")!;
  assert.equal(password.sensitivity, "sensitive");
});

test("enrichNewApiCatalog 未知表不报错、不加注释", () => {
  const r = enrichNewApiCatalog(makeCatalog());
  const unknown = r.tables.find((t) => t.table.name === "unknown_table")!;
  assert.equal(unknown.table.comment, undefined);
});

test("enrichNewApiCatalog 幂等：二次执行不叠加", () => {
  const once = enrichNewApiCatalog(makeCatalog());
  const twice = enrichNewApiCatalog(once);
  const a = once.tables.find((t) => t.table.name === "users")!;
  const b = twice.tables.find((t) => t.table.name === "users")!;
  assert.equal(b.table.comment, a.table.comment);
  assert.deepEqual(b.enums, a.enums);
  // 枚举不重复追加
  assert.equal(b.enums.filter((e) => e.column === "status").length, 1);
});
