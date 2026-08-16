import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraphStore } from "../../src/graph/store.js";
import { GraphRetriever } from "../../src/graph/retriever.js";
import { entityId, relationId } from "../../src/graph/utils.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rag-graph-retriever-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteGraphStore({ dbPath });
  const ids = new Map<string, string>();
  const add = (name: string, type = "org") => {
    const id = entityId(name, type);
    store.upsertEntity({ id, name, type, props: {} });
    ids.set(name, id);
    return id;
  };
  const link = (a: string, b: string, relType = "supplies") => {
    const src = ids.get(a)!;
    const dst = ids.get(b)!;
    store.upsertRelation({ id: relationId(src, relType, dst), srcId: src, dstId: dst, relType, weight: 1, sourceChunk: "c:0" });
  };
  return {
    store,
    add,
    link,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("retrieve 种子定位命中并扩展子图", async () => {
  const { store, add, link, cleanup } = setup();
  const openai = add("OpenAI");
  const azure = add("Azure");
  add("Microsoft"); // 只作为二跳扩展的终点，无需持有 id
  link("OpenAI", "Azure");
  link("Azure", "Microsoft");
  const retriever = new GraphRetriever(store);
  const result = await retriever.retrieve("OpenAI 的供应商");
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0]!.id, openai);
  assert.ok(result.subgraph);
  assert.ok(result.subgraph.entities.some((e) => e.id === azure));
  assert.ok(result.subgraph.relations.length > 0);
  cleanup();
});

test("retrieve 查询词拆分定位（查询含实体名片段）", async () => {
  const { store, add, cleanup } = setup();
  add("Anthropic");
  const retriever = new GraphRetriever(store);
  const result = await retriever.retrieve("Anthropic 最新发布");
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0]!.name.toLowerCase(), "anthropic");
  cleanup();
});

test("retrieve 未命中返回空子图", async () => {
  const { store, add, cleanup } = setup();
  add("OpenAI");
  const retriever = new GraphRetriever(store);
  const result = await retriever.retrieve("完全不存在的实体 XYZ");
  assert.equal(result.seeds.length, 0);
  assert.equal(result.subgraph, null);
  cleanup();
});

test("子图 formatted 输出三元组与来源", async () => {
  const { store, add, link, cleanup } = setup();
  add("OpenAI");
  add("Azure");
  link("OpenAI", "Azure");
  const retriever = new GraphRetriever(store);
  const result = await retriever.retrieve("OpenAI");
  const text = result.subgraph!.formatted();
  assert.match(text, /openai.*supplies.*azure/i);
  assert.match(text, /来源: c:0/);
  cleanup();
});

test("maxHops 限制扩展深度", async () => {
  const { store, add, link, cleanup } = setup();
  add("A");
  add("B");
  add("C");
  link("A", "B");
  link("B", "C");
  const retriever = new GraphRetriever(store);
  const one = await retriever.retrieve("A", { maxHops: 1 });
  assert.ok(one.subgraph!.entities.some((e) => e.name.toLowerCase() === "b"));
  assert.ok(!one.subgraph!.entities.some((e) => e.name.toLowerCase() === "c"));
  const two = await retriever.retrieve("A", { maxHops: 2 });
  assert.ok(two.subgraph!.entities.some((e) => e.name.toLowerCase() === "c"));
  cleanup();
});

test("向量兜底:名称匹配失败时用 embeddings 命中语义相近实体", async () => {
  const { store, add, cleanup } = setup();
  add("OpenAI");
  add("Anthropic");
  const retriever = new GraphRetriever(store, {
    embeddings: {
      // 伪 embeddings：与"openai"余弦相似度高于"anthropic"
      embedDocuments: async (texts) =>
        texts.map((t) => {
          const lower = t.toLowerCase();
          if (lower.includes("openai") || lower === "openai") return [1, 0, 0];
          if (lower === "gpt 开发商") return [0.95, 0.05, 0];
          return [0, 1, 0];
        }),
    },
  });
  // 名称匹配 miss（查询串含"GPT 开发商"无匹配词）→ 向量兜底命中 openai
  const result = await retriever.retrieve("GPT 开发商");
  assert.ok(result.seeds.length >= 1);
  assert.equal(result.seeds[0]!.name.toLowerCase(), "openai");
  cleanup();
});

test("向量兜底:低于相似度阈值不命中", async () => {
  const { store, add, cleanup } = setup();
  add("OpenAI");
  const retriever = new GraphRetriever(store, {
    embeddings: {
      // 查询含"无关"→ 与实体向量正交(余弦 0,低于阈值 0.3)
      embedDocuments: async (texts) =>
        texts.map((t) => (t.includes("无关") ? [1, 0, 0] : [0, 1, 0])),
    },
  });
  const result = await retriever.retrieve("完全无关词 XYZ");
  assert.equal(result.seeds.length, 0);
  cleanup();
});

test("别名兜底:通过别名命中实体(共指)", async () => {
  const { store, add, cleanup } = setup();
  const openai = add("OpenAI");
  store.addAlias(openai, "OpenAI 公司");
  const retriever = new GraphRetriever(store);
  const result = await retriever.retrieve("OpenAI 公司");
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0]!.id, openai);
  cleanup();
});
