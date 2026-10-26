import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RagAnalyticsStore } from "./index.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rag-analytics-"));
  const store = new RagAnalyticsStore(join(dir, "rag.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("查询指标聚合命中来源、空召回和反馈", () => {
  const { store, cleanup } = setup();
  store.recordQuery({
    id: "q1",
    query: "如何部署",
    sources: ["guide.md"],
    sourceCount: 1,
    topK: 5,
    generate: true,
    crag: false,
    hits: [{ source: "guide.md" }, { source: "guide.md" }, { source: "faq.md" }],
    answerGenerated: true,
    latencyMs: 125.6,
  });
  store.recordQuery({
    id: "q2",
    query: "未知问题",
    sourceCount: 1,
    topK: 3,
    generate: false,
    crag: false,
    hits: [],
    answerGenerated: false,
    latencyMs: 20,
  });
  store.recordQuery({
    id: "q3",
    query: "服务异常",
    sourceCount: 1,
    topK: 5,
    generate: true,
    crag: true,
    hits: [],
    answerGenerated: false,
    latencyMs: 40,
    error: "upstream unavailable",
  });
  assert.deepEqual(store.saveFeedback("q1", "positive"), {
    queryId: "q1",
    rating: "positive",
    comment: null,
  });

  const overview = store.overview(7);
  assert.equal(overview.totals.queries, 3);
  assert.equal(overview.totals.failed, 1);
  assert.equal(overview.totals.noHits, 1);
  assert.equal(overview.totals.noHitRate, 0.5);
  assert.equal(overview.totals.averageLatencyMs, 62);
  assert.equal(overview.totals.helpfulRate, 1);
  assert.deepEqual(overview.topSources[0], { source: "guide.md", hits: 2, queries: 1 });
  assert.equal(overview.recent[0]?.id, "q3");
  assert.equal(overview.recent.find((query) => query.id === "q1")?.feedback, "positive");
  cleanup();
});

test("反馈可更新且不存在的 queryId 返回 null", () => {
  const { store, cleanup } = setup();
  assert.equal(store.saveFeedback("missing", "negative"), null);
  store.recordQuery({
    id: "q1",
    query: "test",
    sourceCount: 1,
    topK: 5,
    generate: false,
    crag: false,
    hits: [],
    answerGenerated: false,
    latencyMs: 1,
  });
  store.saveFeedback("q1", "positive", " useful ");
  store.saveFeedback("q1", "negative", "wrong source");
  const overview = store.overview();
  assert.equal(overview.totals.positiveFeedback, 0);
  assert.equal(overview.totals.negativeFeedback, 1);
  assert.equal(overview.recent[0]?.feedback, "negative");
  cleanup();
});
