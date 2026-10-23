import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraphStore } from "../../src/graph/store.js";
import { KnowledgeGraph } from "../../src/graph/index.js";
import {
  GleaningExtractor,
  LlmGraphExtractor,
  mergeExtractResults,
} from "../../src/graph/extract.js";
import {
  entityId,
  isSymmetricRelation,
  relationId,
  relationSpecificity,
} from "../../src/graph/utils.js";
import type { ChunkLike } from "../../src/graph/types.js";

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rag-graph-opt-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function storeIn(dir: string): SqliteGraphStore {
  return new SqliteGraphStore({ dbPath: join(dir, "graph.db") });
}

function chunk(id: string, content: string, source = "doc.md"): ChunkLike {
  return { id, source, chunkIndex: 0, content };
}

/* ---------------------------------------------------------------- 对称谓词归一 */

test("对称谓词 A→B 与 B→A 归一到同一条边", () => {
  assert.ok(isSymmetricRelation("related_to"), "related_to 应视为无向");
  assert.equal(
    relationId("aaa", "related_to", "bbb"),
    relationId("bbb", "related_to", "aaa"),
    "对称谓词端点顺序不影响 id",
  );
  // 方向有语义的谓词必须保留顺序
  assert.ok(!isSymmetricRelation("supplies"));
  assert.notEqual(relationId("aaa", "supplies", "bbb"), relationId("bbb", "supplies", "aaa"));
});

test("反向共现边入库后只有一条，weight 累加", () => {
  const { dir, cleanup } = tmpDir();
  const store = storeIn(dir);
  const a = entityId("腾讯云", "concept");
  const b = entityId("微信支付", "concept");
  store.upsertEntity({ id: a, name: "腾讯云", type: "concept", props: {} });
  store.upsertEntity({ id: b, name: "微信支付", type: "concept", props: {} });
  const forward = {
    id: relationId(a, "related_to", b),
    srcId: a,
    dstId: b,
    relType: "related_to",
    weight: 1,
    sourceChunk: "c:0",
    source: "doc.md",
    origin: "rule" as const,
  };
  store.upsertRelation(forward);
  store.upsertRelation({ ...forward, id: relationId(b, "related_to", a), srcId: b, dstId: a });
  const sub = store.neighbors(a, 1);
  assert.equal(sub.relations.length, 1, "反向重复边应被归一");
  assert.equal(sub.relations[0]!.weight, 2, "同一条边两次出现累加权重");
  store.close();
  cleanup();
});

/* ---------------------------------------------------------------- 谓词特异性 */

test("related_to 与共现边的排序权重低于真实语义谓词", () => {
  const supplies = relationSpecificity("supplies", "llm");
  const related = relationSpecificity("related_to", "llm");
  const rule = relationSpecificity("related_to", "rule");
  assert.ok(related < supplies, "兜底谓词权重更低");
  assert.ok(rule < related, "规则共现边权重最低");
});

/* ---------------------------------------------------------------- 抽取可观测性 */

test("LLM 输出无法解析时计入 parseFailures 而不是静默丢弃", async () => {
  const extractor = new LlmGraphExtractor(async () => "这不是 JSON");
  const result = await extractor.extract(chunk("c:0", "任意文本"));
  assert.equal(result.entities.length, 0);
  assert.equal(result.relations.length, 0);
  const diag = extractor.diagnostics();
  assert.equal(diag.calls, 1);
  assert.equal(diag.parseFailures, 1, "解析失败必须可观测");
});

test("关系端点不在本块实体表时计入 orphanRelations", async () => {
  const extractor = new LlmGraphExtractor(async () =>
    JSON.stringify({
      entities: [{ name: "OpenAI", type: "org" }],
      relations: [{ subject: "OpenAI", predicate: "supplies", object: "不存在的实体" }],
    }),
  );
  const result = await extractor.extract(chunk("c:0", "OpenAI"));
  assert.equal(result.relations.length, 0);
  assert.equal(extractor.diagnostics().orphanRelations, 1);
});

test("未知谓词回退计数，句内共现边标记 origin=rule", async () => {
  const llm = new LlmGraphExtractor(async () =>
    JSON.stringify({
      entities: [
        { name: "A", type: "org" },
        { name: "B", type: "org" },
      ],
      relations: [{ subject: "A", predicate: "喜欢", object: "B" }],
    }),
  );
  const result = await llm.extract(chunk("c:0", "A B"));
  assert.equal(result.relations[0]!.relType, "related_to");
  assert.equal(result.relations[0]!.origin, "llm");
  assert.equal(llm.diagnostics().predicateFallbacks, 1);

  const rule = new (await import("../../src/graph/extract.js")).RuleGraphExtractor();
  const ruleResult = await rule.extract(chunk("c:0", "OpenAI 与 Anthropic 都是 AI 公司。"));
  assert.ok(ruleResult.relations.every((r) => r.origin === "rule"));
});

