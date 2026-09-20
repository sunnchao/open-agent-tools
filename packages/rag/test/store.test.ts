import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteVectorStore } from "../src/store.js";

function tmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rag-test-"));
  return {
    dbPath: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeEmbedding(seed: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = seed * 0.1 + i;
  return v;
}

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

test("建表幂等 + 插入 + countChunks", () => {
  const { dbPath, cleanup } = tmpDb();
  const s1 = new SqliteVectorStore({ dbPath });
  const s2 = new SqliteVectorStore({ dbPath }); // 再次打开不应报错
  s1.insert(
    { id: "a:0", source: "a.txt", chunkIndex: 0, content: "hello world" },
    fakeEmbedding(1),
  );
  s1.insert({ id: "a:1", source: "a.txt", chunkIndex: 1, content: "foo bar" }, fakeEmbedding(2));
  assert.equal(s2.countChunks(), 2);
  assert.deepEqual(s2.listSources(), ["a.txt"]);
  s1.close();
  s2.close();
  cleanup();
});

test("vectorSearch 按余弦相似度排序", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.insert({ id: "a:0", source: "a.txt", chunkIndex: 0, content: "c0" }, fakeEmbedding(1));
  s.insert({ id: "a:1", source: "a.txt", chunkIndex: 1, content: "c1" }, fakeEmbedding(5));
  const hits = s.vectorSearch(fakeEmbedding(5), 2);
  assert.equal(hits[0]?.id, "a:1");
  assert.ok(hits[0]!.score > hits[1]!.score);
  s.close();
  cleanup();
});

test("keywordSearch 走 FTS5 BM25 命中关键词", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.insert(
    { id: "a:0", source: "a.txt", chunkIndex: 0, content: "部署说明 系统要求 CPU 内存" },
    fakeEmbedding(1),
  );
  s.insert(
    { id: "a:1", source: "a.txt", chunkIndex: 1, content: "无关内容 环境变量" },
    fakeEmbedding(2),
  );
  const hits = s.keywordSearch("CPU", 10);
  assert.ok(hits.some((h) => h.id === "a:0"));
  assert.equal(hits[0]!.source, "a.txt");
  s.close();
  cleanup();
});

test("keywordSearch AND 无结果时降级 OR（口语查询可召回）", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.insert(
    { id: "a:0", source: "a.txt", chunkIndex: 0, content: "网关启动失败，检查数据库连接配置" },
    fakeEmbedding(1),
  );
  // "怎么办" 不在原文中：AND 必败，OR 降级应能召回
  const hits = s.keywordSearch("网关启动失败怎么办", 10);
  assert.ok(
    hits.some((h) => h.id === "a:0"),
    "OR 降级应命中含关键字的 chunk",
  );
  s.close();
  cleanup();
});

test("向量与关键词检索只返回挂载来源", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.insert(
    { id: "a:0", source: "a.txt", chunkIndex: 0, content: "shared needle" },
    fakeEmbedding(1),
  );
  s.insert(
    { id: "b:0", source: "b.txt", chunkIndex: 0, content: "shared needle" },
    fakeEmbedding(5),
  );

  assert.deepEqual(
    s.vectorSearch(fakeEmbedding(5), 10, ["a.txt"]).map((hit) => hit.source),
    ["a.txt"],
  );
  assert.deepEqual(
    s.keywordSearch("needle", 10, ["b.txt"]).map((hit) => hit.source),
    ["b.txt"],
  );
  assert.deepEqual(s.keywordSearch("needle", 10, []), []);
  s.close();
  cleanup();
});

test("removeBySource 后向量与 FTS 均清空", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.insert({ id: "a:0", source: "a.txt", chunkIndex: 0, content: "needle" }, fakeEmbedding(1));
  s.insert({ id: "b:0", source: "b.txt", chunkIndex: 0, content: "needle" }, fakeEmbedding(2));
  s.removeBySource("a.txt");
  assert.equal(s.countChunks(), 1);
  assert.deepEqual(s.listSources(), ["b.txt"]);
  assert.deepEqual(
    s.keywordSearch("needle", 10).map((h) => h.source),
    ["b.txt"],
  );
  s.close();
  cleanup();
});

