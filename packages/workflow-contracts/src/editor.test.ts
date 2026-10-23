import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultConfig, migrateNodeData, migrateLegacyGraphNodesInSnapshot,
  nodeInputs, nodeOutputs, validateWorkflowGraph,
  inputOptions, outputOptions, replaceTemplateReference, repairVariableReference, renameVariable,
  type WorkflowNodeData, type EditorVariableNode,
} from "./index.js";

function data(kind: WorkflowNodeData["kind"], config: Record<string, unknown>): WorkflowNodeData {
  return { id: "n", kind, label: "Node", description: "", status: "idle", config };
}

test("shared editor migration keeps legacy bindings, source aliases and prompts without mutating drafts", () => {
  const draft = data("rag", { knowledgeBase: " guide.md ", outputs: [], output: "context" });
  const before = JSON.stringify(draft);
  const migrated = migrateNodeData(draft);
  assert.deepEqual(migrated.config.sources, ["guide.md"]);
  assert.deepEqual(nodeOutputs(migrated), [{ name: "context", selector: "$result" }]);
  assert.equal(migrated.config.knowledgeBase, undefined);
  assert.equal(JSON.stringify(draft), before);
  assert.deepEqual(migrateNodeData(migrated), migrated);
  const llm = migrateNodeData(data("llm", { prompt: "legacy system" }));
  assert.equal(llm.config.systemPrompt, "legacy system");
  assert.equal(llm.config.prompt, "");
  assert.equal(Object.hasOwn(migrateNodeData(data("start", {})).config, "runVariables"), false);
});

test("native compatibility keeps raw draft bindings and prompt behavior while sharing MCP aliases", () => {
  const draft = data("llm", { prompt: "raw draft", inputs: [null, { name: "query" }] });
  const native = migrateNodeData(draft, undefined, { normalizeConfig: false });
  assert.deepEqual(native.config.inputs, draft.config.inputs);
  assert.equal(native.config.prompt, "raw draft");
  const mcp = migrateNodeData(data("mcp", { service: "legacy", tool: "search" }), undefined, { normalizeConfig: false });
  assert.equal(mcp.config.serviceSlug, "legacy");
  assert.equal(mcp.config.toolName, "search");
  assert.equal(mcp.config.service, undefined);
  assert.equal(defaultConfig("condition").mode, "visual");
  assert.deepEqual(nodeInputs({ config: { inputs: [null, { name: "q", source: { type: "run", variable: "q" } }] } }).map((binding) => binding.name), ["q"]);
});

test("legacy graph snapshot migration preserves wrappers, positions, bindings and custom fields", () => {
  const draft = { version: 1, graph: { name: "legacy", nodes: [{ id: "g", position: { x: 3, y: 4 }, data: { kind: "graph", label: "Custom", config: { sources: ["a"], inputs: [], outputs: [{ name: "facts", selector: "$result.formatted" }] } } }], edges: [] } };
  const before = JSON.stringify(draft);
  const migrated = migrateLegacyGraphNodesInSnapshot(draft);
  assert.equal(migrated.graph.nodes[0]?.data.kind, "rag");
  assert.equal(migrated.graph.nodes[0]?.data.label, "Custom");
  assert.deepEqual(migrated.graph.nodes[0]?.position, { x: 3, y: 4 });
  assert.deepEqual(migrated.graph.nodes[0]?.data.config.outputs, [{ name: "facts", selector: "$result.formatted" }]);
  assert.equal(JSON.stringify(draft), before);
  assert.deepEqual(migrateLegacyGraphNodesInSnapshot(migrated), migrated);
  assert.deepEqual(JSON.parse(JSON.stringify(migrated)), migrated);
});

