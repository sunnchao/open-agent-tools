import { expect, it } from "vitest";
import { createEdge, createNode } from "./graph.js";
import { assertSelectionSources, parseSelection, serializeSelection } from "./clipboard.js";

it("round trips a subgraph across workflows with fresh ids, internal edges and zero runtime state", () => {
  const nodes = [
    createNode("a", "input", { x: 0, y: 0 }),
    createNode(
      "b",
      "end",
      { x: 280, y: 0 },
      {
        inputs: [{ name: "query", source: { type: "node", nodeId: "a", output: "query" } }],
      },
    ),
  ];
  nodes[0]!.data.status = "success";
  const text = serializeSelection(nodes, [createEdge("a", "b")], new Set(["a", "b"]));
  const first = parseSelection(text);
  const second = parseSelection(text);
  expect(first.nodes[0]?.data.status).toBe("idle");
  expect(first.nodes[0]?.id).not.toBe(second.nodes[0]?.id);
  expect(first.edges[0]?.source).toBe(first.nodes[0]?.id);
  expect(first.nodes[1]?.data.config.inputs).toEqual([
    { name: "query", source: { type: "node", nodeId: first.nodes[0]?.id, output: "query" } },
  ]);
  expect(first.nodes[1]!.position.x - first.nodes[0]!.position.x).toBe(280);
  expect(() => parseSelection("hello")).toThrow("工作流 JSON");
  expect(() => parseSelection("null")).toThrow("支持的工作流节点");
  expect(() =>
    serializeSelection([createNode("s", "start", { x: 0, y: 0 })], [], new Set(["s"])),
  ).toThrow("开始节点不能复制");
  const isolated = parseSelection(
    serializeSelection(nodes, [createEdge("a", "b")], new Set(["b"])),
  );
  expect(
    (isolated.nodes[0]?.data.config.inputs as Array<{ source: { nodeId: string } }>)[0]?.source
      .nodeId,
  ).toBe("a");
});

it("accepts remapped internal sources and checks external sources against the destination", () => {
  const upstream = createNode("source", "input", { x: 0, y: 0 });
  const downstream = createNode(
    "end",
    "end",
    { x: 280, y: 0 },
    {
      inputs: [{ name: "result", source: { type: "node", nodeId: "source", output: "query" } }],
    },
  );
  const copied = parseSelection(
    serializeSelection(
      [upstream, downstream],
      [createEdge("source", "end")],
      new Set(["source", "end"]),
    ),
  );
  expect(() => assertSelectionSources(copied.nodes, [])).not.toThrow();
  const external = parseSelection(serializeSelection([upstream, downstream], [], new Set(["end"])));
  expect(() => assertSelectionSources(external.nodes, [])).toThrow("上游节点");
  expect(() => assertSelectionSources(external.nodes, [upstream])).not.toThrow();
  upstream.data.config.outputs = [{ name: "renamed", selector: "$inputs.query" }];
  expect(() => assertSelectionSources(external.nodes, [upstream])).toThrow("上游节点");
});

it("removes fixed HTTP credentials from copied and externally pasted selections", () => {
  const node = createNode(
    "h",
    "http",
    { x: 0, y: 0 },
    {
      url: "https://example.com",
      authorization: { type: "bearer", config: { token: "private-clipboard" } },
    },
  );
  const text = serializeSelection([node], [], new Set(["h"]));
  expect(text).not.toContain("private-clipboard");
  const incoming = JSON.parse(text);
  incoming.graph.nodes[0].data.config.authorization.config.token = "private-incoming";
  const pasted = parseSelection(JSON.stringify(incoming));
  expect(JSON.stringify(pasted)).not.toContain("private-incoming");
  expect(node.data.config.authorization).toEqual({
    type: "bearer",
    config: { token: "private-clipboard" },
  });
});
