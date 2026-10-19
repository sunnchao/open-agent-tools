import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogToDocuments, createSemanticSelector, type RetrievalFn } from "./semantic.js";
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
        enums: [{ table: "report_submission", column: "status", values: [{ value: "PENDING", meaning: "待审批" }] }],
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

test("catalogToDocuments：扁平化文档包含表名/注释/字段/枚举", () => {
  const docs = catalogToDocuments(makeCatalog());
  assert.equal(docs.length, 2);
  const report = docs.find((d) => d.id === "report_submission")!;
  assert.ok(report.content.includes("报表提交记录"));
  assert.ok(report.content.includes("status(审批状态)"));
  assert.ok(report.content.includes("PENDING=待审批"));
  assert.equal(report.metadata.schema, "demo");
});

test("createSemanticSelector：按检索命中映射回完整 schema", async () => {
  const retrieve: RetrievalFn = (_q, topK) => [
    { id: "report_submission", score: 0.9 },
    { id: "org", score: 0.4 },
  ].slice(0, topK);
  const sel = createSemanticSelector(makeCatalog(), retrieve);
  const hits = await sel.select("待审批的报表", 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.table.table.name, "report_submission");
  assert.equal(hits[0]!.score, 0.9);
});

test("createSemanticSelector：未知 id 被忽略", async () => {
  const retrieve: RetrievalFn = () => [{ id: "not_a_table", score: 1 }];
  const sel = createSemanticSelector(makeCatalog(), retrieve);
  const hits = await sel.select("随便", 3);
  assert.equal(hits.length, 0);
});
