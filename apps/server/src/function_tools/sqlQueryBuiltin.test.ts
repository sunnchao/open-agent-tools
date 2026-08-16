import { test } from "node:test";
import assert from "node:assert/strict";
import { validateQuerySql, executeQuerySql } from "./sqlQueryBuiltin.js";

test("validateQuerySql 通过合法只读 SQL", () => {
  assert.doesNotThrow(() =>
    validateQuerySql("SELECT user_id, model_name FROM `logs` WHERE type=2 LIMIT 10"),
  );
});

test("validateQuerySql 拒绝 DML/DDL/危险函数", () => {
  assert.throws(() => validateQuerySql("DELETE FROM `logs`"), /禁止/);
  assert.throws(() => validateQuerySql("UPDATE `users` SET status=2"), /禁止/);
  assert.throws(() => validateQuerySql("DROP TABLE `logs`"), /禁止/);
  assert.throws(() => validateQuerySql("SELECT SLEEP(10)"), /禁止/);
});

test("validateQuerySql 拒绝多语句", () => {
  assert.throws(() => validateQuerySql("SELECT 1; SELECT 2"), /单条/);
  assert.throws(() => validateQuerySql("SELECT 1; DELETE FROM `logs`"), /单条|禁止/);
});

test("validateQuerySql 拒绝非 SELECT", () => {
  assert.throws(() => validateQuerySql("INSERT INTO `logs` VALUES (1)"), /禁止/);
  assert.throws(() => validateQuerySql("TRUNCATE `logs`"), /禁止/);
});

test("validateQuerySql 拒绝空 SQL", () => {
  assert.throws(() => validateQuerySql("  "), /不能为空/);
});

test("executeQuerySql 无 REPORT_DATABASE_URL 时返回错误而非崩溃", async () => {
  const prev = process.env.REPORT_DATABASE_URL;
  delete process.env.REPORT_DATABASE_URL;
  try {
    const r = await executeQuerySql("SELECT 1");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /REPORT_DATABASE_URL/);
  } finally {
    if (prev !== undefined) process.env.REPORT_DATABASE_URL = prev;
  }
});

test("executeQuerySql 危险 SQL 在连库前被拦截", async () => {
  const r = await executeQuerySql("DELETE FROM `logs`");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /禁止/);
});
