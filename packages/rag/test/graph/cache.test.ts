import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteGraphStore } from "../../src/graph/store.js";
import { GraphRetriever } from "../../src/graph/retriever.js";

test("向量缓存反映新增、更新、合并和删除的实体", async (t) => {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  t.after(() => store.close());
  const add = (id: string, vector: number[]) => {
    store.upsertEntity({ id, name: id, type: "org", props: {} });
    store.linkEntitySource(id, "doc");
    store.upsertEntityEmbeddings([{ id, vector }]);
  };
  add("old", [0, 1]);
  const retriever = new GraphRetriever(store, {
    embeddings: { embedDocuments: async (texts) => texts.map(() => [1, 0]) },
  });
  const seeds = async () => (await retriever.locateSeeds("unmatched question")).map((e) => e.id);
  assert.deepEqual(await seeds(), []);
  add("new", [1, 0]);
  assert.deepEqual(await seeds(), ["new"]);
  store.upsertEntityEmbeddings([{ id: "new", vector: [0, 1] }]);
  assert.deepEqual(await seeds(), []);
  add("duplicate", [1, 0]);
  assert.deepEqual(await seeds(), ["duplicate"]);
  store.mergeEntities("old", ["duplicate"]);
  assert.deepEqual(await seeds(), []);
  store.upsertEntityEmbeddings([{ id: "old", vector: [1, 0] }]);
  assert.deepEqual(await seeds(), ["old"]);
  store.removeBySource("doc");
  assert.deepEqual(await seeds(), []);
});

test("并发冷启动共享向量初始化，失败后允许重试", async (t) => {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  t.after(() => store.close());
  store.upsertEntity({ id: "pending", name: "pending", type: "org", props: {} });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fills = 0;
  let fail = true;
  const retriever = new GraphRetriever(store, {
    embeddings: {
      embedDocuments: async (texts) => {
        if (texts[0] === "pending") {
          fills++;
          await gate;
          if (fail) throw new Error("embedding unavailable");
        }
        return texts.map(() => [1, 0]);
      },
    },
  });
  const first = retriever.locateSeeds("unmatched question");
  const second = retriever.locateSeeds("unmatched question");
  release();
  const failed = await Promise.allSettled([first, second]);
  assert.ok(failed.every((result) => result.status === "rejected"));
  assert.equal(fills, 1);
  fail = false;
  const results = await Promise.all([
    retriever.locateSeeds("unmatched question"),
    retriever.locateSeeds("unmatched question"),
  ]);
  assert.deepEqual(
    results.map((entities) => entities.map((e) => e.id)),
    [["pending"], ["pending"]],
  );
  assert.equal(fills, 2);
});

test("补向量期间发生写入时不覆盖新向量，来源过滤使用批量读取", async (t) => {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  t.after(() => store.close());
  store.upsertEntity({ id: "pending", name: "pending", type: "org", props: {} });
  store.linkEntitySource("pending", "allowed");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const filling = new Promise<void>((resolve) => {
    started = resolve;
  });
  const retriever = new GraphRetriever(store, {
    embeddings: {
      embedDocuments: async (texts) => {
        if (texts[0] === "pending") {
          started();
          await gate;
        }
        return texts.map(() => [1, 0]);
      },
    },
  });
  const result = retriever.locateSeeds("unmatched question", 20, ["allowed"]);
  await filling;
  store.upsertEntityEmbeddings([{ id: "pending", vector: [0, 1] }]);
  release();
  assert.deepEqual(await result, []);
  for (let i = 0; i < 202; i++) {
    const id = `entity-${i}`;
    store.upsertEntity({ id, name: id, type: "org", props: {} });
    store.linkEntitySource(id, i % 2 ? "allowed" : "secret");
    store.upsertEntityEmbeddings([{ id, vector: [1, 0] }]);
  }
  store.entitySources = () => {
    throw new Error("per-entity source query");
  };
  const scoped = await retriever.locateSeeds("unmatched question", 300, ["allowed"]);
  assert.equal(scoped.length, 101);
  assert.ok(scoped.every((entity) => Number(entity.id.split("-")[1]) % 2 === 1));
  assert.deepEqual(await retriever.locateSeeds("unmatched question", 300, []), []);
});
