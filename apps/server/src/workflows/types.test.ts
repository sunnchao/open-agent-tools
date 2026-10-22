import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphToRunNodes, type WorkflowGraph } from "./types.js";

/** 旧版数据库里保存的画布节点：kind 仍是 graph，schema 已不再接受它。 */
function legacyGraph(): WorkflowGraph {
  return {
    name: "legacy",
    nodes: [
      {
        id: "graph-1",
        data: {
          id: "graph-1",
          kind: "graph" as never,
          label: "图谱检索",
          config: {
            sources: ["guide.md"],
            query: "{{query}}",
            outputs: [{ name: "formatted", selector: "$result.formatted" }],
          },
        },
      },
      {
        id: "rag-1",
        data: { id: "rag-1", kind: "rag", config: { sources: ["faq.md"], query: "q" } },
      },
    ],
    edges: [],
  };
}

describe("graphToRunNodes legacy migration", () => {
  it("migrates persisted graph nodes from old drafts/versions before execution", () => {
    const nodes = graphToRunNodes(legacyGraph());

    assert.equal(nodes[0]!.kind, "rag");
    // 默认旧名统一改为「知识检索」：节点库里已没有「图谱检索」类型，继续显示旧名会误导。
    assert.equal(nodes[0]!.label, "知识检索");
    assert.equal(nodes[0]!.config?.graph, true, "迁移后图谱增强保持开启");
    assert.equal(nodes[0]!.config?.graphHops, 2);
    assert.deepEqual(nodes[0]!.config?.sources, ["guide.md"]);
    assert.deepEqual(nodes[0]!.config?.outputs, [
      { name: "formatted", selector: "$result.formatted" },
    ]);

    // 已经合法的 rag 节点不受影响（迁移只针对旧 graph kind）。
    assert.equal(nodes[1]!.kind, "rag");
    assert.equal(nodes[1]!.config?.graph, undefined);
  });

  it("is idempotent and keeps node identity stable across repeated conversions", () => {
    const first = graphToRunNodes(legacyGraph());
    const second = graphToRunNodes(legacyGraph());
    assert.deepEqual(first, second);
    assert.equal(first[0]!.id, "graph-1");
    assert.equal(first[1]!.id, "rag-1");
  });
});