test("strict editor and native draft validation retain their distinct structural gates", () => {
  const malformed = [{ id: "bad", data: { ...data("start", {}), kind: "unknown" as WorkflowNodeData["kind"] } }];
  assert.ok(validateWorkflowGraph(malformed, [], null).some((issue) => issue.code === "schema"));
  assert.ok(validateWorkflowGraph(malformed, [], null, { strict: false }).every((issue) => issue.code !== "schema"));
  assert.deepEqual(validateWorkflowGraph([], [], null, { strict: false }).map((issue) => issue.code), ["empty", "start-count", "end-count"]);
  const nodes = [{ id: "s", data: { ...data("start", { runVariables: [] }), id: "s" } }, { id: "e", data: { ...data("end", { outputs: [{ name: "answer", selector: "$result" }] }), id: "e" } }];
  assert.deepEqual(validateWorkflowGraph(nodes, [{ source: "s", target: "e" }], null), []);
  assert.deepEqual(validateWorkflowGraph(nodes, [{ source: "s", target: "e" }], null, { strict: false }), []);
});

test("binding choices share source keys, predecessor scope and platform sample labels", () => {
  const nodes: EditorVariableNode[] = [{ id: "s", data: { kind: "start", config: { runVariables: [{ name: "q", type: "string" }] } } }, { id: "a", data: { kind: "llm", label: "A", config: { outputs: [{ name: "answer", selector: "$result" }] } } }, { id: "b", data: { kind: "llm", config: {} } }];
  const options = inputOptions(nodes[2]!, nodes, [{ source: "a", target: "b" }]);
  assert.deepEqual(options.map((option) => JSON.parse(option.value).type), ["run", "node", "literal"]);
  assert.equal(options[1]?.label, "answer · A");
  assert.ok(outputOptions(nodes[1]!, { nested: { value: 1 } }).some((option) => option.label === "$result.nested.value · number"));
  assert.ok(outputOptions(nodes[1]!, { nested: { value: 1 } }, (selector) => selector).some((option) => option.label === "$result.nested.value"));
});

test("renaming and JSON template repair preserve object keys, invalid JSON drafts and node metadata", () => {
  assert.equal(replaceTemplateReference('{"{{old}}":"{{old}}","literal":"old"}', "old", "next", true), '{\n  "{{old}}": "{{next}}",\n  "literal": "old"\n}');
  assert.equal(replaceTemplateReference("{bad json {{old}}", "old", "next", true), "{bad json {{old}}");
  const nodes = [{ id: "http", position: { x: 1, y: 2 }, data: { kind: "http", config: { inputs: [{ name: "old", source: { type: "literal", value: "x" } }], body: { type: "json", data: '{"name":"{{old.value}}"}' }, outputs: [{ name: "result", selector: "$inputs.old.value" }] } } }];
  const before = JSON.stringify(nodes);
  const renamed = renameVariable(nodes, "http", "inputs", "old", "next");
  assert.deepEqual(renamed[0]?.position, { x: 1, y: 2 });
  assert.match(String(renamed[0]?.data.config.body.data), /\{\{next.value\}\}/);
  assert.equal(renamed[0]?.data.config.outputs[0]?.selector, "$inputs.next.value");
  assert.equal(JSON.stringify(nodes), before);
});

test("condition repair keeps the native permissive policy and web bound-variable guard", () => {
  const nodes = [{ id: "c", data: { kind: "condition", config: { inputs: [], cases: [{ id: "if", logicalOperator: "and", rules: [{ id: "r", variable: "old", operator: "is_empty" }] }] } } }];
  const issue = { code: "condition-reference", message: "missing", nodeId: "c", reference: "old" };
  assert.equal(repairVariableReference(nodes, issue, "next"), nodes);
  const repaired = repairVariableReference(nodes, issue, "next", { conditionOnly: true, requireConditionBinding: false });
  assert.equal(repaired[0]?.data.config.cases[0]?.rules[0]?.variable, "next");
  assert.equal(nodes[0]?.data.config.cases[0]?.rules[0]?.variable, "old");
  assert.equal(repairVariableReference(nodes, { ...issue, code: "run-reference" }, "next", { conditionOnly: true }), nodes);
});