/* ---------------------------------------------------------------- Gleaning */

test("Gleaning 合并新增结果并保持幂等", async () => {
  let round = 0;
  const inner = new LlmGraphExtractor(async () => {
    round += 1;
    return round === 1
      ? JSON.stringify({
          entities: [{ name: "OpenAI", type: "org" }],
          relations: [],
        })
      : JSON.stringify({
          entities: [
            { name: "OpenAI", type: "org" },
            { name: "Azure", type: "tech" },
          ],
          relations: [{ subject: "OpenAI", predicate: "supplies", object: "Azure" }],
        });
  });
  const gleaning = new GleaningExtractor(inner, { rounds: 2 });
  const result = await gleaning.extract(chunk("c:0", "OpenAI Azure"));
  assert.equal(result.entities.length, 2, "补充轮的新实体被合并");
  assert.equal(result.relations.length, 1);
  assert.equal(result.entities.filter((e) => e.name === "openai").length, 1, "实体不重复");
});

test("mergeExtractResults 按 id 去重", () => {
  const a = {
    entities: [{ id: "e1", name: "a", type: "org", props: {} }],
    relations: [],
  };
  const b = {
    entities: [
      { id: "e1", name: "a", type: "org", props: {} },
      { id: "e2", name: "b", type: "org", props: {} },
    ],
    relations: [],
  };
  const merged = mergeExtractResults(a, b);
  assert.deepEqual(
    merged.entities.map((e) => e.id),
    ["e1", "e2"],
  );
});

/* ---------------------------------------------------------------- 批量邻域 */

test("neighborsBatch 与逐个 neighbors 结果一致", () => {
  const { dir, cleanup } = tmpDir();
  const store = storeIn(dir);
  const ids = ["a", "b", "c", "d"].map((name) => {
    const id = entityId(name, "org");
    store.upsertEntity({ id, name, type: "org", props: {} });
    return id;
  });
  const link = (from: number, to: number, weight = 1): void => {
    store.upsertRelation({
      id: relationId(ids[from]!, "supplies", ids[to]!),
      srcId: ids[from]!,
      dstId: ids[to]!,
      relType: "supplies",
      weight,
      sourceChunk: "c:0",
      source: "doc.md",
    });
  };
  link(0, 1);
  link(1, 2);
  link(2, 3);

  // 两个种子的批量结果应等于「分别扩展后取并集」，而不是等于单种子结果：
  // 批量语义是「以这组种子为起点」，起点更多时自然覆盖更广。
  const batched = store.neighborsBatch([ids[0]!, ids[1]!], 2, { maxNodes: 50 });
  const union = new Set<string>();
  for (const seed of [ids[0]!, ids[1]!]) {
    for (const entity of store.neighbors(seed, 2, { maxNodes: 50 }).entities) {
      union.add(entity.id);
    }
  }
  assert.deepEqual(
    batched.entities.map((e) => e.id).sort(),
    [...union].sort(),
    "批量结果等于各种子扩展的并集",
  );

  const single = store.neighborsBatch([ids[0]!], 2, { maxNodes: 50 });
  assert.deepEqual(
    single.entities.map((e) => e.id).sort(),
    store
      .neighbors(ids[0]!, 2, { maxNodes: 50 })
      .entities.map((e) => e.id)
      .sort(),
    "单种子时批量与逐个结果一致",
  );
  store.close();
  cleanup();
});

test("neighborsBatch 遵守 sources 白名单", () => {
  const { dir, cleanup } = tmpDir();
  const store = storeIn(dir);
  const a = entityId("A", "org");
  const b = entityId("B", "org");
  const c = entityId("C", "org");
  for (const [id, name] of [
    [a, "A"],
    [b, "B"],
    [c, "C"],
  ] as const) {
    store.upsertEntity({ id, name, type: "org", props: {} });
  }
  store.upsertRelation({
    id: relationId(a, "supplies", b),
    srcId: a,
    dstId: b,
    relType: "supplies",
    weight: 1,
    sourceChunk: "a:0",
    source: "a.md",
  });
  store.upsertRelation({
    id: relationId(b, "supplies", c),
    srcId: b,
    dstId: c,
    relType: "supplies",
    weight: 1,
    sourceChunk: "b:0",
    source: "b.md",
  });
  store.linkEntitySource(a, "a.md");
  store.linkEntitySource(b, "a.md");
  store.linkEntitySource(b, "b.md");
  store.linkEntitySource(c, "b.md");

  const scoped = store.neighborsBatch([a], 2, { sources: ["a.md"] });
  assert.ok(scoped.entities.some((e) => e.id === a));
  assert.ok(!scoped.entities.some((e) => e.id === c), "不应越过来源白名单");
  store.close();
  cleanup();
});

