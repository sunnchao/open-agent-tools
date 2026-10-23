/**
 * 在真实图谱库副本上验证本轮优化的实际效果。
 * 只读 + 在副本上做消解，不触碰仓库里的原始 rag-graph.db。
 */
import { KnowledgeGraph } from "@open-agent-tools/rag/graph";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: verify-graph-optimization.ts <dbPath>");

const silent = { log() {}, warn() {}, error() {} };
const graph = new KnowledgeGraph({ dbPath, logger: silent });

function show(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
}

const before = graph.store.quality?.();
if (!before) throw new Error("store does not expose quality()");
console.log("优化前质量快照（基于真实数据副本）:");
console.log(
  JSON.stringify(
    {
      entities: before.entities,
      relations: before.relations,
      relatedToRatio: `${(before.relatedToRatio * 100).toFixed(1)}%`,
      weightOneRatio: `${(before.weightOneRatio * 100).toFixed(1)}%`,
      isolatedEntities: before.isolatedEntities,
      leafEntities: before.leafEntities,
      avgDegree: before.avgDegree.toFixed(2),
      duplicateNameGroups: before.duplicateNameGroups,
      redundantEntities: before.redundantEntities,
      reverseDuplicateRelations: before.reverseDuplicateRelations,
      selfLoops: before.selfLoops,
    },
    null,
    2,
  ),
);
show("关系类型分布", before.relationsByType);

// 1) 实体消解：把同名多 type 合并
const dry = graph.resolveDuplicateEntities({ dryRun: true });
show("实体消解预览 (dryRun)", dry);
const applied = graph.resolveDuplicateEntities();
show("实体消解执行结果", applied);

// 2) 消解后再看质量指标
const after = graph.store.quality?.();
if (after) {
  console.log("\n=== 消解后质量快照 ===");
  console.log(
    JSON.stringify(
      {
        entities: after.entities,
        relations: after.relations,
        relatedToRatio: `${(after.relatedToRatio * 100).toFixed(1)}%`,
        duplicateNameGroups: after.duplicateNameGroups,
        redundantEntities: after.redundantEntities,
        reverseDuplicateRelations: after.reverseDuplicateRelations,
        isolatedEntities: after.isolatedEntities,
        avgDegree: after.avgDegree.toFixed(2),
      },
      null,
      2,
    ),
  );
}

// 3) 检索性能对比：旧实现逐节点查询 vs 新批量
const seeds = await graph.retriever.locateSeeds("惩戒 传送 闪现", 5);
show(
  "种子定位（游戏术语问句）",
  seeds.map((s) => ({ name: s.name, type: s.type })),
);

if (seeds.length > 0) {
  const started = performance.now();
  const sub = graph.retriever.expand(
    seeds.map((s) => s.id),
    { maxHops: 2, maxNodes: 64 },
  );
  const elapsed = performance.now() - started;
  show("批量扩展子图", {
    hops: 2,
    entities: sub.entities.length,
    relations: sub.relations.length,
    elapsedMs: Number(elapsed.toFixed(2)),
  });
  console.log(
    `\n首行三元组示例: ${sub.relations[0] ? `(${sub.entities.find((e) => e.id === sub.relations[0]!.srcId)?.name}) --${sub.relations[0]!.relType}--> (${sub.entities.find((e) => e.id === sub.relations[0]!.dstId)?.name})` : "无"}`,
  );
}

// 4) 僵死状态自愈（真实库里 lol-heroes-all.md 曾长期卡 building）
show("复位僵死来源", graph.resetStuckSources(0));
show(
  "复位后来源状态",
  graph.listSources().map((s) => ({ source: s.source, status: s.status, chunks: s.chunks })),
);

graph.close();
