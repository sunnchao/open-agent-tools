import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridVectorStore } from "../src/store-hybrid.js";
import type {
  Chunk,
  ChunkInfo,
  DocumentInfo,
  DocumentMetadataPatch,
  DocumentWriteMetadata,
  ScoredChunk,
  VectorStore,
} from "../src/types.js";

const metadata: DocumentWriteMetadata = {
  mimeType: "text/plain",
  byteSize: 10,
  contentHash: "hash",
  chunkStrategy: "fixed",
  chunkSize: 500,
  chunkOverlap: 50,
  separators: ["\n"],
  semanticThreshold: null,
};

function documentOf(source: string): DocumentInfo {
  return {
    source,
    title: source,
    tags: [],
    allowedGroups: [],
    mimeType: metadata.mimeType,
    byteSize: metadata.byteSize,
    contentHash: metadata.contentHash,
    chunks: 1,
    version: 1,
    chunkStrategy: "fixed",
    chunkSize: 500,
    chunkOverlap: 50,
    separators: ["\n"],
    semanticThreshold: null,
    ocrApplied: false,
    ocrStatus: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** 内存版 VectorStore：够用来断言双写顺序与查询路由，无需真库。 */
class MemoryStore implements VectorStore {
  chunks = new Map<string, Chunk>();
  documents = new Map<string, DocumentInfo>();
  /** 记录收到的向量长度，验证「关键词侧不存向量」。 */
  embeddingLengths: number[] = [];
  failKeywordSearch = false;
  failReplaceSource = false;

  insert(chunk: Chunk, embedding: Float32Array): void {
    this.chunks.set(chunk.id, chunk);
    this.embeddingLengths.push(embedding.length);
  }

  replaceSource(
    source: string,
    rows: Array<{ chunk: Chunk; embedding: Float32Array }>,
    writeMetadata: DocumentWriteMetadata,
  ): void {
    if (this.failReplaceSource) throw new Error("boom");
    for (const key of [...this.chunks.keys()]) {
      if (this.chunks.get(key)?.source === source) this.chunks.delete(key);
    }
    for (const { chunk, embedding } of rows) {
      this.chunks.set(chunk.id, chunk);
      this.embeddingLengths.push(embedding.length);
    }
    this.documents.set(source, {
      ...documentOf(source),
      contentHash: writeMetadata.contentHash,
      chunks: rows.length,
    });
  }

  vectorSearch(embedding: number[], k: number): ScoredChunk[] {
    const score = embedding.length;
    return [...this.chunks.values()].slice(0, k).map((chunk) => ({ ...chunk, score }));
  }

  keywordSearch(query: string, k: number): ScoredChunk[] {
    if (this.failKeywordSearch) throw new Error("es is down");
    return [...this.chunks.values()]
      .filter((chunk) => chunk.content.includes(query))
      .slice(0, k)
      .map((chunk) => ({ ...chunk, score: 1 }));
  }

  removeBySource(source: string): void {
    for (const key of [...this.chunks.keys()]) {
      if (this.chunks.get(key)?.source === source) this.chunks.delete(key);
    }
    this.documents.delete(source);
  }

  listSources(): string[] {
    return [...this.documents.keys()].sort();
  }

  listDocuments(): DocumentInfo[] {
    return [...this.documents.values()];
  }

  updateDocument(source: string, patch: DocumentMetadataPatch): DocumentInfo | null {
    const current = this.documents.get(source);
    if (!current) return null;
    const next = { ...current, ...(patch.title ? { title: patch.title } : {}) };
    this.documents.set(source, next);
    return next;
  }

  countChunks(): number {
    return this.chunks.size;
  }

  listChunksBySource(source: string): ChunkInfo[] {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.source === source)
      .map((chunk) => ({ ...chunk, length: chunk.content.length, hasEmbedding: true }));
  }

  getChunksByIds(ids: readonly string[]): Chunk[] {
    return ids.flatMap((id) => (this.chunks.has(id) ? [this.chunks.get(id)!] : []));
  }
}

function makeHybrid(options: { keywordFailureMode?: "degrade" | "strict" } = {}) {
  const vector = new MemoryStore();
  const keyword = new MemoryStore();
  const store = new HybridVectorStore({
    vectorStore: vector,
    keywordStore: keyword,
    logger: () => {},
    ...options,
  });
  return { store, vector, keyword };
}

test("双写：向量侧收向量，关键词侧只收文本（不重复存 dense_vector）", async () => {
  const { store, vector, keyword } = makeHybrid();
  await store.replaceSource(
    "a.txt",
    [
      {
        chunk: { id: "a:0", source: "a.txt", chunkIndex: 0, content: "CPU 内存" },
        embedding: Float32Array.from([1, 2, 3]),
      },
    ],
    metadata,
  );
  assert.deepEqual(vector.embeddingLengths, [3]);
  assert.deepEqual(keyword.embeddingLengths, [0]);
  assert.equal(await store.countChunks(), 1);
});

test("查询路由：向量查主存、关键词查 ES、目录以后者为主存", async () => {
  const { store } = makeHybrid();
  await store.replaceSource(
    "a.txt",
    [
      {
        chunk: { id: "a:0", source: "a.txt", chunkIndex: 0, content: "CPU 内存" },
        embedding: Float32Array.from([1, 2, 3]),
      },
    ],
    metadata,
  );
  const vector = await store.vectorSearch([1, 2, 3], 5);
  assert.equal(vector.length, 1);
  const keyword = await store.keywordSearch("CPU", 5);
  assert.equal(keyword[0]?.id, "a:0");
  // 目录/明细/计数一律以主存为准
  assert.deepEqual(await store.listSources(), ["a.txt"]);
  assert.equal((await store.listChunksBySource("a.txt"))[0]?.hasEmbedding, true);
  assert.equal((await store.getChunksByIds(["a:0"]))[0]?.id, "a:0");
});

test("关键词写入失败默认只告警，PG 侧数据不丢", async () => {
  const { store, vector, keyword } = makeHybrid();
  keyword.failReplaceSource = true;
  await store.replaceSource(
    "a.txt",
    [
      {
        chunk: { id: "a:0", source: "a.txt", chunkIndex: 0, content: "CPU" },
        embedding: Float32Array.from([1]),
      },
    ],
    metadata,
  );
  assert.equal(await vector.countChunks(), 1, "主存仍写入成功");
  assert.equal(await store.countChunks(), 1);
});

test("关键词查询失败：默认降级为空候选，strict 模式抛出", async () => {
  const lenient = makeHybrid();
  lenient.keyword.failKeywordSearch = true;
  await lenient.store.replaceSource(
    "a.txt",
    [
      {
        chunk: { id: "a:0", source: "a.txt", chunkIndex: 0, content: "CPU" },
        embedding: Float32Array.from([1]),
      },
    ],
    metadata,
  );
  assert.deepEqual(await lenient.store.keywordSearch("CPU", 5), []);
  // 向量通道不受影响
  assert.equal((await lenient.store.vectorSearch([1], 5)).length, 1);

  const strict = makeHybrid({ keywordFailureMode: "strict" });
  strict.keyword.failKeywordSearch = true;
  await assert.rejects(() => strict.store.keywordSearch("CPU", 5), /es is down/);
});

test("resync：从主存全量重建关键词索引", async () => {
  const { store, vector, keyword } = makeHybrid();
  await store.replaceSource(
    "a.txt",
    [
      {
        chunk: { id: "a:0", source: "a.txt", chunkIndex: 0, content: "CPU" },
        embedding: Float32Array.from([1]),
      },
    ],
    metadata,
  );
  keyword.chunks.clear();
  keyword.documents.clear();
  const result = await store.resync();
  assert.deepEqual(result, { sources: 1, chunks: 1 });
  assert.equal(keyword.chunks.size, 1);
  assert.equal((await store.keywordSearch("CPU", 5))[0]?.id, "a:0");
  assert.equal(vector.chunks.size, 1);
});

test("删除：主存与关键词索引同时清理", async () => {
  const { store, vector, keyword } = makeHybrid();
  await store.replaceSource(
    "a.txt",
    [
      {
        chunk: { id: "a:0", source: "a.txt", chunkIndex: 0, content: "CPU" },
        embedding: Float32Array.from([1]),
      },
    ],
    metadata,
  );
  await store.removeBySource("a.txt");
  assert.equal(vector.chunks.size, 0);
  assert.equal(keyword.chunks.size, 0);
  assert.deepEqual(await store.listSources(), []);
});
