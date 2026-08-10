import { test } from "node:test";
import assert from "node:assert/strict";
import { preQueryResolve } from "./preQueryResolve.js";
import { resolveDate } from "./resolvers/dateResolver.js";
import { resolveOrg, type OrgDirectory } from "./resolvers/orgResolver.js";
import { extractSlots } from "./extractSlots.js";

const dir: OrgDirectory = [
  { code: "BJ-BRANCH", name: "北京分公司", aliases: ["北分", "北京分"] },
  { code: "SH-BRANCH", name: "上海分公司", aliases: ["上分", "上海分"] },
];

test("extractSlots 抽取 date/org/expense 原文片段", async () => {
  const d = await extractSlots("北京分公司上个月的差旅报销审批", {}, { orgDirectory: dir });
  assert.equal(d.slots.date_raw, "上个月");
  assert.equal(d.slots.org_raw, "北京分公司");
  assert.equal(d.slots.expense_raw, "差旅报销");
  assert.equal(d.intent, "expense_query");
});

test("resolveDate 默认上月", () => {
  const now = new Date("2026-08-06T10:00:00+08:00");
  const r = resolveDate(undefined, now);
  assert.equal(r.value?.start, "2026-07-01");
  assert.equal(r.value?.end, "2026-07-31");
});

test("resolveDate 解析 YYYY年MM月", () => {
  const r = resolveDate("2026年7月", new Date("2026-08-06T10:00:00+08:00"));
  assert.equal(r.value?.start, "2026-07-01");
  assert.equal(r.value?.end, "2026-07-31");
});

test("resolveDate 最近N天", () => {
  const r = resolveDate("最近30天", new Date("2026-08-06T10:00:00+08:00"));
  assert.equal(r.value?.start, "2026-07-08");
  assert.equal(r.value?.end, "2026-08-06");
});

test("resolveOrg 歧义返回候选", () => {
  const amb: OrgDirectory = [
    { code: "A", name: "北京分公司", aliases: ["北分"] },
    { code: "B", name: "北分公司", aliases: ["华北分"] },
  ];
  const r = resolveOrg("北分", amb);
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
});

test("preQueryResolve 成功路径", async () => {
  const r = await preQueryResolve("上海分上月差旅已通过", {}, { orgDirectory: dir });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.caliber.org.code, "SH-BRANCH");
    assert.equal(r.caliber.expense.enum, "TRAVEL");
    assert.equal(r.caliber.status, "APPROVED");
    assert.equal(r.caliber.period.start, "2026-07-01");
  }
});

test("preQueryResolve 组织歧义 → 反问", async () => {
  const amb: OrgDirectory = [
    { code: "BJ-BRANCH", name: "北京分公司", aliases: ["北分"] },
    { code: "BJ-HQ", name: "北分公司", aliases: ["华北分"] },
  ];
  const r = await preQueryResolve("北分上月的差旅", {}, { orgDirectory: amb });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "ambiguous");
});

test("preQueryResolve 越权组织 → 拒绝", async () => {
  const r = await preQueryResolve("北京分公司上月差旅", {}, {
    orgDirectory: dir,
    authorizedOrgs: ["SH-BRANCH"],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unauthorized");
});

test("preQueryResolve 无时间关键词 → 默认上月", async () => {
  const r = await preQueryResolve("北京分公司差旅", {}, { orgDirectory: dir });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.caliber.period.start, "2026-07-01");
});

test("preQueryResolve LLM 抽出无法解析的时间 → 反问", async () => {
  const r = await preQueryResolve("北京分公司圣诞节那周的差旅", {}, {
    orgDirectory: dir,
    llmExtract: () => ({ date_raw: "圣诞节那周" }),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing");
});