/* ---------------------------------------------------------------- 僵死来源自愈 */

test("resetStuckSources 只复位超时的 building 来源", () => {
  const { dir, cleanup } = tmpDir();
  const store = storeIn(dir);
  store.markSource("old.md", { status: "building", chunks: 10 });
  store.markSource("fresh.md", { status: "building", chunks: 10 });
  // 把 old.md 的 updated_at 改到很久以前，模拟进程中途被杀
  const db = (store as unknown as { db: { exec(sql: string): void } }).db;
  db.exec(`UPDATE graph_sources SET updated_at = '2000-01-01 00:00:00' WHERE source = 'old.md'`);

  const reset = store.resetStuckSources("2020-01-01 00:00:00");
  assert.deepEqual(reset, ["old.md"]);
  assert.equal(store.getSource("old.md")!.status, "pending", "僵死来源复位为 pending");
  assert.equal(store.getSource("fresh.md")!.status, "building", "未超时的来源不动");
  store.close();
  cleanup();
});

test("diff 把超时 building 归入 stuck 而不是 building", () => {
  const { dir, cleanup } = tmpDir();
  const graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    logger: { log() {}, warn() {}, error() {} },
  });
  graph.store.markSource("stuck.md", { status: "building", chunks: 5 });
  const db = (graph.store as unknown as { db: { exec(sql: string): void } }).db;
  db.exec(`UPDATE graph_sources SET updated_at = '2000-01-01 00:00:00' WHERE source = 'stuck.md'`);

  const diff = graph.diff([{ source: "stuck.md", chunks: 5 }]);
  assert.deepEqual(diff.stuck, ["stuck.md"]);
  assert.deepEqual(diff.building, []);
  assert.ok(!diff.missing.includes("stuck.md"), "stuck 不应同时算 missing");
  graph.close();
  cleanup();
});

/* ---------------------------------------------------------------- 实体消解 */

test("resolveDuplicateEntities 合并同名多 type 实体并重定向边", () => {
  const { dir, cleanup } = tmpDir();
  const graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    logger: { log() {}, warn() {}, error() {} },
  });
  const store = graph.store;
  // 同一名称「传送」被抽成两种 type：concept 与 tech
  const concept = entityId("传送", "concept");
  const tech = entityId("传送", "tech");
  const other = entityId("闪现", "concept");
  store.upsertEntity({ id: concept, name: "传送", type: "concept", props: {} });
  store.upsertEntity({ id: tech, name: "传送", type: "tech", props: {} });
  store.upsertEntity({ id: other, name: "闪现", type: "concept", props: {} });
  store.linkEntitySource(concept, "doc.md");
  store.linkEntitySource(tech, "doc.md");
  store.linkEntitySource(other, "doc.md");
  store.upsertRelation({
    id: relationId(concept, "related_to", other),
    srcId: concept,
    dstId: other,
    relType: "related_to",
    weight: 1,
    sourceChunk: "c:0",
    source: "doc.md",
    origin: "rule",
  });
  store.upsertRelation({
    id: relationId(tech, "related_to", other),
    srcId: tech,
    dstId: other,
    relType: "related_to",
    weight: 1,
    sourceChunk: "c:1",
    source: "doc.md",
    origin: "rule",
  });

  const result = graph.resolveDuplicateEntities();
  assert.equal(result.groups, 1);
  assert.equal(result.removedEntities, 1);
  assert.equal(store.stats().entities, 2, "同名多 type 合并为一个");

  // 合并后仍能通过旧名检索，且边被归一（对称谓词 + 同端点）
  const found = store.findEntitiesByName("传送");
  assert.equal(found.length, 1);
  assert.ok(store.aliasesOf(found[0]!.id).length > 0, "旧名登记为别名");
  graph.close();
  cleanup();
});

test("resolveDuplicateEntities dryRun 不修改数据", () => {
  const { dir, cleanup } = tmpDir();
  const graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    logger: { log() {}, warn() {}, error() {} },
  });
  for (const type of ["concept", "tech"]) {
    graph.store.upsertEntity({ id: entityId("传送", type), name: "传送", type, props: {} });
  }
  const result = graph.resolveDuplicateEntities({ dryRun: true });
  assert.equal(result.groups, 1);
  assert.equal(result.removedEntities, 1);
  assert.equal(graph.store.stats().entities, 2, "dryRun 不落库");
  graph.close();
  cleanup();
});

