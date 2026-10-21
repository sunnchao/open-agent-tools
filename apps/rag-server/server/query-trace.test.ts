import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RagAnalyticsStore } from "./analytics.js";

test("审计链路：recordQuery 持久化 trace，getQueryDetail 可回放", () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-trace-"));
  const store = new RagAnalyticsStore(join(dir, "rag.db"));
  try {
    store.recordQuery({
      id: "q-1",
      query: "向量检索分数",
      sources: ["a.txt"],
      sourceCount: 1,
      topK: 5,
      generate: false,
      crag: false,
      hits: [{ source: "a.txt" }],
      answerGenerated: false,
      answer: null,
      latencyMs: 12,
      trace: {
        store: "sqlite",
        embeddingsEnabled: false,
        candidates: 30,
        rrfK: 60,
        timingsMs: { vectorMs: null, keywordMs: 3, fusionMs: 1 },
        visibleSources: ["a.txt"],
        viewerGroups: undefined,
        vectorHits: [],
        keywordHits: [
          { id: "a:0", source: "a.txt", chunkIndex: 0, content: "向量检索", score: 1.5, rank: 0 },
        ],
        fused: [
          {
            id: "a:0",
            source: "a.txt",
            chunkIndex: 0,
            content: "向量检索",
            score: 0.016,
            rank: -1,
            vectorScore: null,
            vectorRank: null,
            keywordScore: 1.5,
            keywordRank: 0,
            rrfScore: 0.016,
            channels: ["keyword"],
          },
        ],
        formatted: "【来源: a.txt】\n向量检索",
        answer: null,
        truncated: false,
      },
    });
    const detail = store.getQueryDetail("q-1");
    assert.ok(detail, "应能按 queryId 查到");
    assert.equal(detail?.query, "向量检索分数");
    assert.equal(detail?.trace?.store, "sqlite");
    assert.equal(detail?.trace?.fused[0]?.keywordScore, 1.5);
    assert.deepEqual(detail?.trace?.fused[0]?.channels, ["keyword"]);
    assert.equal(store.getQueryDetail("missing"), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("历史事件无 trace 时详情仍可用（trace=null 降级）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-trace-"));
  const store = new RagAnalyticsStore(join(dir, "rag.db"));
  try {
    store.recordQuery({
      id: "q-old",
      query: "old",
      sourceCount: 0,
      topK: 5,
      generate: false,
      crag: false,
      hits: [],
      answerGenerated: false,
      latencyMs: 1,
    });
    const detail = store.getQueryDetail("q-old");
    assert.ok(detail);
    assert.equal(detail?.trace, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
