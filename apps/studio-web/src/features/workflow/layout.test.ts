import { expect, it } from "vitest";
import { createNode } from "./graph.js";
import { layoutWorkflow } from "./layout.js";

it("lays out a measured branching DAG left to right without overlap or config changes", () => {
  const nodes = ["s", "a", "b", "e"].map((id) => createNode(id, "input", { x: 0, y: 0 }));
  const edges = [
    ["s", "a"],
    ["s", "b"],
    ["a", "e"],
    ["b", "e"],
  ].map(([source, target], index) => ({ id: String(index), source: source!, target: target! }));
  const result = layoutWorkflow(nodes, edges);
  expect(result[1]!.position.x).toBeGreaterThan(result[0]!.position.x);
  expect(result[3]!.position.x).toBeGreaterThan(result[1]!.position.x);
  expect(Math.abs(result[1]!.position.y - result[2]!.position.y)).toBeGreaterThanOrEqual(170);
  expect(result[0]?.data).toBe(nodes[0]?.data);
  expect(nodes.every((node) => node.position.x === 0)).toBe(true);
  expect(() =>
    layoutWorkflow(nodes, [...edges, { id: "cycle", source: "e", target: "s" }]),
  ).toThrow("包含环");
});
