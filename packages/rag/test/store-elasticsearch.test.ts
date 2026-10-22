import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@elastic/elasticsearch";
import {
  buildChunksByIdsQuery,
  buildKeywordQuery,
  buildKnnFilter,
  ElasticsearchVectorStore,
} from "../src/store-elasticsearch.js";

const metadata = {
  mimeType: "text/plain",
  byteSize: 12,
  contentHash: "hash",
  chunkStrategy: "fixed" as const,
  chunkSize: 500,
  chunkOverlap: 50,
  separators: ["\n"],
  semanticThreshold: null,
};

test("查询构造器：AND/OR 与来源过滤（纯单测，无需 ES）", () => {
  assert.deepEqual(buildKeywordQuery("hello", undefined, "and"), {
    bool: { must: { match: { content: { query: "hello", operator: "AND" } } } },
  });
  assert.deepEqual(buildKeywordQuery("hello", ["a.txt"], "or"), {
    bool: {
      must: { match: { content: { query: "hello", operator: "OR" } } },
      filter: [{ terms: { source: ["a.txt"] } }],
    },
  });
  assert.equal(buildKnnFilter(undefined), undefined);
  assert.deepEqual(buildKnnFilter(["a.txt", "b.txt"]), { terms: { source: ["a.txt", "b.txt"] } });
  // 图谱回溯按 id 批量取块：来源白名单必须固化在查询里，不能取回后再过滤
  assert.deepEqual(buildChunksByIdsQuery(["c1", "c2"], undefined), {
    bool: { must: [{ terms: { id: ["c1", "c2"] } }] },
  });
  assert.deepEqual(buildChunksByIdsQuery(["c1"], ["a.txt"]), {
    bool: {
      must: [{ terms: { id: ["c1"] } }],
      filter: [{ terms: { source: ["a.txt"] } }],
    },
  });
});

// 集成测试：需要本地 ES（docker compose -f scripts/docker-compose.elasticsearch.yml up -d）。
// 无 ES 时自动跳过，保证 CI 离线可过。
const ES_NODE = process.env.RAG_ES_NODE?.trim() || "";
const shouldRunIntegration = Boolean(ES_NODE);

async function esAvailable(): Promise<boolean> {
  if (!shouldRunIntegration) return false;
  try {
    const client = new Client({ node: ES_NODE });
    await client.ping();
    await client.close();
    return true;
  } catch {
    return false;
  }
}

test(
  "ES 集成：replaceSource + keyword/vector + 文档目录 + ACL 保留",
  { skip: !shouldRunIntegration ? "needs RAG_ES_NODE (local ES)" : undefined },
  async () => {
    if (!(await esAvailable())) return;
    const prefix = `rag-test-${Date.now().toString(36)}`;
    const store = new ElasticsearchVectorStore({
      node: ES_NODE,
      indexPrefix: prefix,
      dims: 4,
      refresh: true,
    });
    try {
      await store.ensureIndices(4);
      const emb = (seed: number) => Float32Array.from([seed, seed + 1, seed + 2, seed + 3]);
      await store.replaceSource(
        "guide.txt",
        [
          {
            chunk: {
              id: "guide:0",
              source: "guide.txt",
              chunkIndex: 0,
              content: "部署说明 CPU 内存",
            },
            embedding: emb(1),
          },
          {
            chunk: {
              id: "guide:1",
              source: "guide.txt",
              chunkIndex: 1,
              content: "无关内容 环境变量",
            },
            embedding: emb(2),
          },
        ],
        metadata,
      );
      assert.deepEqual(await store.listSources(), ["guide.txt"]);
      assert.equal(await store.countChunks(), 2);

      const keyword = await store.keywordSearch("CPU", 10);
      assert.ok(
        keyword.some((h) => h.id === "guide:0"),
        "BM25 应命中 CPU",
      );

      const vector = await store.vectorSearch([1, 2, 3, 4], 2);
      assert.equal(vector[0]?.id, "guide:0");

      // 空来源白名单不检索（与 SQLite 语义对齐，防 ACL 泄漏）
      assert.deepEqual(await store.keywordSearch("CPU", 10, []), []);
      assert.deepEqual(await store.vectorSearch([1, 2, 3, 4], 2, []), []);
      assert.deepEqual(await store.getChunksByIds(["guide:0"], []), []);

      // 图谱回溯：id 批量取块 + 来源白名单
      const byIds = await store.getChunksByIds(["guide:0", "guide:missing"]);
      assert.deepEqual(
        byIds.map((chunk) => chunk.id),
        ["guide:0"],
      );
      assert.deepEqual(await store.getChunksByIds(["guide:0"], ["other.txt"]), []);

      // ACL 保留：人工策略不被重传覆盖
      await store.updateDocument("guide.txt", { allowedGroups: ["ops"] });
      await store.replaceSource(
        "guide.txt",
        [
          {
            chunk: {
              id: "guide:0",
              source: "guide.txt",
              chunkIndex: 0,
              content: "部署说明 CPU 内存 v2",
            },
            embedding: emb(3),
          },
        ],
        { ...metadata, contentHash: "hash-v2" },
      );
      const docs = await store.listDocuments();
      assert.equal(docs[0]?.version, 2);
      assert.deepEqual(docs[0]?.allowedGroups, ["ops"]);

      await store.removeBySource("guide.txt");
      assert.equal(await store.countChunks(), 0);
      assert.deepEqual(await store.listSources(), []);
    } finally {
      await store.destroyIndices();
      await store.close();
    }
  },
);
