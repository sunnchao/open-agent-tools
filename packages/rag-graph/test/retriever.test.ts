import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraphStore } from "../src/store.js";
import { GraphRetriever } from "../src/retriever.js";
import { entityId, relationId } from "../src/utils.js";

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

test("retrieve 种子定位命中并扩展子图", () => {
  const { store, add, link, cleanup } = setup();
  const openai = add("OpenAI");
  const azure = add("Azure");
  const microsoft = add("Microsoft");
  link("OpenAI", "Azure");
  link("Azure", "Microsoft");
  const retriever = new GraphRetriever(store);
  const result = retriever.retrieve("OpenAI 的供应商");
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0]!.id, openai);
  assert.ok(result.subgraph);
  assert.ok(result.subgraph.entities.some((e) => e.id === azure));
  assert.ok(result.subgraph.relations.length > 0);
  cleanup();
});

test("retrieve 查询词拆分定位（查询含实体名片段）", () => {
  const { store, add, cleanup } = setup();
  add("Anthropic");
  const retriever = new GraphRetriever(store);
  const result = retriever.retrieve("Anthropic 最新发布");
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0]!.name.toLowerCase(), "anthropic");
  cleanup();
});

test("retrieve 未命中返回空子图", () => {
  const { store, add, cleanup } = setup();
  add("OpenAI");
  const retriever = new GraphRetriever(store);
  const result = retriever.retrieve("完全不存在的实体 XYZ");
  assert.equal(result.seeds.length, 0);
  assert.equal(result.subgraph, null);
  cleanup();
});

test("子图 formatted 输出三元组与来源", () => {
  const { store, add, link, cleanup } = setup();
  add("OpenAI");
  add("Azure");
  link("OpenAI", "Azure");
  const retriever = new GraphRetriever(store);
  const result = retriever.retrieve("OpenAI");
  const text = result.subgraph!.formatted();
  assert.match(text, /openai.*supplies.*azure/i);
  assert.match(text, /来源: c:0/);
  cleanup();
});

test("maxHops 限制扩展深度", () => {
  const { store, add, link, cleanup } = setup();
  add("A");
  add("B");
  add("C");
  link("A", "B");
  link("B", "C");
  const retriever = new GraphRetriever(store);
  const one = retriever.retrieve("A", { maxHops: 1 });
  assert.ok(one.subgraph!.entities.some((e) => e.name.toLowerCase() === "b"));
  assert.ok(!one.subgraph!.entities.some((e) => e.name.toLowerCase() === "c"));
  const two = retriever.retrieve("A", { maxHops: 2 });
  assert.ok(two.subgraph!.entities.some((e) => e.name.toLowerCase() === "c"));
  cleanup();
});
