import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_FOREIGN_TABLES,
  DTMS_TABLE_NAMES,
  buildDtmsSchemaPrompt,
  buildUnknownReplyText,
  isAllowedIndustry,
  recommendedQuestions,
  resolvePageContext,
} from "./dtmsCatalog.js";

test("一期表白名单只有 DTMS 业务表，不含 NEW-API 表", () => {
  for (const name of DTMS_TABLE_NAMES) {
    assert.match(name, /^dtms_/);
  }
  const set = new Set(DTMS_TABLE_NAMES);
  for (const foreign of BLOCKED_FOREIGN_TABLES) {
    assert.equal(set.has(foreign), false);
  }
});

test("schema 提示只含 DTMS 表，不含 NEW-API 运营库", () => {
  const prompt = buildDtmsSchemaPrompt("上个月煤炭采购合同金额合计", "/contract-management/list");
  assert.match(prompt, /dtms_contract/);
  assert.match(prompt, /禁止查询 NEW-API/);
  assert.doesNotMatch(prompt, /### `logs`/);
  assert.doesNotMatch(prompt, /### `users`/);
  assert.doesNotMatch(prompt, /### `tokens`/);
  assert.doesNotMatch(prompt, /### `quota_data`/);
});

test("pageContext 解析模块与行业", () => {
  assert.deepEqual(resolvePageContext("/invoice-management/list"), {
    module: "发票",
    industry: undefined,
  });
  assert.deepEqual(resolvePageContext("/coal/contract-management"), {
    module: "合同",
    industry: "煤炭",
  });
});

test("行业白名单：DTMS 行业通过，其它拒绝", () => {
  assert.equal(isAllowedIndustry("煤炭"), true);
  assert.equal(isAllowedIndustry("NEW-API"), false);
  assert.equal(isAllowedIndustry("运营"), false);
});

test("UNKNOWN 兜底话术带 DTMS 推荐问题", () => {
  const text = buildUnknownReplyText();
  assert.match(text, /DTMS/);
  assert.match(text, /上个月煤炭采购合同金额合计/);
  assert.equal(recommendedQuestions("煤炭").length, 3);
});
