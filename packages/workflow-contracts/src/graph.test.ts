import assert from "node:assert/strict";
import { it } from "node:test";
import {
  effectiveNodeConfig,
  migrateLegacyGraphNode,
  migrateLegacyGraphNodes,
  nodeKindSchema,
  nodeConfigSchemas,
  workflowGraphSchema,
} from "./graph.js";

it("provides one kind/config contract and enforces execution bounds", () => {
  assert.equal(nodeKindSchema.options.length, 9);
  assert.equal(nodeKindSchema.safeParse("graph").success, false, "独立图谱节点已并入知识检索");
  assert.equal(nodeKindSchema.safeParse("unknown").success, false);
  assert.equal(nodeConfigSchemas.llm.safeParse({ timeoutMs: 999 }).success, false);
  assert.equal(nodeConfigSchemas.mcp.safeParse({ retry: { maxRetries: 4 } }).success, false);
  assert.equal(nodeConfigSchemas.rag.safeParse({ sources: "x" }).success, false);
  assert.equal(
    nodeConfigSchemas.mcp.safeParse({ timeoutMs: 3000, retry: { maxRetries: 3, delayMs: 100 } })
      .success,
    true,
  );
  assert.equal(
    (nodeConfigSchemas.mcp.parse({ service: "legacy" }) as { service?: string }).service,
    "legacy",
  );
});
it("merges graph augmentation into the knowledge-retrieval node", () => {
  assert.equal(nodeConfigSchemas.rag.safeParse({ query: "query" }).success, true);
  assert.deepEqual(effectiveNodeConfig("rag").sources, []);
  assert.equal(effectiveNodeConfig("rag").graph, true, "图谱增强默认开启");
  assert.equal(effectiveNodeConfig("rag").graphHops, 2);
  for (const graphHops of [0, 5, 1.5, "2"]) {
    assert.equal(nodeConfigSchemas.rag.safeParse({ graphHops }).success, false);
  }
  assert.equal(nodeConfigSchemas.rag.safeParse({ graph: false }).success, true);
});
it("validates SQL query nodes and their result limits", () => {
  assert.equal(
    nodeConfigSchemas.sql.safeParse({
      sourceId: "ops",
      query: "{{question}}",
      maxRows: 20,
      timeoutMs: 60000,
    }).success,
    true,
  );
  for (const maxRows of [0, 101, 1.5, "10"]) {
    assert.equal(nodeConfigSchemas.sql.safeParse({ maxRows }).success, false);
  }
  assert.equal(
    workflowGraphSchema.safeParse({
      name: "SQL workflow",
      nodes: [
        { id: "sql", data: { id: "sql", kind: "sql", config: { query: "查询前 10 个用户" } } },
      ],
      edges: [],
    }).success,
    true,
  );
});
it("rejects unknown kinds and inconsistent node identities when saving a draft", () => {
  const graph = {
    name: "draft",
    nodes: [{ id: "a", data: { id: "a", kind: "start", config: {} } }],
    edges: [],
  };
  assert.equal(workflowGraphSchema.safeParse(graph).success, true);
  assert.equal(
    workflowGraphSchema.safeParse({ ...graph, nodes: [{ id: "a", data: { kind: "unknown" } }] })
      .success,
    false,
  );
  assert.equal(
    workflowGraphSchema.safeParse({
      ...graph,
      nodes: [{ id: "a", data: { id: "b", kind: "start" } }],
    }).success,
    false,
  );
  assert.equal(
    workflowGraphSchema.safeParse({ ...graph, nodes: [...graph.nodes, ...graph.nodes] }).success,
    false,
  );
});

it("migrates legacy graph nodes into knowledge retrieval without breaking outputs", () => {
  const legacy = {
    id: "g1",
    kind: "graph",
    label: "图谱检索",
    config: {
      sources: ["guide.md"],
      query: "{{query}}",
      outputs: [{ name: "formatted", selector: "$result.formatted" }],
    },
  };
  const migrated = migrateLegacyGraphNode(legacy);
  assert.equal(migrated.kind, "rag");
  assert.equal(migrated.label, "知识检索", "默认旧名统一改为知识检索，避免与已删除的节点类型混淆");
  assert.equal(migrated.config.graph, true, "迁移后保持图谱增强开启");
  assert.equal(migrated.config.graphHops, 2);
  assert.deepEqual(migrated.config.sources, ["guide.md"]);
  assert.deepEqual(migrated.config.outputs, legacy.config.outputs);

  // 幂等：已迁移的节点再次迁移不变
  assert.deepEqual(migrateLegacyGraphNode(migrated), migrated);
  // 非图谱节点原样返回（引用相等）
  const ragNode = { id: "r1", kind: "rag" as const, config: {} };
  assert.equal(migrateLegacyGraphNode(ragNode), ragNode);
  // 未声明 outputs 时补 formatted，保持旧图谱节点输出契约
  const bare = migrateLegacyGraphNode({ id: "g2", kind: "graph", config: { sources: [] } });
  assert.deepEqual(bare.config.outputs, [{ name: "formatted", selector: "$result.formatted" }]);
  assert.equal(migrateLegacyGraphNodes([legacy, ragNode]).length, 2);
  // 用户自定义标签不被覆盖
  const custom = migrateLegacyGraphNode({
    id: "g3",
    kind: "graph",
    label: "我的供应商图谱",
    description: "这是我们团队定制的图谱节点",
    config: { sources: ["a.md"] },
  });
  assert.equal(custom.label, "我的供应商图谱");
  assert.equal(custom.description, "这是我们团队定制的图谱节点");
  // 默认旧描述也要换成新口径，否则画布上仍显示「子图多跳扩展」
  const defaultDesc = migrateLegacyGraphNode({
    id: "g4",
    kind: "graph",
    label: "图谱检索",
    description: "子图多跳扩展",
    config: { sources: ["a.md"] },
  });
  assert.equal(defaultDesc.description, "向量+关键词+图谱多路召回");
});
