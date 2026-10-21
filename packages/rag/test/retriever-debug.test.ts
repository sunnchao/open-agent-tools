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
