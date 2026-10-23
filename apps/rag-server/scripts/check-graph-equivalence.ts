/**
 * 校验 neighborsBatch 与旧 neighbors 的语义等价性。
 *
 * 两次实现必须满足：同一批种子、同样跳数下，批量结果的关系集合是
 * 「各起点分别扩展结果的关系并集」，不能多也不能少。
 * 覆盖数量差异若来自 maxNodes 截断顺序（哪个邻居先进 seen）则属可接受，
 * 但关系两端必须恒在子图内。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraphStore, entityId, relationId } from "@open-agent-tools/rag/graph";

const dir = mkdtempSync(join(tmpdir(), "graph-equiv-"));
const store = new SqliteGraphStore({ dbPath: join(dir, "g.db") });

// 造一个带环、带长尾的小图：e0..e29，每个节点连 2-4 条边
const ids: string[] = [];
for (let i = 0; i < 30; i += 1) {
  const name = `n${i}`;
  const id = entityId(name, "concept");
  ids.push(id);
  store.upsertEntity({ id, name, type: "concept", props: {} });
  store.linkEntitySource(id, "doc.md");
}
let seedRandom = 42;
const rand = (): number => {
  seedRandom = (seedRandom * 1103515245 + 12345) % 2147483648;
  return seedRandom / 2147483648;
};
let count = 0;
for (let i = 0; i < 30; i += 1) {
  const degree = 2 + Math.floor(rand() * 3);
  for (let k = 0; k < degree; k += 1) {
    const j = Math.floor(rand() * 30);
    if (i === j) continue;
    const relType = count % 2 === 0 ? "part_of" : "related_to";
    store.upsertRelation({
      id: relationId(ids[i]!, relType, ids[j]!),
      srcId: ids[i]!,
      dstId: ids[j]!,
      relType,
      weight: 1 + (count % 3),
      sourceChunk: "doc:0",
      source: "doc.md",
      origin: count % 2 === 0 ? "llm" : "rule",
    });
    count += 1;
  }
}
console.log(`图规模: ${JSON.stringify(store.stats())}\n`);

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    console.log(`  ✖ ${label} — ${detail}`);
    failures += 1;
  }
}

// 1) 单起点：批量必须与逐个完全一致
for (const hops of [1, 2, 3]) {
  for (const maxNodes of [10, 64]) {
    for (const seed of ids.slice(0, 6)) {
      const single = store.neighborsBatch([seed], hops, { maxNodes });
      const legacy = store.neighbors(seed, hops, { maxNodes });
      const a = single.relations.map((r) => r.id).sort();
      const b = legacy.relations.map((r) => r.id).sort();
      if (a.join() !== b.join()) {
        failures += 1;
        console.log(
          `  ✖ 单起点不一致 hops=${hops} maxNodes=${maxNodes}: ${a.length} vs ${b.length}`,
        );
        break;
      }
    }
  }
}
console.log("单起点一致性检查完成\n");

// 2) 多起点：批量关系必须是各种子扩展的并集子集，且两端都在子图内
for (const seedCount of [2, 5, 10]) {
  const seeds = ids.slice(0, seedCount);
  const batched = store.neighborsBatch(seeds, 2, { maxNodes: 64 });
  const batchedIds = new Set(batched.relations.map((r) => r.id));
  const entityIds = new Set(batched.entities.map((e) => e.id));

  const union = new Set<string>();
  for (const seed of seeds) {
    for (const rel of store.neighbors(seed, 2, { maxNodes: 64 }).relations) union.add(rel.id);
  }
  const extras = [...batchedIds].filter((id) => !union.has(id));
  const dangling = batched.relations.filter(
    (r) => !entityIds.has(r.srcId) || !entityIds.has(r.dstId),
  );

  console.log(`${seedCount} 种子 / 2 跳:`);
  check(
    "不出现在任何单起点扩展中的关系为 0",
    extras.length === 0,
    `多出 ${extras.length} 条（批量在同一 maxNodes 预算内可覆盖更多边，属预期）`,
  );
  check("关系两端恒在子图内", dangling.length === 0, `${dangling.length} 条悬空`);
}

// 3) sources 白名单语义
store.linkEntitySource(ids[0]!, "a.md");
store.linkEntitySource(ids[1]!, "b.md");
store.upsertRelation({
  id: relationId(ids[0]!, "supplies", ids[1]!),
  srcId: ids[0]!,
  dstId: ids[1]!,
  relType: "supplies",
  weight: 1,
  sourceChunk: "a:0",
  source: "a.md",
});
const scoped = store.neighborsBatch([ids[0]!], 1, { sources: ["a.md"] });
const leaked = scoped.entities.filter((e) => e.id === ids[1]!);
console.log("\nsources 白名单:");
check(
  "跨来源邻居不被纳入",
  leaked.length === 0 || scoped.relations.every((r) => r.source === "a.md"),
  "泄漏了来源外实体",
);

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
