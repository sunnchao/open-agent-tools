import { test } from "node:test";
import assert from "node:assert/strict";
import { collectMysqlCatalog } from "./mysqlCollector.js";
import { renderSkeleton, renderTableSchema, renderTableSchemaTiered, estimateTokens } from "../render/render.js";

const MYSQL_TEST_URL = process.env.MYSQL_TEST_URL;

test("collectMysqlCatalog 需要连接串里的库名", async () => {
  await assert.rejects(
    () =>
      collectMysqlCatalog({
        connectionString: "mysql://user:pass@localhost:3306/",
        database: "",
      }),
    /无法确定目标数据库/,
  );
});

test("collectMysqlCatalog 无可用库时抛连接错误", { skip: !MYSQL_TEST_URL }, async () => {
  // 指向一个不存在的库名，验证错误传播而非静默
  await assert.rejects(
    () =>
      collectMysqlCatalog({
        connectionString: MYSQL_TEST_URL!,
        database: "no_such_db_xyz",
      }),
    (err: unknown) => {
      const e = err as { code?: string };
      // mysql2 错误码 ER_BAD_DB_ERROR / ER_NO_SUCH_TABLE 均属传播范畴
      return typeof e.code === "string";
    },
  );
});

test("渲染：骨架 / 按表 / 分档", () => {
  const catalog = {
    source: "mysql" as const,
    database: "demo",
    collectedAt: "2026-08-16T00:00:00.000Z",
    tables: [
      {
        table: { name: "report_submission", schema: "demo", comment: "报表提交记录", approxRows: 120000, collectedAt: "" },
        columns: [
          { table: "report_submission", schema: "demo", name: "id", columnType: "bigint", nullable: false, isPrimary: true, isUnique: true, hasIndex: true, tier: "required" as const, sensitivity: "normal" as const },
          { table: "report_submission", schema: "demo", name: "report_no", columnType: "varchar(32)", nullable: false, isPrimary: false, isUnique: true, hasIndex: true, comment: "报表编号", tier: "required" as const, sensitivity: "normal" as const },
          { table: "report_submission", schema: "demo", name: "status", columnType: "varchar(16)", nullable: false, isPrimary: false, isUnique: false, hasIndex: true, comment: "审批状态", tier: "required" as const, sensitivity: "normal" as const },
          { table: "report_submission", schema: "demo", name: "amount", columnType: "decimal(10,2)", nullable: true, isPrimary: false, isUnique: false, hasIndex: false, comment: "金额", tier: "full" as const, sensitivity: "normal" as const },
        ],
        relations: [{ fromTable: "report_submission", fromColumn: "org_id", toTable: "org", toColumn: "id" }],
        enums: [],
        samples: [],
      },
    ],
  } as never;

  const skeleton = renderSkeleton(catalog);
  assert.match(skeleton, /report_submission/);
  assert.match(skeleton, /12\.0万/);
  assert.match(skeleton, /报表提交记录/);

  const full = renderTableSchema(catalog.tables[0]!);
  assert.match(full, /`id` bigint/);
  assert.match(full, /amount/);
  assert.match(full, /报表编号/);
  assert.match(full, /org_id → org\.id/);

  const tiered = renderTableSchemaTiered(catalog.tables[0]!);
  assert.doesNotMatch(tiered, /amount/); // full 档被裁掉
  assert.match(tiered, /status/);

  const t = estimateTokens(full);
  assert.ok(t > 10 && t < 1000, `token 估算异常: ${t}`);
});
