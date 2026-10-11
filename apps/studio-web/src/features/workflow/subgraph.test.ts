import { expect, it } from "vitest";
import { createNode } from "./graph.js";
import { cloneSubgraph } from "./subgraph.js";

it("copies a selected subgraph with fresh ids, internal bindings and branch labels", () => {
  const nodes = [
    createNode("a", "input", { x: 10, y: 20 }),
    createNode(
      "b",
      "condition",
      { x: 300, y: 20 },
      {
        inputs: [{ name: "query", source: { type: "node", nodeId: "a", output: "query" } }],
        expression: "{{query}}",
      },
    ),
  ];
  nodes[0]!.data.status = "success";
  let index = 0;
  const copy = cloneSubgraph(
    nodes,
    [{ id: "e", source: "a", target: "b", label: "true" }],
    new Set(["a", "b"]),
    false,
    () => String(++index),
  );
  expect(copy.nodes.map((node) => node.id)).toEqual(["input-1", "condition-2"]);
  expect(copy.nodes[1]?.data.config.inputs).toEqual([
    { name: "query", source: { type: "node", nodeId: "input-1", output: "query" } },
  ]);
  expect(copy.edges[0]).toMatchObject({ source: "input-1", target: "condition-2", label: "true" });
  expect(copy.nodes[1]!.position.x - copy.nodes[0]!.position.x).toBe(290);
  expect(copy.nodes[0]?.data.status).toBe("idle");
  expect(nodes[0]?.data.status).toBe("success");
  expect(nodes[1]?.data.config.expression).toBe("{{query}}");
});

it("preserves external dependencies for same-workflow duplication and blocks duplicate start nodes", () => {
  const nodes = [createNode("a", "input", { x: 0, y: 0 }), createNode("b", "end", { x: 0, y: 0 })];
  expect(
    cloneSubgraph(nodes, [{ id: "e", source: "a", target: "b" }], new Set(["b"]), true).edges,
  ).toHaveLength(1);
  expect(() =>
    cloneSubgraph([createNode("s", "start", { x: 0, y: 0 })], [], new Set(["s"])),
  ).toThrow("开始节点不能复制");
});
