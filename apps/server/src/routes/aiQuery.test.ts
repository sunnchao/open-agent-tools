import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fastIntent,
  extractJson,
  mapSqlError,
  buildDataPayload,
  checkRateLimit,
  hitSensitiveWord,
  emptyResultText,
  __resetRateLimiter,
} from "./aiQuery.js";

test("fastIntent：查询意图 + DTMS 业务名词双信号命中 → DATA_QUERY", () => {
  assert.equal(fastIntent("上个月煤炭采购合同金额合计"), "DATA_QUERY");
  assert.equal(fastIntent("本月新增合同数量是多少"), "DATA_QUERY");
  assert.equal(fastIntent("统计一下发票的开票金额"), "DATA_QUERY");
});

test("fastIntent：纯问候无问数信号 → UNKNOWN", () => {
  assert.equal(fastIntent("你好"), "UNKNOWN");
  assert.equal(fastIntent("您好！"), "UNKNOWN");
});

test("fastIntent：单信号或无信号 → null（交 LLM 兜底）", () => {
  assert.equal(fastIntent("今天天气怎么样"), null);
  assert.equal(fastIntent("帮我写一首诗"), null);
  assert.equal(fastIntent("合同模板是什么"), null);
});

test("fastIntent：NEW-API / 运营平台用语不走 DATA_QUERY 快道", () => {
  assert.equal(fastIntent("统计一下 token 消耗"), null);
  assert.equal(fastIntent("查询模型调用量"), null);
});

test("extractJson：容忍代码围栏与前后文本", () => {
  assert.deepEqual(extractJson('```json\n{"sql":"SELECT 1"}\n```'), { sql: "SELECT 1" });
  assert.deepEqual(extractJson('好的。{"intentType":"DATA_QUERY"} 请查收'), {
    intentType: "DATA_QUERY",
  });
  assert.equal(extractJson("没有 JSON"), null);
  assert.equal(extractJson("{broken"), null);
});

test("mapSqlError：超时类 → QUERY_TIMEOUT，其余 → QUERY_FAILED", () => {
  assert.equal(mapSqlError("Query timed out after 10000ms"), "QUERY_TIMEOUT");
  assert.equal(mapSqlError("ER_QUERY_TIMEOUT"), "QUERY_TIMEOUT");
  assert.equal(mapSqlError("Unknown column 'foo'"), "QUERY_FAILED");
});

test("buildDataPayload：单行单数值列 → metric", () => {
  const data = buildDataPayload([{ 合同金额合计: 12345678.9 }], "煤炭");
  assert.equal(data.type, "metric");
  assert.deepEqual(data, {
    type: "metric",
    value: 12345678.9,
    label: "合同金额合计",
    unit: "元",
    scope: "行业：煤炭",
  });
});

test("buildDataPayload：多行 → table，null 归一化，达上限标记 truncated", () => {
  const data = buildDataPayload([
    { contract_no: "HT-001", amount: 10, note: null },
    { contract_no: "HT-002", amount: 5, note: null },
  ]);
  assert.equal(data.type, "table");
  if (data.type !== "table") return assert.fail("expected table");
  assert.equal(data.columns.length, 3);
  assert.equal(data.rows[0]?.note, null);
  assert.equal(data.totalRows, 2);
  assert.equal(data.truncated, false);

  const capped = buildDataPayload(Array.from({ length: 100 }, () => ({ id: 1 })));
  assert.equal(capped.type, "table");
  if (capped.type !== "table") return assert.fail("expected table");
  assert.equal(capped.truncated, true);
});

test("emptyResultText 回显行业/模块口径", () => {
  assert.match(emptyResultText("煤炭", "/invoice-management/list"), /行业：煤炭/);
  assert.match(emptyResultText("煤炭", "/invoice-management/list"), /模块：发票/);
});

test("checkRateLimit：10 次/分钟，超限拒绝", () => {
  __resetRateLimiter();
  const sid = `test-${Math.random()}`;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(checkRateLimit(sid), true, `第 ${i + 1} 次应放行`);
  }
  assert.equal(checkRateLimit(sid), false, "第 11 次应限流");
});

test("hitSensitiveWord：默认词表命中，空白分隔无法绕过", () => {
  assert.equal(hitSensitiveWord("怎么洗钱"), "洗钱");
  assert.equal(hitSensitiveWord("怎么洗 钱"), "洗钱");
  assert.equal(hitSensitiveWord("色-情"), "色情");
  assert.equal(hitSensitiveWord("上个月合同金额"), null);
});
