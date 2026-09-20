import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionError,
  assertQueryInScope,
  effectiveRowScope,
  type PermissionContext,
} from "./permission.js";

const base = (): PermissionContext => ({
  userId: "u1",
  industries: ["煤炭"],
  orgNos: ["ORG001", "ORG002"],
  modules: ["合同", "发票"],
  currentIndustry: "煤炭",
  currentOrgNo: "ORG001",
});

test("effectiveRowScope：一期默认当前组织 + 当前行业", () => {
  assert.deepEqual(effectiveRowScope(base()), { industries: ["煤炭"], orgNos: ["ORG001"] });
});

test("effectiveRowScope：无当前组织则用全部授权组织", () => {
  const ctx = base();
  delete ctx.currentOrgNo;
  assert.deepEqual(effectiveRowScope(ctx), { industries: ["煤炭"], orgNos: ["ORG001", "ORG002"] });
});

test("assertQueryInScope：问未开通行业 → PERMISSION_DENIED", () => {
  assert.throws(
    () => assertQueryInScope("钢材采购合同金额合计", undefined, base()),
    PermissionError,
  );
});

test("assertQueryInScope：问无菜单模块 → PERMISSION_DENIED", () => {
  assert.throws(() => assertQueryInScope("本月付款金额合计", undefined, base()), PermissionError);
});

test("assertQueryInScope：授权内问题通过", () => {
  const hint = assertQueryInScope(
    "上个月煤炭采购合同金额合计",
    "/contract-management/list",
    base(),
  );
  assert.equal(hint.industry, "煤炭");
  assert.equal(hint.module, "合同");
});

test("assertQueryInScope：授权内发票问题通过", () => {
  assert.doesNotThrow(() => assertQueryInScope("煤炭发票金额", undefined, base()));
});
