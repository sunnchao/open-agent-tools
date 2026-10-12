import assert from "node:assert/strict";
import { it } from "node:test";
import {
  conditionConfigIssues,
  conditionRouteIssues,
  isVisualCondition,
  selectedConditionEdges,
} from "./condition.js";
import { effectiveNodeConfig, nodeConfigSchemas, workflowGraphSchema } from "./graph.js";
import { inputVariableType, variableIssues, type VariableNode } from "./index.js";
import { prepareResumeCheckpoint, type ResumeGraph } from "./resume.js";

const visual = {
  mode: "visual",
  inputs: [{ name: "score", source: { type: "run", variable: "score" }, required: false }],
  cases: [
    { id: "high", rules: [{ variable: "score", operator: "gt", value: 80 }] },
    { id: "middle", rules: [{ variable: "score", operator: "gte", value: 50 }] },
  ],
};
const types = new Map([["score", "number" as const]]);

it("saves incomplete visual drafts and preserves legacy expression mode", () => {
  for (const cases of [
    [],
    [{ id: "if", rules: [] }],
    [{ id: "if", rules: [{ variable: "", operator: "is" }] }],
  ])
    assert.equal(nodeConfigSchemas.condition.safeParse({ mode: "visual", cases }).success, true);
  assert.equal(isVisualCondition(effectiveNodeConfig("condition", { expression: "true" })), false);
  assert.equal(isVisualCondition({ ...visual, mode: "expression" }), false);
  assert.equal(isVisualCondition({ cases: visual.cases }), true);
  assert.equal(
    nodeConfigSchemas.condition.safeParse({ cases: [{ id: "else", rules: [] }] }).success,
    false,
  );
  assert.equal(
    workflowGraphSchema.safeParse({
      name: "branches",
      nodes: ["c", "e"].map((id) => ({
        id,
        data: { kind: id === "c" ? "condition" : "end", config: id === "c" ? visual : {} },
      })),
      edges: [{ source: "c", target: "e", branchId: "high" }],
    }).success,
    true,
  );
});

it("validates empty, malformed, duplicate, unsafe and incompatible rules without crashing", () => {
  assert.deepEqual(conditionConfigIssues(visual, types), []);
  assert.equal(conditionConfigIssues({ mode: "visual", cases: [] })[0]?.code, "condition-empty");
  assert.equal(
    conditionConfigIssues({ mode: "visual", cases: [null] })[0]?.code,
    "condition-schema",
  );
  assert.equal(
    conditionConfigIssues({ ...visual, cases: [visual.cases[0], visual.cases[0]] }, types)[0]?.code,
    "condition-case-id",
  );
  for (const [rule, code] of [
    [{ variable: "score.__proto__", operator: "is_empty" }, "condition-reference"],
    [{ variable: "score", operator: "gt" }, "condition-value"],
    [{ variable: "score", operator: "contains", value: 1 }, "condition-type"],
    [{ variable: "score", operator: "gt", value: "80" }, "condition-value-type"],
  ] as const)
    assert.ok(
      conditionConfigIssues({ ...visual, cases: [{ id: "high", rules: [rule] }] }, types).some(
        (issue) => issue.code === code,
      ),
    );
  assert.deepEqual(
    conditionConfigIssues(
      {
        ...visual,
        cases: [{ id: "high", rules: [{ variable: "score", operator: "eq", value: 0 }] }],
      },
      types,
    ),
    [],
  );
});

it("routes stable branch IDs with fan-out and keeps legacy default fallback semantics", () => {
  const edges = [
    { branchId: "high" },
    { branchId: "high" },
    { branchId: "middle" },
    { branchId: "else" },
  ];
  assert.deepEqual(conditionRouteIssues(visual, edges), []);
  assert.equal(selectedConditionEdges(visual, "high", edges).length, 2);
  assert.deepEqual(
    conditionRouteIssues(visual, edges.slice(0, 2)).map((issue) => issue.caseId),
    ["middle", "else"],
  );
  assert.equal(
    conditionRouteIssues(visual, [...edges, { branchId: "missing" }])[0]?.code,
    "condition-routes",
  );
  assert.throws(() => selectedConditionEdges(visual, true, edges), /缓存不完整/);
  const legacy = [{ label: "true" }, {}, { label: "false" }];
  assert.deepEqual(selectedConditionEdges({}, false, legacy), [legacy[2]]);
  assert.deepEqual(selectedConditionEdges({}, false, legacy.slice(0, 2)), [{}]);
  assert.throws(() => selectedConditionEdges({}, "else", legacy), /缓存不完整/);
});

it("infers condition input types through upstream bindings and skips inactive templates", () => {
  const nodes: VariableNode[] = [
    { id: "s", kind: "start", config: { runVariables: [{ name: "score", type: "number" }] } },
    {
      id: "i",
      kind: "input",
      config: { inputs: visual.inputs, outputs: [{ name: "score", selector: "$inputs.score" }] },
    },
    {
      id: "c",
      kind: "condition",
      config: {
        ...visual,
        expression: "{{inactive}}",
        inputs: [{ name: "score", source: { type: "node", nodeId: "i", output: "score" } }],
      },
    },
  ];
  assert.equal(inputVariableType(nodes[2]!, "score", nodes), "number");
  assert.deepEqual(variableIssues(nodes), []);
  nodes[2]!.config = {
    ...visual,
    cases: [
      { id: "if", rules: [{ variable: "score", operator: "is_empty", value: "{{inactive}}" }] },
    ],
  };
  assert.deepEqual(variableIssues(nodes), []);
  nodes[2]!.config = {
    ...visual,
    mode: "expression",
    expression: "true",
    cases: [{ id: "unused", rules: [{ variable: "{{missing}}", operator: "is" }] }],
  };
  assert.deepEqual(variableIssues(nodes), []);
});

it("resumes ELIF and ELSE selected paths and rejects upstream condition or branch changes", () => {
  const graph: ResumeGraph = {
    nodes: [
      { id: "s", kind: "start" },
      { id: "c", kind: "condition", config: visual },
      ...["high", "middle", "else"].map((id) => ({ id, kind: "input" })),
      { id: "end", kind: "end" },
    ],
    edges: [
      { id: "s-c", source: "s", target: "c" },
      ...["high", "middle", "else"].flatMap((id) => [
        { id: `c-${id}`, source: "c", target: id, branchId: id },
        { id: `${id}-end`, source: id, target: "end" },
      ]),
    ],
  };
  for (const result of ["middle", "else"]) {
    const cache = {
      s: { outputs: {} },
      c: { outputs: {}, result },
      [result]: { outputs: {} },
      end: { outputs: {} },
    };
    const checkpoint = prepareResumeCheckpoint(graph, graph, "end", cache);
    assert.deepEqual(Object.keys(checkpoint.cachedNodes), ["s", "c", result]);
    assert.deepEqual(checkpoint.activeEdgeIds, ["s-c", `c-${result}`, `${result}-end`]);
    const changed = structuredClone(graph);
    changed.edges[1]!.branchId = "middle";
    assert.throws(() => prepareResumeCheckpoint(changed, graph, "end", cache), /上游节点 c 已修改/);
    changed.edges = graph.edges;
    changed.nodes[1]!.config!.cases = [...visual.cases].reverse();
    assert.throws(() => prepareResumeCheckpoint(changed, graph, "end", cache), /上游节点 c 已修改/);
  }
});
