import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteAndValidateSqlWithAuth, rewriteSqlWithAuth } from "./sqlRewrite.js";
import { PermissionError } from "./permission.js";
import { SqlGuardError } from "./sqlGuard.js";

const industries = ["煤炭"];
const orgNos = ["ORG001"];

test("rewriteSqlWithAuth：无 WHERE 的 SQL 仍包上行业和组织", () => {
  const { sql, params } = rewriteSqlWithAuth(
    "SELECT SUM(total_amount) AS `合同金额合计` FROM dtms_contract",
    industries,
    orgNos,
  );
  assert.match(
    sql,
    /FROM \(SELECT \* FROM `dtms_contract` WHERE industry IN \(\?\) AND org_no IN \(\?\)\) AS `dtms_contract`/,
  );
  assert.deepEqual(params, ["煤炭", "ORG001"]);
  assert.doesNotMatch(sql, /FROM dtms_contract(?!\s*\))/);
});

test("rewriteSqlWithAuth：JOIN 两张表各包一层，参数按出现顺序绑定", () => {
  const { sql, params } = rewriteSqlWithAuth(
    "SELECT a.invoice_amount FROM dtms_invoice a JOIN dtms_contract b ON a.contract_outer_no=b.contract_outer_no",
    industries,
    orgNos,
  );
  assert.match(sql, /AS `a`/);
  assert.match(sql, /AS `b`/);
  assert.match(sql, /`dtms_invoice`/);
  assert.match(sql, /`dtms_contract`/);
  assert.deepEqual(params, ["煤炭", "ORG001", "煤炭", "ORG001"]);
});

test("rewriteSqlWithAuth：模型写 OR 1=1 不能拿掉授权子查询", () => {
  const { sql } = rewriteSqlWithAuth(
    "SELECT * FROM dtms_contract WHERE industry='钢材' OR 1=1",
    industries,
    orgNos,
  );
  assert.match(sql, /industry IN \(\?\) AND org_no IN \(\?\)/);
  assert.match(sql, /OR 1=1/);
});

test("rewriteSqlWithAuth：UNION 直接拒绝，不得执行原文", () => {
  assert.throws(
    () =>
      rewriteSqlWithAuth(
        "SELECT total_amount FROM dtms_contract UNION SELECT total_amount FROM dtms_contract",
        industries,
        orgNos,
      ),
    SqlGuardError,
  );
});

test("rewriteSqlWithAuth：无发票模块时引用 dtms_invoice → PERMISSION_DENIED", () => {
  assert.throws(
    () =>
      rewriteSqlWithAuth("SELECT invoice_amount FROM dtms_invoice", industries, orgNos, ["合同"]),
    PermissionError,
  );
});

test("rewriteSqlWithAuth：空行业或空组织 → PERMISSION_DENIED", () => {
  assert.throws(
    () => rewriteSqlWithAuth("SELECT 1 FROM dtms_contract", [], orgNos),
    PermissionError,
  );
  assert.throws(
    () => rewriteSqlWithAuth("SELECT 1 FROM dtms_contract", industries, []),
    PermissionError,
  );
});

test("rewriteAndValidateSqlWithAuth：生成 SQL 和最终 SQL 都通过 DTMS 护栏", () => {
  const rewritten = rewriteAndValidateSqlWithAuth(
    "SELECT SUM(total_amount) AS `合同金额合计` FROM dtms_contract",
    industries,
    orgNos,
    ["合同"],
  );
  assert.match(rewritten.sql, /industry IN \(\?\) AND org_no IN \(\?\)/);
  assert.deepEqual(rewritten.params, ["煤炭", "ORG001"]);
});

test("rewriteAndValidateSqlWithAuth：危险生成 SQL 在权限改写前即被拦截", () => {
  assert.throws(
    () => rewriteAndValidateSqlWithAuth("SELECT * FROM users", industries, orgNos),
    SqlGuardError,
  );
});
