import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPgKeywordTerms, PgVectorStore } from "../src/store-pgvector.js";

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

test("关键词候选：整条查询优先 + 去重 + 去标点（纯单测，无需 PG）", () => {
  assert.deepEqual(buildPgKeywordTerms(""), []);
  assert.deepEqual(buildPgKeywordTerms("   "), []);
  // 整条查询排第一，其后是拆词结果
  assert.deepEqual(buildPgKeywordTerms("CPU 内存"), ["CPU 内存", "CPU", "内存"]);
  // 标点作为分隔符，不进入候选
  assert.deepEqual(buildPgKeywordTerms("部署说明，CPU"), ["部署说明，CPU", "部署说明", "CPU"]);
  // 纯标点查询退化为空，不产生 %%% 这类全表匹配
  assert.deepEqual(buildPgKeywordTerms("!!!，。"), []);
});

// 集成测试：需要本地 PG 且已启用 pgvector。
// 无 RAG_PG_URL / TEST_DATABASE_URL 时自动跳过，保证 CI 离线可过。
const PG_URL = (process.env.RAG_PG_URL ?? process.env.TEST_DATABASE_URL ?? "").trim();
const shouldRunIntegration = Boolean(PG_URL);

test(
  "PG(pgvector) 集成：replaceSource + 向量/关键词 + 目录 + ACL 保留 + 事务回滚",
  { skip: !shouldRunIntegration ? "needs RAG_PG_URL (local PostgreSQL + pgvector)" : undefined },
  async () => {
    const prefix = `rag_test_${Date.now().toString(36)}`;
    const store = new PgVectorStore({
      connectionString: PG_URL,
      tablePrefix: prefix,
      dims: 4,
    });
    try {
      await store.ensureSchema();
      const emb = (seed: number) => Float32Array.from([seed, seed + 1, seed + 2, seed + 3]);
      await store.replaceSource(
        "guide.txt",
        [
          {
            chunk: { id: "guide:0", source: "guide.txt", chunkIndex: 0, content: "部署说明 CPU 内存" },
            embedding: emb(1),
          },
          {
            chunk: { id: "guide:1", source: "guide.txt", chunkIndex: 1, content: "无关内容 环境变量" },
            embedding: emb(2),
          },
        ],
        metadata,
      );
      assert.deepEqual(await store.listSources(), ["guide.txt"]);
      assert.equal(await store.countChunks(), 2);

      // 关键词通道（ILIKE 兜底）：整条查询与拆词都应命中
      const keyword = await store.keywordSearch("CPU", 10);
      assert.ok(
        keyword.some((hit) => hit.id === "guide:0"),
        "ILIKE 应命中 CPU",
      );

      // 向量通道：余弦相似度排序，逼近查询向量的分块排第一
      const vector = await store.vectorSearch([1, 2, 3, 4], 2);
      assert.equal(vector[0]?.id, "guide:0");
      assert.ok((vector[0]?.score ?? 0) > 0.9, "自身向量余弦相似度应接近 1");

      // 空来源白名单不检索（与 SQLite/ES 语义对齐，防 ACL 泄漏）
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

      // ACL 保留：人工策略不被重传覆盖，版本号递增
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
      assert.equal(docs[0]?.chunks, 1);

      // 分块明细：旧分块被替换，新内容可读
      const chunks = await store.listChunksBySource("guide.txt");
      assert.equal(chunks.length, 1);
      assert.match(chunks[0]?.content ?? "", /v2$/);
      assert.equal(chunks[0]?.hasEmbedding, true);

      await store.removeBySource("guide.txt");
      assert.equal(await store.countChunks(), 0);
      assert.deepEqual(await store.listSources(), []);
    } finally {
      await store.destroyTables();
      await store.close();
    }
  },
);
