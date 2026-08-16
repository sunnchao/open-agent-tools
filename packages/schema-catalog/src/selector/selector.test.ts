import { test } from "node:test";
import assert from "node:assert/strict";
import { PreRegisteredSelector, searchTables } from "./selector.js";
import type { SchemaCatalog } from "../types.js";

function makeCatalog(): SchemaCatalog {
  const base = { schema: "demo", collectedAt: "", source: "mysql" as const, database: "demo" };
  return {
    ...base,
    tables: [
      {
        table: { name: "report_submission", schema: "demo", comment: "报表提交记录", collectedAt: "" },
        columns: [
          { table: "report_submission", schema: "demo", name: "id", columnType: "bigint", nullable: false, isPrimary: true, isUnique: true, hasIndex: true, tier: "required", sensitivity: "normal" },
          { table: "report_submission", schema: "demo", name: "status", columnType: "varchar(16)", nullable: false, isPrimary: false, isUnique: false, hasIndex: true, comment: "审批状态", tier: "required", sensitivity: "normal" },
        ],
        relations: [],
        enums: [{ table: "report_submission", column: "status", values: [{ value: "PENDING", meaning: "待审批" }, { value: "APPROVED", meaning: "已通过" }] }],
        samples: [],
      },
      {
        table: { name: "org", schema: "demo", comment: "组织字典", collectedAt: "" },
        columns: [{ table: "org", schema: "demo", name: "id", columnType: "bigint", nullable: false, isPrimary: true, isUnique: true, hasIndex: true, tier: "required", sensitivity: "normal" }],
        relations: [],
        enums: [],
        samples: [],
      },
    ],
  };
}

test("预注册选择器：按意图取表", () => {
  const sel = new PreRegisteredSelector([
    { intent: "report_approval_query", tables: ["report_submission", "org"] },
  ]);
  const tables = sel.selectTables(makeCatalog(), "report_approval_query");
  assert.equal(tables.length, 2);
  assert.deepEqual(tables.map((t) => t.table.name).sort(), ["org", "report_submission"]);
});

test("预注册选择器：未知意图返回空", () => {
  const sel = new PreRegisteredSelector([]);
  assert.equal(sel.selectTables(makeCatalog(), "whatever").length, 0);
});

test("语义检索兜底：按关键词选表", () => {
  const hits = searchTables(makeCatalog(), "待审批的报表", 3);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.table.table.name, "report_submission");
});
