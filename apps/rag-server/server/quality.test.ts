import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RagAnalyticsStore } from "./analytics.js";
import { deriveQueryAttribution, isRefusal } from "./quality.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rag-quality-"));
  const store = new RagAnalyticsStore(join(dir, "rag.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function record(
  store: RagAnalyticsStore,
  id: string,
  attribution:
    "answered" | "no_documents" | "retrieval_miss" | "low_relevance" | "model_refusal" | "error",
  query = `问题 ${id}`,
  createdAt?: string,
) {
  const input = {
    id,
    query,
    sourceCount: 1,
    topK: 5,
    generate: true,
    crag: true,
    hits: [{ source: "guide.md" }],
    answerGenerated: true,
    answer: "回答",
    assessment: "correct" as const,
    actions: ["block-rag"],
    latencyMs: 10,
    ...(createdAt ? { createdAt } : {}),
  };
  if (attribution === "no_documents") return store.recordQuery({ ...input, sourceCount: 0 });
  if (attribution === "retrieval_miss") return store.recordQuery({ ...input, hits: [] });
  if (attribution === "low_relevance") {
    return store.recordQuery({
      ...input,
      assessment: "incorrect",
      hits: [],
      actions: ["block-rag", "graph-domain", "declared-uncovered"],
    });
  }
  if (attribution === "model_refusal") {
    return store.recordQuery({
      ...input,
      answerGenerated: false,
      answer: "知识库中没有相关资料，无法回答。",
    });
  }
  if (attribution === "error") return store.recordQuery({ ...input, error: "upstream failed" });
  return store.recordQuery(input);
}

test("归因纯函数按真实信号判定所有原因", () => {
  assert.equal(
    deriveQueryAttribution({
      crag: true,
      generate: true,
      hits: 0,
      sourceCount: 0,
      answerGenerated: false,
      answer: null,
      generationAttempted: false,
    }),
    "no_documents",
  );
  assert.equal(
    deriveQueryAttribution({
      crag: true,
      generate: true,
      hits: 0,
      sourceCount: 2,
      answerGenerated: false,
      answer: null,
      generationAttempted: false,
      actions: ["declared-uncovered"],
    }),
    "retrieval_miss",
  );
  assert.equal(
    deriveQueryAttribution({
      crag: true,
      generate: true,
      hits: 1,
      sourceCount: 1,
      answerGenerated: false,
      answer: null,
      generationAttempted: false,
      assessment: "incorrect",
      actions: ["block-rag", "graph-domain", "declared-uncovered"],
    }),
    "low_relevance",
  );
  assert.equal(
    deriveQueryAttribution({
      crag: true,
      generate: true,
      hits: 0,
      sourceCount: 1,
      answerGenerated: false,
      answer: null,
      generationAttempted: false,
      assessment: "incorrect",
      actions: ["block-rag", "graph-domain", "declared-uncovered"],
    }),
    "low_relevance",
  );
  assert.equal(
    deriveQueryAttribution({
      crag: true,
      generate: true,
      hits: 0,
      sourceCount: 1,
      answerGenerated: false,
      answer: null,
      generationAttempted: false,
      assessment: "incorrect",
      actions: ["block-rag", "declared-uncovered"],
    }),
    "retrieval_miss",
  );
  assert.equal(
    deriveQueryAttribution({
      crag: true,
      generate: true,
      hits: 1,
      sourceCount: 1,
      answerGenerated: false,
      answer: "",
      generationAttempted: true,
      assessment: "correct",
    }),
    "model_refusal",
  );
  assert.equal(
    deriveQueryAttribution({
      crag: false,
      generate: false,
      hits: 1,
      sourceCount: 1,
      answerGenerated: false,
      answer: null,
      generationAttempted: false,
    }),
    "answered",
  );
  assert.equal(
    deriveQueryAttribution({
      crag: false,
      generate: true,
      hits: 1,
      sourceCount: 1,
      answerGenerated: true,
      answer: "资料未覆盖该问题。",
      generationAttempted: true,
      error: "timeout",
    }),
    "error",
  );
});

test("拒答识别不把正常长回答误判", () => {
  assert.equal(isRefusal("知识库中没有相关资料，无法回答。"), true);
  assert.equal(isRefusal("I could not find relevant information in the documents."), true);
  assert.equal(isRefusal("知识库中未提及，但根据部署文档，你可以先执行 pnpm build。"), true);
  assert.equal(isRefusal("部署前请先执行 pnpm build，然后启动服务。"), false);
  assert.equal(isRefusal(`${"这是一段正常回答".repeat(50)}资料未覆盖`), false);
});

test("质量周报聚合总量、归因、Top 未覆盖问题与趋势", () => {
  const { store, cleanup } = setup();
  const now = new Date();
  const today = now.toISOString();
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
  record(store, "a1", "answered", "如何部署", today);
  record(store, "a2", "answered", "如何部署", today);
  record(store, "n1", "no_documents", "报销流程", today);
  record(store, "r1", "retrieval_miss", "如何退款", today);
  record(store, "r2", "retrieval_miss", "如何退款", yesterday);
  record(store, "l1", "low_relevance", "年假政策", yesterday);
  record(store, "m1", "model_refusal", "合同模板", yesterday);
  record(store, "e1", "error", "服务异常", yesterday);

  const report = store.qualityReport(7);
  assert.equal(report.periodDays, 7);
  assert.equal(report.totals.queries, 8);
  assert.equal(report.totals.answered, 2);
  assert.equal(report.totals.hits, 5);
  assert.equal(report.totals.noAnswer, 6);
  assert.equal(report.totals.hitRate, 0.625);
  assert.equal(report.totals.noAnswerRate, 0.75);
  assert.deepEqual(report.attribution, {
    answered: 2,
    no_documents: 1,
    retrieval_miss: 2,
    low_relevance: 1,
    model_refusal: 1,
    error: 1,
    unknown: 0,
  });
  assert.deepEqual(report.topUnanswered[0], {
    query: "如何退款",
    count: 2,
    attribution: "retrieval_miss",
  });
  assert.equal(report.trend.length, 7);
  assert.equal(report.trend.at(-1)?.queries, 4);
  assert.equal(report.trend.at(-1)?.noAnswer, 2);
  cleanup();
});

test("旧库迁移保留历史事件并标记 unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-quality-migration-"));
  const dbPath = join(dir, "rag.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE rag_query_events (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      source_filter_json TEXT NOT NULL,
      top_k INTEGER NOT NULL,
      generate INTEGER NOT NULL,
      crag INTEGER NOT NULL,
      hit_count INTEGER NOT NULL,
      answer_generated INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO rag_query_events VALUES
      ('old-1', '旧问题', '[]', 5, 1, 0, 0, 0, 12, NULL, '${new Date().toISOString()}');
  `);
  legacy.close();

  const store = new RagAnalyticsStore(dbPath);
  try {
    const report = store.qualityReport(7);
    assert.equal(report.totals.queries, 1);
    assert.equal(report.attribution.unknown, 1);
    assert.equal(report.attribution.retrieval_miss, 0);
    assert.equal(store.overview().recent[0]?.attribution, "unknown");
    const migrated = new DatabaseSync(dbPath);
    const columns = migrated
      .prepare("PRAGMA table_info(rag_query_events)")
      .all() as unknown as Array<{
      name: string;
    }>;
    assert.ok(columns.some((column) => column.name === "attribution"));
    assert.ok(columns.some((column) => column.name === "source_count"));
    migrated.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
