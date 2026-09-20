import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTableNames, maskSensitiveRows, validateDtmsQuerySql } from "./sqlGuard.js";

test("extractTableNames 解析 FROM/JOIN", () => {
  assert.deepEqual(extractTableNames("SELECT 1 FROM dtms_contract WHERE industry='煤炭'"), [
    "dtms_contract",
  ]);
  assert.deepEqual(
    extractTableNames(
      "SELECT a.id FROM `dtms_invoice` a JOIN dtms_contract b ON a.contract_outer_no=b.contract_outer_no",
    ),
    ["dtms_invoice", "dtms_contract"],
  );
});

test("validateDtmsQuerySql 通过白名单 SELECT", () => {
  assert.doesNotThrow(() =>
    validateDtmsQuerySql(
      "SELECT SUM(total_amount) AS `合同金额合计` FROM dtms_contract WHERE industry='煤炭' AND sign_date>='2026-08-01'",
    ),
  );
});

test("validateDtmsQuerySql 拒绝 NEW-API 表", () => {
  assert.throws(() => validateDtmsQuerySql("SELECT * FROM logs WHERE type=2"), /非 DTMS|白名单/);
  assert.throws(() => validateDtmsQuerySql("SELECT quota FROM users"), /非 DTMS|白名单|未引用/);
  assert.throws(() => validateDtmsQuerySql("SELECT * FROM `tokens`"), /非 DTMS|白名单/);
});

test("validateDtmsQuerySql 拒绝非白名单表与注释符", () => {
  assert.throws(() => validateDtmsQuerySql("SELECT * FROM secret_table"), /白名单/);
  assert.throws(() => validateDtmsQuerySql("SELECT 1 FROM dtms_contract -- bypass"), /注释/);
  assert.throws(() => validateDtmsQuerySql("SELECT 1 FROM dtms_contract /* x */"), /注释/);
});

test("validateDtmsQuerySql 拒绝写操作（复用内置护栏）", () => {
  assert.throws(() => validateDtmsQuerySql("DELETE FROM dtms_contract"), /禁止/);
});

test("maskSensitiveRows 打码敏感列", () => {
  const rows = maskSensitiveRows([{ contract_outer_no: "HT-1", bank_account: "6222", amount: 1 }]);
  assert.equal(rows[0]?.contract_outer_no, "HT-1");
  assert.equal(rows[0]?.bank_account, "***");
  assert.equal(rows[0]?.amount, 1);
});
