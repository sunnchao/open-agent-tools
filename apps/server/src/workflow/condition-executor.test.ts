import assert from "node:assert/strict";
import { it } from "node:test";
import { prepareResumeCheckpoint, type CachedWorkflowNode } from "@open-agent-tools/workflow-contracts";
import {
  executeWorkflow,
  executeWorkflowNodeTest,
  validateWorkflow,
  type WorkflowEvent,
  type WorkflowRunRequest,
} from "./executor.js";

const config = {
  mode: "visual",
  inputs: [{ name: "score", source: { type: "run", variable: "score" }, required: false }],
  outputs: [{ name: "selected", selector: "$result" }],
  cases: [
    { id: "high", rules: [{ variable: "score", operator: "gte", value: 80 }] },
    { id: "middle", rules: [{ variable: "score", operator: "gte", value: 50 }] },
  ],
};
function request(score: unknown): WorkflowRunRequest {
  return {
    input: { score },
    nodes: [
      { id: "s", kind: "start", config: { runVariables: [{ name: "score", type: "any" }] } },
      { id: "c", kind: "condition", config },
      ...["high", "also-high", "middle", "else"].map((id) => ({
        id,
        kind: "end" as const,
        config: {
          inputs: [{ name: "answer", source: { type: "literal", value: id } }],
          outputs: [{ name: "answer", selector: "$inputs.answer" }],
        },
      })),
    ],
    edges: [
      { id: "s-c", source: "s", target: "c" },
      ...["high", "also-high", "middle", "else"].map((id) => ({
        id: `c-${id}`,
        source: "c",
        target: id,
        branchId: id === "also-high" ? "high" : id,
      })),
    ],
  };
}

it("executes only the first matching IF/ELIF or ELSE and all edges of that branch", async () => {
  for (const [score, branch, targets] of [
    [90, "high", ["high", "also-high"]],
    [60, "middle", ["middle"]],
    [10, "else", ["else"]],
  ] as const) {
    const events: WorkflowEvent[] = [];
    const result = await executeWorkflow(request(score), (event) => events.push(event));
    assert.deepEqual(Object.keys(result), ["s", "c", ...targets]);
    assert.deepEqual(result.c, { selected: branch });
    const selection = events.find((event) => event.type === "node_result" && event.nodeId === "c");
    assert.ok(selection?.type === "node_result");
    assert.equal(selection.result, branch);
    assert.equal(selection.metadata?.selectedBranchId, branch);
    assert.match(
      selection.metadata?.selectedBranchLabel ?? "",
      branch === "else" ? /ELSE/ : /CASE/,
    );
    assert.ok(events.some((event) => event.type === "run_done"));
    for (const target of targets) {
      const start = events.find((event) => event.type === "node_start" && event.nodeId === target);
      assert.ok(start?.type === "node_start");
      assert.deepEqual(start.incomingEdgeIds, [`c-${target}`]);
    }
  }
});

it("tests a visual node without outgoing routes and reports dynamic warnings", async () => {
  const tested = await executeWorkflowNodeTest({
    node: { id: "c", kind: "condition", config },
    inputs: { score: "not-a-number" },
  });
  assert.equal(tested.status, "success");
  assert.equal(tested.result, "else");
  assert.equal(tested.metadata.selectedBranchLabel, "ELSE");
  assert.equal(tested.metadata.warnings?.length, 2);
  assert.equal(JSON.stringify(tested.metadata.warnings).includes("not-a-number"), false);
});

it("rejects incomplete rules or routes before execution without silently selecting ELSE", () => {
  const missing = request(90);
  missing.edges = missing.edges.filter((edge) => edge.branchId !== "else");
  assert.throws(() => validateWorkflow(missing), /ELSE.*下一节点/);
  const dangling = request(90);
  dangling.edges[1]!.branchId = "missing";
  assert.throws(() => validateWorkflow(dangling), /无效.*分支/);
  const empty = request(90);
  empty.nodes[1]!.config = { ...config, cases: [{ id: "high", rules: [] }, config.cases[1]] };
  assert.throws(() => validateWorkflow(empty), /添加条件/);
  const invalid = request(90);
  invalid.edges[0]!.branchId = "high";
  assert.throws(() => validateWorkflow(invalid), /only condition/);
});

it("keeps expression Boolean results and unlabeled fallback routes", async () => {
  const legacy: WorkflowRunRequest = {
    input: {},
    nodes: [
      {
        id: "c",
        kind: "condition",
        config: { expression: "false", outputs: [{ name: "result", selector: "$result" }] },
      },
      { id: "yes", kind: "end" },
      { id: "fallback", kind: "end" },
    ],
    edges: [
      { source: "c", target: "yes", label: "true" },
      { source: "c", target: "fallback" },
    ],
  };
  const result = await executeWorkflow(legacy, () => {});
  assert.deepEqual(Object.keys(result), ["c", "fallback"]);
  assert.deepEqual(result.c, { result: false });
});

it("resumes a selected ELIF using the cached string result and emits its branch label", async () => {
  const graph = request(60);
  const cache: Record<string, CachedWorkflowNode> = {};
  await executeWorkflow(graph, (event) => {
    if (event.type === "node_result" && event.status === "success" && event.nodeId && event.outputs)
      cache[event.nodeId] = { inputs: event.inputs, outputs: event.outputs, result: event.result };
  });
  const resume = prepareResumeCheckpoint(graph, graph, "middle", cache);
  const events: WorkflowEvent[] = [];
  const outputs = await executeWorkflow(graph, (event) => events.push(event), { resume });
  assert.deepEqual(Object.keys(outputs), ["s", "c", "middle"]);
  assert.deepEqual(events.filter((event) => event.type === "node_start").map((event) => event.nodeId), ["middle"]);
  const cached = events.find((event) => event.type === "node_cached" && event.nodeId === "c");
  assert.equal(cached?.result, "middle");
  assert.equal(cached?.metadata?.selectedBranchLabel, "CASE 2 · ELIF");
  assert.throws(() => prepareResumeCheckpoint(graph, graph, "high", cache), /没有成功运行的缓存/);
});
