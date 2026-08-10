import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteGraphStore } from "../src/store.js";
import { LEGACY_SOURCE } from "../src/store.js";
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

function relation(
  srcId: string,
  dstId: string,
  relType = "supplies",
  sourceChunk = "c:0",
  source = "doc.md",
) {
  return {
    id: relationId(srcId, relType, dstId),
    srcId,
    dstId,
    relType,
    weight: 1,
    sourceChunk,
    source,
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

test("removeBySource 按文档来源级联删除关系与实体", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  const a = entity("A");
  const b = entity("B");
  s.upsertEntity(a);
  s.upsertEntity(b);
  s.linkEntitySource(a.id, "doc.md");
  s.linkEntitySource(b.id, "doc.md");
  s.upsertRelation(relation(a.id, b.id, "supplies", "chunk-1", "doc.md"));

  // 用 chunk id 删不掉——历史 bug 正是把 chunk id 当来源名匹配
  s.removeBySource("chunk-1");
  assert.deepEqual(s.stats(), { entities: 2, relations: 1 });

  const removed = s.removeBySource("doc.md");
  assert.deepEqual(s.stats(), { entities: 0, relations: 0 });
  assert.deepEqual(removed, { entities: 2, relations: 1 });
  s.close();
  cleanup();
});

test("removeBySource 保留被其他文档共享的实体与边", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  const shared = entity("共享实体");
  const onlyA = entity("仅A引用");
  const onlyB = entity("仅B引用");
  for (const e of [shared, onlyA, onlyB]) s.upsertEntity(e);

  // shared 被两篇文档同时提及，两篇都建了同一条边 shared->onlyA 之外各自的边
  s.linkEntitySource(shared.id, "a.md");
  s.linkEntitySource(shared.id, "b.md");
  s.linkEntitySource(onlyA.id, "a.md");
  s.linkEntitySource(onlyB.id, "b.md");
  s.upsertRelation(relation(shared.id, onlyA.id, "supplies", "a:0", "a.md"));
  s.upsertRelation(relation(shared.id, onlyB.id, "supplies", "b:0", "b.md"));
  // 同一条边被两篇文档共同佐证
  s.upsertRelation(relation(onlyA.id, onlyB.id, "related_to", "a:1", "a.md"));
  s.upsertRelation(relation(onlyA.id, onlyB.id, "related_to", "b:1", "b.md"));

  s.removeBySource("a.md");
  // shared 仍被 b.md 引用 → 保留；onlyA 已无来源归属，但仍被 b.md 佐证的边连接 → 保留
  assert.ok(s.findEntityById(shared.id), "共享实体不应被删除");
  assert.ok(s.findEntityById(onlyB.id), "b.md 的实体不应被牵连");
  // a.md 独有的边消失，被两篇共同佐证的边保留
  const rest = s.neighbors(onlyB.id, 2);
  assert.ok(
    rest.relations.some((r) => r.relType === "related_to"),
    "双来源佐证的边应在删除单一来源后保留",
  );
  assert.ok(
    !rest.relations.some((r) => r.sourceChunk === "a:0"),
    "a.md 独有的边应被删除",
  );

  s.removeBySource("b.md");
  assert.deepEqual(s.stats(), { entities: 0, relations: 0 }, "两篇都删完后图谱应清空");
  s.close();
  cleanup();
});

test("graph_sources 状态机登记与对账计数", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  assert.equal(s.getSource("x.md"), null);

  s.markSource("x.md", { status: "pending", chunks: 3 });
  assert.equal(s.getSource("x.md")?.status, "pending");

  s.markSource("x.md", { status: "failed", error: "boom" });
  assert.equal(s.getSource("x.md")?.error, "boom");
  // 转为非 failed 状态时自动清除错误信息，避免陈旧报错常驻界面
  s.markSource("x.md", { status: "ready", entities: 2, relations: 1 });
  const ready = s.getSource("x.md");
  assert.equal(ready?.error, undefined);
  assert.equal(ready?.chunks, 3, "未显式传入的字段应保留原值");

  const a = entity("A");
  s.upsertEntity(a);
  s.linkEntitySource(a.id, "x.md");
  s.linkEntitySource(a.id, "x.md"); // 重复绑定幂等
  assert.deepEqual(s.countBySource("x.md"), { entities: 1, relations: 0 });

  assert.deepEqual(s.listSources().map((r) => r.source), ["x.md"]);
  s.removeSourceRecord("x.md");
  assert.deepEqual(s.listSources(), []);
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

test("addAlias / findByAlias / aliasesOf 共指合并", () => {
  const { dbPath, cleanup } = tmpDb();
  const s = new SqliteGraphStore({ dbPath });
  const a = entity("OpenAI");
  s.upsertEntity(a);
  s.addAlias(a.id, "OpenAI 公司");
  s.addAlias(a.id, "openai 公司"); // 规范化后重复,INSERT OR IGNORE 应去重
  assert.deepEqual(s.aliasesOf(a.id), ["openai 公司"]);
  const hit = s.findByAlias("OpenAI 公司");
  assert.ok(hit);
  assert.equal(hit!.id, a.id);
  assert.equal(s.findByAlias("不存在的别名"), null);
  s.close();
  cleanup();
});

test("v1 存量库迁移：补 source 列 + 挂 LEGACY_SOURCE + 构造函数不抛错", () => {
  const { dbPath, cleanup } = tmpDb();
  // 手工构造一个 v1 形态的库：relations 表没有 source 列（仅 source_chunk）
  const setup = new DatabaseSync(dbPath);
  setup.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      props TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE relations (
      id TEXT PRIMARY KEY, src_id TEXT NOT NULL, dst_id TEXT NOT NULL,
      rel_type TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 1,
      source_chunk TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  setup.exec(`INSERT INTO entities (id, name, type) VALUES ('e1','OpenAI','org')`);
  setup.exec(`INSERT INTO entities (id, name, type) VALUES ('e2','Anthropic','org')`);
  setup.exec(
    `INSERT INTO relations (id, src_id, dst_id, rel_type, source_chunk) VALUES ('r1','e1','e2','supplies','c:0')`,
  );
  setup.close();

  // 关键断言：打开 v1 库不应抛 "no such column: source"
  let s!: SqliteGraphStore;
  assert.doesNotThrow(() => {
    s = new SqliteGraphStore({ dbPath });
  });
  const cols = (s as unknown as { db: DatabaseSync }).db
    .prepare(`PRAGMA table_info(relations)`)
    .all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "source"), "relations 应已补 source 列");

  // 存量关系/实体应被挂到 LEGACY_SOURCE 占位来源
  const legacy = s.listSources().find((x) => x.source === LEGACY_SOURCE);
  assert.ok(legacy, "存量数据应挂到 __legacy__ 来源");
  assert.equal(legacy!.status, "ready");
  assert.equal(legacy!.relations, 1);
  assert.equal(legacy!.entities, 2);
  s.close();
  cleanup();
});
