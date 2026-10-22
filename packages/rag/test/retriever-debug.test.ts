import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rag } from "../src/index.js";

test("混合检索返回双路明细：向量/关键词分与排名可区分", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-debug-"));
  const rag = new Rag({ dbPath: join(dir, "rag.db") });
  try {
    await rag.ingestBuffers([
      { name: "a.txt", data: new TextEncoder().encode("向量数据库 余弦相似度 混合检索") },
      { name: "b.txt", data: new TextEncoder().encode("关键词全文检索 BM25 倒排索引") },
    ]);
    const res = await rag.retrieve("向量检索", { topK: 5 });
    assert.ok(res.debug, "应返回 debug");
    assert.equal(res.debug?.embeddingsEnabled, false, "无 embeddings 时向量路为空");
    assert.deepEqual(res.debug?.vectorHits, []);
    assert.ok((res.debug?.keywordHits.length ?? 0) > 0, "关键词路应有候选");
    for (const chunk of res.chunks) {
      assert.ok(chunk.debug, "融合块应带 debug");
      assert.equal(chunk.score, chunk.debug?.rrfScore);
      assert.ok(chunk.debug?.channels.includes("keyword"), "无向量时应为仅关键词");
      assert.equal(chunk.debug?.vectorScore, null);
      assert.ok(chunk.debug?.keywordScore !== null, "关键词分应保留");
    }
  } finally {
    await rag.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keyword:false 时向量路仍召回，且不含关键词通道", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-vector-only-"));
  // 词袋式 fake embeddings：文本里出现同一批词 → 余弦相似度高，保证向量路有命中。
  const vocab = ["苹果", "香蕉", "服务器", "内存"];
  const embed = (text: string) => vocab.map((word) => (text.includes(word) ? 1 : 0));
  const embeddings = {
    model: "fake-vector-only",
    embedDocuments: async (docs: string[]) => docs.map(embed),
    embedQuery: async (query: string) => embed(query),
  };
  const rag = new Rag({ dbPath: join(dir, "rag.db"), embeddings });
  try {
    await rag.ingestBuffers([
      { name: "fruit.txt", data: new TextEncoder().encode("苹果 香蕉 水果") },
      { name: "server.txt", data: new TextEncoder().encode("服务器 内存 运维") },
    ]);
    const result = await rag.retrieve("苹果 香蕉", { topK: 5, keyword: false });
    assert.equal(result.debug?.keywordEnabled, false);
    assert.deepEqual(result.debug?.keywordHits, []);
    assert.ok((result.debug?.vectorHits.length ?? 0) > 0, "向量路应有候选");
    assert.ok(result.chunks.length > 0, "仅向量模式仍应返回命中");
    for (const chunk of result.chunks) {
      assert.ok(chunk.debug?.channels.includes("vector"), "命中应来自向量通道");
      assert.ok(!chunk.debug?.channels.includes("keyword"), "不得混入关键词通道");
      assert.equal(chunk.debug?.keywordScore, null);
      assert.ok(chunk.debug?.vectorScore !== null);
    }
    // 对照：默认两路在同一语料上会多出关键词命中。
    const hybrid = await rag.retrieve("苹果 香蕉", { topK: 5 });
    assert.ok(hybrid.chunks.some((chunk) => chunk.debug?.channels.includes("keyword")));
  } finally {
    await rag.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