/* ---------------------------------------------------------------- 质量快照 */

test("quality 报出共现边占比、重复实体与反向边", () => {
  const { dir, cleanup } = tmpDir();
  const store = storeIn(dir);
  const a = entityId("A", "org");
  const b = entityId("B", "org");
  const a2 = entityId("A", "concept");
  for (const [id, name, type] of [
    [a, "A", "org"],
    [b, "B", "org"],
    [a2, "A", "concept"],
  ] as const) {
    store.upsertEntity({ id, name, type, props: {} });
  }
  store.upsertRelation({
    id: relationId(a, "related_to", b),
    srcId: a,
    dstId: b,
    relType: "related_to",
    weight: 1,
    sourceChunk: "c:0",
    source: "doc.md",
    origin: "rule",
  });

  const quality = store.quality();
  assert.equal(quality.entities, 3);
  assert.equal(quality.relations, 1);
  assert.equal(quality.relatedToRatio, 1, "全部是共现边");
  assert.equal(quality.weightOneRatio, 1);
  assert.equal(quality.duplicateNameGroups, 1, "A 有两个 type");
  assert.equal(quality.redundantEntities, 1);
  assert.equal(quality.isolatedEntities, 1, "a2 没有边");
  store.close();
  cleanup();
});

/* ---------------------------------------------------------------- chunk 容错 */

test("单个 chunk 抽取失败不拖垮整篇，失败计入 failedChunks", async () => {
  const { dir, cleanup } = tmpDir();
  let calls = 0;
  const graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    extractor: {
      async extract(c: ChunkLike) {
        calls += 1;
        if (c.id === "c:1") throw new Error("LLM 超时");
        return {
          entities: [
            { id: entityId(`e${calls}`, "org"), name: `e${calls}`, type: "org", props: {} },
          ],
          relations: [],
        };
      },
    },
    maxChunkFailureRatio: 0.5,
    logger: { log() {}, warn() {}, error() {} },
  });
  const summary = await graph.ingest([chunk("c:0", "a"), chunk("c:1", "b"), chunk("c:2", "c")]);
  assert.equal(summary.failedChunks.length, 1);
  assert.equal(summary.failedChunks[0]!.chunkId, "c:1");
  assert.equal(summary.entities, 2, "其余 chunk 正常入库");
  assert.equal(graph.getStats().entities, 2);
  graph.close();
  cleanup();
});

test("失败比例超阈值时整篇失败，避免残缺图谱覆盖旧数据", async () => {
  const { dir, cleanup } = tmpDir();
  let calls = 0;
  const graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    extractor: {
      async extract() {
        calls += 1;
        if (calls > 1) throw new Error("全部失败");
        return { entities: [], relations: [] };
      },
    },
    maxChunkFailureRatio: 0.2,
    logger: { log() {}, warn() {}, error() {} },
  });
  await assert.rejects(
    () => graph.ingest([chunk("c:0", "a"), chunk("c:1", "b"), chunk("c:2", "c")]),
    /抽取失败比例过高/,
  );
  graph.close();
  cleanup();
});

/* ------------------------------------------------- 重建失败必须保留旧图（回归） */

test("重建失败率高时回滚，旧图谱不被清空", async () => {
  const { dir, cleanup } = tmpDir();
  let failAll = false;
  const graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    extractor: {
      async extract(c: ChunkLike) {
        if (failAll) throw new Error("LLM 限流");
        // 第一次建图：从 c:0 抽出 A、B 两个实体和一条边
        if (c.id !== "c:0") return { entities: [], relations: [] };
        const a = { id: entityId("A", "org"), name: "a", type: "org", props: {} };
        const b = { id: entityId("B", "org"), name: "b", type: "org", props: {} };
        return {
          entities: [a, b],
          relations: [
            {
              id: relationId(a.id, "supplies", b.id),
              srcId: a.id,
              dstId: b.id,
              relType: "supplies",
              weight: 1,
              sourceChunk: c.id,
              source: c.source,
            },
          ],
        };
      },
    },
    maxChunkFailureRatio: 0.2,
    logger: { log() {}, warn() {}, error() {} },
  });

  const chunks = [chunk("c:0", "A B"), chunk("c:1", "x"), chunk("c:2", "y"), chunk("c:3", "z")];
  await graph.ingest(chunks);
  const healthy = graph.getStats();
  assert.equal(healthy.entities, 2, "首次建图成功");
  assert.equal(healthy.relations, 1);

  // 第二次重建：全部抽取失败（模拟 LLM 限流）
  failAll = true;
  await assert.rejects(() => graph.ingest(chunks), /已回滚本次写入/);

  // 关键断言：旧图必须还在，不能被「先删后抽」清空
  const after = graph.getStats();
  assert.equal(after.entities, 2, "失败回滚后旧实体仍在");
  assert.equal(after.relations, 1, "失败回滚后旧关系仍在");
  graph.close();
  cleanup();
});

