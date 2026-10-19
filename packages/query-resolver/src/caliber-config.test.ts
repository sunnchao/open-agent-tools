import { test } from "node:test";
import assert from "node:assert/strict";
import { CaliberConfigSchema, type CaliberConfig } from "./caliber-config.js";
import { createCaliberResolver } from "./createResolver.js";

const config: CaliberConfig = CaliberConfigSchema.parse({
  org: {
    directory: [
      { code: "SZ-BRANCH", name: "深圳分公司", aliases: ["深分"] },
      { code: "CD-BRANCH", name: "成都分公司", aliases: ["蓉分"] },
    ],
  },
  expense: {
    patterns: [
      { value: "MEAL", words: ["团建", "聚餐"] },
      { value: "TRAVEL", words: ["差旅", "出差"] },
    ],
    fallback: "MEAL",
  },
  status: {
    patterns: [{ value: "PENDING", words: ["还没批", "待批"] }],
    fallback: "PENDING",
  },
});

test("自定义口径：组织目录与同义词生效", async () => {
  const resolve = createCaliberResolver(config);
  const r = await resolve("深分上月团建还没批", {}, { now: new Date("2026-08-06T10:00:00+08:00") });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.caliber.org.code, "SZ-BRANCH");
    assert.equal(r.caliber.expense.enum, "MEAL");
    assert.equal(r.caliber.status, "PENDING");
    assert.equal(r.caliber.period.start, "2026-07-01");
  }
});

test("自定义口径：未命中词表时回落到配置默认值", async () => {
  const resolve = createCaliberResolver(config);
  const r = await resolve("深圳分公司上月查询费用", {}, { now: new Date("2026-08-06T10:00:00+08:00") });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.caliber.expense.enum, "MEAL");
    assert.equal(r.caliber.status, "PENDING");
  }
});

test("自定义口径：正则模式的意图识别", async () => {
  const resolve = createCaliberResolver(
    CaliberConfigSchema.parse({
      org: { directory: [{ code: "A", name: "总部", aliases: [] }] },
      intent: { queryPatterns: ["^\\s*列出"], keywords: ["明细"] },
    }),
  );
  const hit = await resolve("列出总部上月明细", {}, { now: new Date("2026-08-06T10:00:00+08:00") });
  assert.equal(hit.ok, true);
  const miss = await resolve("总部上月明细", {}, { now: new Date("2026-08-06T10:00:00+08:00") });
  assert.equal(miss.ok, true);
});

test("坏配置：空组织目录被拒绝", () => {
  assert.equal(CaliberConfigSchema.safeParse({ org: { directory: [] } }).success, false);
  assert.equal(CaliberConfigSchema.safeParse({}).success, false);
});

test("坏配置：非法正则创建期抛错", () => {
  const bad = CaliberConfigSchema.parse({
    org: { directory: [{ code: "A", name: "总部", aliases: [] }] },
    intent: { queryPatterns: ["("], keywords: [] },
  });
  assert.throws(() => createCaliberResolver(bad));
});

test("ctx 运行期覆盖默认值", async () => {
  const resolve = createCaliberResolver(config);
  const r = await resolve("蓉分上月团建", {}, { expenseDefault: "ENTERTAIN", statusDefault: "APPROVED" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.caliber.expense.enum, "MEAL");
    assert.equal(r.caliber.status, "APPROVED");
  }
});
