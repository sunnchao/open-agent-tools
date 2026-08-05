import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { SqliteVectorStore } from "../src/store.js";
import { ingestBuffer } from "../src/ingest.js";
import { Rag } from "../src/index.js";

/** 确定性 fake embeddings，避免测试依赖网络。 */
class FakeEmbeddings implements EmbeddingsInterface {
  model = "fake-embeddings";

  async embedDocuments(docs: string[]): Promise<number[][]> {
    return docs.map((d) => Array.from(d).map((c) => c.charCodeAt(0) % 8));
  }

  async embedQuery(query: string): Promise<number[]> {
    const [v] = await this.embedDocuments([query]);
    return v ?? [];
  }
}

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rag-ingest-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ingestBuffer 文本入库 + 幂等重灌", async () => {
  const { dir, cleanup } = tmpDir();
  const store = new SqliteVectorStore({ dbPath: join(dir, "rag.db") });
  const text = "数字货运系统部署说明。系统要求：CPU 至少 4 核，内存 16G。请配置环境变量。";
  const n1 = await ingestBuffer("部署说明.txt", new TextEncoder().encode(text), {
    store,
    embeddings: new FakeEmbeddings(),
  });
  assert.ok(n1 > 0);
  assert.equal(store.listSources().length, 1);
  assert.equal(store.countChunks(), n1);

  // 幂等：重灌同 source 后 chunk 数不变（先清后写）
  const n2 = await ingestBuffer("部署说明.txt", new TextEncoder().encode(text), {
    store,
    embeddings: new FakeEmbeddings(),
  });
  assert.equal(n1, n2);
  assert.equal(store.countChunks(), n1);
  store.close();
  cleanup();
});

test("无 embeddings 时退化为纯 BM25 入库与检索", async () => {
  const { dir, cleanup } = tmpDir();
  const rag = new Rag({ dbPath: join(dir, "rag.db") });
  await rag.ingestBuffers([
    { name: "note.txt", data: new TextEncoder().encode("RAG 检索增强生成 混合检索") },
  ]);
  assert.equal(rag.getStats().chunks, 1);
  const res = await rag.retrieve("RAG 检索");
  assert.ok(res.chunks.length >= 1, "BM25 应能命中关键词");
  assert.ok(res.formatted().includes("note.txt"));
  rag.close();
  cleanup();
});

test("Rag 门面：ingest + listSources + clearSource", async () => {
  const { dir, cleanup } = tmpDir();
  const rag = new Rag({ dbPath: join(dir, "rag.db"), embeddings: new FakeEmbeddings() });
  await rag.ingestBuffers([{ name: "a.txt", data: new TextEncoder().encode("hello aaa") }]);
  await rag.ingestBuffers([{ name: "b.txt", data: new TextEncoder().encode("world bbb") }]);
  assert.deepEqual(rag.listSources(), ["a.txt", "b.txt"]);
  rag.clearSource("a.txt");
  assert.deepEqual(rag.listSources(), ["b.txt"]);
  rag.close();
  cleanup();
});

test("Rag 门面：单次上传可覆盖分块设置", async () => {
  const { dir, cleanup } = tmpDir();
  const rag = new Rag({ dbPath: join(dir, "rag.db"), chunkSize: 1000, chunkOverlap: 100 });
  const text = Array.from(
    { length: 30 },
    (_, index) => `第${index + 1}段知识内容用于验证切分参数。`,
  ).join("\n\n");

  await rag.ingestBuffers([{ name: "settings.txt", data: new TextEncoder().encode(text) }], {
    chunkSize: 100,
    chunkOverlap: 0,
  });

  const chunks = rag.listChunks("settings.txt");
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
  rag.close();
  cleanup();
});