test("重建部分失败但在阈值内时保留旧图并写入新数据", async () => {
  const { dir, cleanup } = tmpDir();
  let mode: "ok" | "partial" = "ok";
  const graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    extractor: {
      async extract(c: ChunkLike) {
        if (mode === "partial" && c.id === "c:3") throw new Error("单块超时");
        const e = { id: entityId(`e-${c.id}`, "org"), name: `e-${c.id}`, type: "org", props: {} };
        return { entities: [e], relations: [] };
      },
    },
    maxChunkFailureRatio: 0.5,
    logger: { log() {}, warn() {}, error() {} },
  });
  const chunks = [chunk("c:0", "a"), chunk("c:1", "b"), chunk("c:2", "c"), chunk("c:3", "d")];
  await graph.ingest(chunks);
  assert.equal(graph.getStats().entities, 4);

  mode = "partial"; // 1/4 失败，低于 50% 阈值
  await graph.ingest(chunks);
  // c:3 抽取失败 → 它的实体本次没有重新写入 → 作为陈旧数据被清理。
  // 这是正确语义：失败块的旧数据不该继续冒充「本次重建的结果」。
  // 关键是不能像早先那样把全部实体归零。
  assert.equal(graph.getStats().entities, 3, "只有失败块的数据被清理，其余保留");
  graph.close();
  cleanup();
});

test("回滚必须精确还原：不留残渣也不丢数据", async () => {
  const { dir, cleanup } = tmpDir();
  const chunkList = Array.from({ length: 5 }, (_, i) => chunk(`c:${i}`, `text ${i}`));

  // 阶段一：用 old* 命名建图
  const graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    extractor: {
      async extract(c: ChunkLike) {
        const a = {
          id: entityId(`old${c.chunkIndex}`, "concept"),
          name: `old${c.chunkIndex}`,
          type: "concept",
          props: {},
        };
        const b = {
          id: entityId(`old${c.chunkIndex}b`, "concept"),
          name: `old${c.chunkIndex}b`,
          type: "concept",
          props: {},
        };
        return {
          entities: [a, b],
          relations: [
            {
              id: relationId(a.id, "related_to", b.id),
              srcId: a.id,
              dstId: b.id,
              relType: "related_to",
              weight: 1,
              sourceChunk: c.id,
              source: c.source,
              origin: "rule" as const,
            },
          ],
        };
      },
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  await graph.ingest(chunkList);
  const before = graph.store.graphForSource("doc.md");
  const beforeEntities = new Set(before.entities.map((e) => e.id));
  const beforeRelations = new Set(before.relations.map((r) => r.id));
  graph.close();

  // 阶段二：换一批全新实体名，且大部分失败 —— 模拟上游限流下的重建
  let calls = 0;
  const graph2 = new KnowledgeGraph({
    dbPath: join(dir, "graph.db"),
    extractor: {
      async extract(c: ChunkLike) {
        calls += 1;
        if (calls > 1) throw new Error("429 限流");
        const x = {
          id: entityId(`NEW${c.chunkIndex}`, "concept"),
          name: `new${c.chunkIndex}`,
          type: "concept",
          props: {},
        };
        return { entities: [x], relations: [] };
      },
    },
    maxChunkFailureRatio: 0.2,
    logger: { log() {}, warn() {}, error() {} },
  });
  await assert.rejects(() => graph2.ingest(chunkList), /已回滚本次写入/);

  const after = graph2.store.graphForSource("doc.md");
  const afterEntities = new Set(after.entities.map((e) => e.id));
  const afterRelations = new Set(after.relations.map((r) => r.id));

  // 精确还原：集合完全相等，既不能留本次新抽的残渣，也不能丢旧图
  assert.deepEqual(
    [...afterEntities].sort(),
    [...beforeEntities].sort(),
    "回滚后实体集合与重建前完全一致",
  );
  assert.deepEqual(
    [...afterRelations].sort(),
    [...beforeRelations].sort(),
    "回滚后关系集合与重建前完全一致",
  );
  graph2.close();
  cleanup();
});
