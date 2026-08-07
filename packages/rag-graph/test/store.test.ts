import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraphStore } from "../src/store.js";
import { entityId, relationId } from "../src/utils.js";

function tmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rag-graph-test-"));
  return {
    dbPath: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function entity(name: string, type = "org") {
  return { id: entityId(name, type), name, type, props: {} };
}

function relation(srcId: string, dstId: string, relType = "supplies", sourceChunk = "c:0") {
  return {
    id: relationId(srcId, relType, dstId),
    srcId,
    dstId,
    relType,
    weight: 1,
    sourceChunk,
  };
}

test("建表幂等 + upsert 实体/关系 + stats", () => {
  const { dbPath, cleanup } = tmpDb();
  const s1 = new SqliteGraphStore({ dbPath });
  const s2 = new SqliteGraphStore({ dbPath }); // 再次打开不报错
  const a = entity("OpenAI");
  const b = entity("Anthropic");
  s1.upsertEntity(a);
  s1.upsertEntity(b);
  s1.upsertRelation(relation(a.id, b.id));
  assert.deepEqual(s2.stats(), { entities: 2, relations: 1 });
  s1.close();
  s2.close();
  cleanup();
});

test("upsert 同键关系 weight 累加", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  const a = entity("OpenAI");
  const b = entity("Anthropic");
  s.upsertEntity(a);
  s.upsertEntity(b);
  const r = relation(a.id, b.id);
  s.upsertRelation(r);
  s.upsertRelation(r);
  s.upsertRelation(r);
  const sub = s.neighbors(a.id, 1);
  assert.equal(sub.relations[0]!.weight, 3);
  s.close();
  cleanup();
});

test("findEntitiesByName 精确优先、包含次之、规范化匹配", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  s.upsertEntity({ id: entityId("OpenAI", "org"), name: "openai", type: "org", props: {} });
  s.upsertEntity({ id: entityId("OpenAI 研究院", "org"), name: "openai 研究院", type: "org", props: {} });
  const exact = s.findEntitiesByName("OpenAI");
  assert.equal(exact.length, 1);
  assert.equal(exact[0]!.name, "openai");
  const contains = s.findEntitiesByName("研究院");
  assert.ok(contains.some((e) => e.name === "openai 研究院"));
  const normalized = s.findEntitiesByName("  ＯｐｅｎＡＩ "); // 全角+空白
  assert.equal(normalized.length, 1);
  s.close();
  cleanup();
});

test("neighbors 多跳 BFS 扩展", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  const a = entity("A", "org");
  const b = entity("B", "org");
  const c = entity("C", "org");
  const d = entity("D", "org");
  for (const e of [a, b, c, d]) s.upsertEntity(e);
  s.upsertRelation(relation(a.id, b.id));
  s.upsertRelation(relation(b.id, c.id));
  s.upsertRelation(relation(c.id, d.id));
  const one = s.neighbors(a.id, 1);
  assert.deepEqual(one.entities.map((e) => e.name).sort(), ["A", "B"]);
  const two = s.neighbors(a.id, 2);
  assert.deepEqual(two.entities.map((e) => e.name).sort(), ["A", "B", "C"]);
  s.close();
  cleanup();
});

test("neighbors minWeight 截断低权重边", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  const a = entity("A");
  const b = entity("B");
  const c = entity("C");
  for (const e of [a, b, c]) s.upsertEntity(e);
  const r1 = relation(a.id, b.id);
  s.upsertRelation(r1); // weight 1
  const r2 = relation(a.id, c.id);
  s.upsertRelation(r2);
  s.upsertRelation(r2); // weight 2
  const sub = s.neighbors(a.id, 1, { minWeight: 2 });
  assert.deepEqual(sub.relations.map((r) => r.dstId), [c.id]);
  s.close();
  cleanup();
});

test("removeBySource 级联删除关系与孤立实体", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  const a = entity("A");
  const b = entity("B");
  s.upsertEntity(a);
  s.upsertEntity(b);
  s.upsertRelation(relation(a.id, b.id, "supplies", "c:0"));
  s.removeBySource("c:0");
  assert.deepEqual(s.stats(), { entities: 0, relations: 0 });
  s.close();
  cleanup();
});

test("listEntities 分页/类型/搜索过滤", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  for (let i = 0; i < 5; i += 1) s.upsertEntity(entity(`Org${i}`, "org"));
  s.upsertEntity(entity("Alice", "person"));
  const page = s.listEntities({ limit: 2, offset: 0 });
  assert.equal(page.length, 2);
  const persons = s.listEntities({ type: "person" });
  assert.equal(persons.length, 1);
  const search = s.listEntities({ search: "Org3" });
  assert.equal(search.length, 1);
  s.close();
  cleanup();
});

test("countRelationsByType 分布统计", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  const a = entity("A");
  const b = entity("B");
  const c = entity("C");
  for (const e of [a, b, c]) s.upsertEntity(e);
  s.upsertRelation(relation(a.id, b.id, "supplies"));
  s.upsertRelation(relation(a.id, c.id, "depends_on"));
  const dist = s.countRelationsByType();
  assert.equal(dist.length, 2);
  s.close();
  cleanup();
});
