import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeIdsInSet, neighborsOf, walkChain } from "./graph.js";

test("图遍历保留同名节点、去重、边顺序、循环及多跳语义", () => {
  const nodes = [
    { id: "a1", name: "Alpha", type: "table" },
    { id: "a2", name: "Alpha", type: "table" },
    { id: "b", name: "Beta", type: "table" },
    { id: "c", name: "Gamma", type: "table" },
    { id: "d", name: "Delta", type: "table" },
  ];
  const edges = [
    ["a1", "b"],
    ["a2", "c"],
    ["b", "a1"],
    ["a1", "a1"],
    ["c", "d"],
    ["missing", "a1"],
  ].map(([source, target], id) => ({
    id: String(id),
    source: source!,
    target: target!,
    relType: "related",
    weight: 1,
  }));
  assert.deepEqual(neighborsOf(edges, "Alpha", nodes), ["Beta", "Gamma", "Alpha"]);
  assert.deepEqual([...walkChain(edges, nodes, ["Alpha"], 0)], ["Alpha"]);
  assert.deepEqual([...walkChain(edges, nodes, ["Alpha"], 2)], ["Alpha", "Beta", "Gamma", "Delta"]);
  assert.deepEqual([...walkChain(edges, nodes, ["unknown"], 4)], ["unknown"]);
  assert.deepEqual([...edgeIdsInSet(edges, nodes, new Set(["Alpha", "Beta"]))], ["0", "2", "3"]);
});
