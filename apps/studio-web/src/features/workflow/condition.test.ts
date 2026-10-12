import { expect, it } from "vitest";
import { conditionCases } from "@open-agent-tools/workflow-contracts";
import {
  branchHandle,
  canConnectTarget,
  conditionBranches,
  conditionVariableOptions,
  configureBranchEdge,
  newConditionCase,
  selectConditionVariable,
  updateConditionGraph,
} from "./condition.js";
import { createEdge, createNode, hydrateWorkflowSnapshot, snapshotGraph } from "./graph.js";
import { serializeWorkflow, parseWorkflowFile } from "./io.js";
import { cloneSubgraph } from "./subgraph.js";
import { parseSelection, serializeSelection } from "./clipboard.js";
import { renameVariable, sourceKey } from "./variables.js";

function graph() {
  const config = {
    mode: "visual",
    inputs: [{ name: "score", source: { type: "run", variable: "score" }, required: false }],
    outputs: [],
    cases: [
      { id: "first", rules: [{ variable: "score", operator: "gte", value: 80 }] },
      { id: "second", rules: [{ variable: "score", operator: "gte", value: 50 }] },
    ],
  };
  const nodes = [
    createNode("s", "start", { x: 0, y: 0 }, { runVariables: [{ name: "score", type: "number" }] }),
    createNode("c", "condition", { x: 300, y: 0 }, config),
    createNode(
      "e",
      "end",
      { x: 600, y: 0 },
      {
        inputs: [{ name: "answer", source: { type: "literal", value: "done" } }],
        outputs: [{ name: "answer", selector: "$inputs.answer" }],
      },
    ),
  ];
  const edges = [
    createEdge("s", "c"),
    ...["first", "second", "else"].map((id) =>
      configureBranchEdge(createEdge("c", "e"), config, id),
    ),
  ];
  return { name: "Conditions", nodes, edges };
}

it("defaults new nodes to visual and hydrates legacy nodes without injecting cases", () => {
  expect(createNode("new", "condition", { x: 0, y: 0 }).data.config).toMatchObject({
    mode: "visual",
    cases: [{ id: "if", rules: [] }],
  });
  const legacy = createNode("old", "condition", { x: 0, y: 0 }, { expression: "false" });
  const saved = hydrateWorkflowSnapshot({ name: "legacy", nodes: [legacy], edges: [] });
  expect(saved.nodes[0]!.data.config.cases).toBeUndefined();
  expect(conditionBranches(legacy.data.config).map((item) => item.id)).toEqual([
    "true",
    "false",
    "default",
  ]);
});

it("keeps IDs stable when adding or promoting cases and prunes only the removed branch edges", () => {
  const value = graph();
  const config = value.nodes[1]!.data.config;
  const added = newConditionCase();
  const expanded = updateConditionGraph(value.nodes, value.edges, "c", {
    ...config,
    cases: [...conditionCases(config), added],
  });
  expect(expanded.edges).toHaveLength(4);
  expect(conditionBranches(expanded.nodes[1]!.data.config).map((branch) => branch.id)).toEqual([
    "first",
    "second",
    added.id,
    "else",
  ]);
  const removed = updateConditionGraph(value.nodes, value.edges, "c", {
    ...config,
    cases: conditionCases(config).slice(1),
  });
  expect(removed.nodes.map((node) => node.id)).toEqual(["s", "c", "e"]);
  expect(removed.edges.map((edge) => edge.branchId)).toEqual([undefined, "second", "else"]);
  expect(conditionBranches(removed.nodes[1]!.data.config)[0]).toMatchObject({
    id: "second",
    label: "IF",
    caseLabel: "CASE 1",
  });
  const switched = updateConditionGraph(value.nodes, value.edges, "c", {
    ...config,
    mode: "expression",
    expression: "true",
  });
  expect(switched.edges).toHaveLength(1);
  expect(switched.nodes).toHaveLength(3);
  expect(value.edges).toHaveLength(4);
});

it("creates or reuses optional variable bindings, preserves required flags and avoids alias collisions", () => {
  const value = graph();
  let config = value.nodes[1]!.data.config;
  const run = sourceKey({ type: "run", variable: "score" });
  config = selectConditionVariable(config, "second", 0, run);
  expect(config.inputs).toHaveLength(1);
  config = {
    ...config,
    inputs: [{ name: "score", required: true, source: { type: "run", variable: "score" } }],
  };
  config = selectConditionVariable(config, "second", 0, run);
  expect(config.inputs).toMatchObject([{ required: true }]);
  config = selectConditionVariable(
    config,
    "second",
    0,
    sourceKey({ type: "node", nodeId: "up", output: "score" }),
  );
  expect(config.inputs).toMatchObject([{ name: "score" }, { name: "score2", required: false }]);
  expect(conditionCases(config)[1]!.rules[0]!.variable).toBe("score2");
  expect(conditionVariableOptions(value.nodes[1]!, value.nodes, value.edges)[0]).toMatchObject({
    type: "number",
    label: "score · number",
  });
});

it("rejects self, start and cycle connections while allowing multiple branch routes to the same target", () => {
  const value = graph();
  expect(canConnectTarget("c", "e", value.nodes, value.edges)).toBe(true);
  expect(canConnectTarget("c", "c", value.nodes, value.edges)).toBe(false);
  expect(canConnectTarget("e", "c", value.nodes, value.edges)).toBe(false);
  expect(canConnectTarget("c", "s", value.nodes, value.edges)).toBe(false);
});

it("round trips branch IDs and restores handles in save, file import and clipboard clones", () => {
  const value = graph();
  const stored = snapshotGraph(value.name, value.nodes, value.edges);
  expect(stored.edges[1]!.sourceHandle).toBeUndefined();
  for (const result of [
    hydrateWorkflowSnapshot(stored),
    parseWorkflowFile(serializeWorkflow(value), null),
  ])
    expect(result.edges.slice(1).map((edge) => [edge.branchId, edge.sourceHandle])).toEqual(
      ["first", "second", "else"].map((id) => [id, branchHandle(id)]),
    );
  const ids = new Set(["c", "e"]);
  const clone = cloneSubgraph(value.nodes, value.edges, ids);
  const pasted = parseSelection(serializeSelection(value.nodes, value.edges, ids));
  for (const result of [clone, pasted]) {
    expect(result.nodes.map((node) => node.id)).not.toContain("c");
    expect(result.edges.map((edge) => edge.sourceHandle)).toEqual(
      ["first", "second", "else"].map(branchHandle),
    );
    expect(conditionCases(result.nodes[0]!.data.config).map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
  }
});

it("renames condition references and RHS templates together", () => {
  const value = graph();
  value.nodes[1]!.data.config.cases = [
    { id: "first", rules: [{ variable: "score", operator: "gte", value: "{{score}}" }] },
  ];
  const renamed = renameVariable(value.nodes, "c", "inputs", "score", "points");
  expect(conditionCases(renamed[1]!.data.config)[0]!.rules[0]).toMatchObject({
    variable: "points",
    value: "{{points}}",
  });
});