test("listChunksBySource 按 chunk_index 升序返回元信息", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.insert({ id: "a:0", source: "a.txt", chunkIndex: 0, content: "first" }, fakeEmbedding(1));
  s.insert({ id: "a:2", source: "a.txt", chunkIndex: 2, content: "third" }, fakeEmbedding(3));
  s.insert({ id: "a:1", source: "a.txt", chunkIndex: 1, content: "second" }, fakeEmbedding(2));
  const infos = s.listChunksBySource("a.txt");
  assert.deepEqual(
    infos.map((c) => c.chunkIndex),
    [0, 1, 2],
  );
  assert.equal(infos[0]?.content, "first");
  assert.equal(infos[0]?.length, 5);
  assert.equal(infos[0]?.hasEmbedding, true);
  assert.deepEqual(
    infos.map((c) => c.hasEmbedding),
    [true, true, true],
  );
  s.removeBySource("a.txt");
  assert.deepEqual(s.listChunksBySource("a.txt"), []);
  s.close();
  cleanup();
});

test("listChunksBySource 退化模式正确标识 hasEmbedding=false", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.insert({ id: "a:0", source: "a.txt", chunkIndex: 0, content: "x" }, new Float32Array(0));
  assert.equal(s.listChunksBySource("a.txt")[0]?.hasEmbedding, false);
  s.close();
  cleanup();
});

test("replaceSource 原子更新文档目录并递增版本", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.replaceSource(
    "guide.txt",
    [
      {
        chunk: { id: "guide:0", source: "guide.txt", chunkIndex: 0, content: "v1" },
        embedding: fakeEmbedding(1),
      },
    ],
    metadata,
  );
  const first = s.listDocuments()[0]!;
  assert.equal(first.version, 1);
  assert.equal(first.mimeType, "text/plain");
  assert.equal(first.chunkStrategy, "fixed");
  assert.equal(first.semanticThreshold, null);
  assert.equal(first.chunks, 1);

  s.updateDocument("guide.txt", { title: "部署指南", tags: ["生产", "运维"] });
  s.replaceSource(
    "guide.txt",
    [
      {
        chunk: { id: "guide:0", source: "guide.txt", chunkIndex: 0, content: "v2" },
        embedding: fakeEmbedding(2),
      },
    ],
    { ...metadata, byteSize: 24, contentHash: "hash-v2" },
  );
  const second = s.listDocuments()[0]!;
  assert.equal(second.version, 2);
  assert.equal(second.title, "部署指南", "重传不应覆盖人工维护的标题");
  assert.deepEqual(second.tags, ["生产", "运维"]);
  assert.equal(second.byteSize, 24);
  assert.equal(s.listChunksBySource("guide.txt")[0]?.content, "v2");
  s.close();
  cleanup();
});

test("旧 documents 表自动补齐切分策略字段", () => {
  const { dbPath, cleanup } = tmpDb();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(content);
    CREATE TABLE documents (
      source TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      byte_size INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      chunk_size INTEGER NOT NULL DEFAULT 500,
      chunk_overlap INTEGER NOT NULL DEFAULT 50,
      separators_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy
    .prepare(
      `INSERT INTO documents VALUES ('legacy.txt', 'legacy.txt', '[]', 'text/plain', 1, '', 0, 1, 500, 50, '[]', ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());
  legacy.close();

  const upgraded = new SqliteVectorStore({ dbPath });
  assert.equal(upgraded.listDocuments()[0]?.chunkStrategy, "fixed");
  assert.equal(upgraded.listDocuments()[0]?.semanticThreshold, null);
  upgraded.close();
  cleanup();
});

test("replaceSource 写入失败时回滚并保留旧版本", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteVectorStore({ dbPath });
  s.replaceSource(
    "guide.txt",
    [
      {
        chunk: { id: "old", source: "guide.txt", chunkIndex: 0, content: "stable" },
        embedding: fakeEmbedding(1),
      },
    ],
    metadata,
  );
  assert.throws(() =>
    s.replaceSource(
      "guide.txt",
      [
        {
          chunk: { id: "duplicate", source: "guide.txt", chunkIndex: 0, content: "broken-a" },
          embedding: fakeEmbedding(2),
        },
        {
          chunk: { id: "duplicate", source: "guide.txt", chunkIndex: 1, content: "broken-b" },
          embedding: fakeEmbedding(3),
        },
      ],
      { ...metadata, contentHash: "broken" },
    ),
  );
  assert.equal(s.listChunksBySource("guide.txt")[0]?.content, "stable");
  assert.equal(s.listDocuments()[0]?.version, 1);
  s.close();
  cleanup();
});
