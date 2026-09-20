import { describe, expect, it } from "vitest";
import { createNode, hydrateWorkflowSnapshot, snapshotGraph } from "./graph.js";
import { nodeInputs, nodeOutputs, validateWorkflowGraph } from "./model.js";
import { inputOptions, outputOptions, renameVariable, nextVariableName } from "./variables.js";

const start = () =>
  createNode("s", "start", { x: 0, y: 0 }, { runVariables: [{ name: "query", type: "string" }] });
const input = () => createNode("i", "input", { x: 0, y: 0 });
describe("workflow variable editing", () => {
  it("migrates legacy graphs once, preserves explicit declarations, empty bindings and invalid drafts", () => {
    const legacyStart = start();
    delete legacyStart.data.config.runVariables;
    const legacy = snapshotGraph("legacy", [legacyStart, input()], []);
    const migrated = hydrateWorkflowSnapshot(legacy);
    expect(migrated.nodes[0]!.data.config.runVariables).toEqual([
      { name: "query", type: "any", required: true },
    ]);
    migrated.nodes[0]!.data.config.runVariables = [];
    migrated.nodes[1]!.data.config.inputs = [];
    const hydrated = hydrateWorkflowSnapshot(migrated);
    expect(hydrated.nodes[0]!.data.config.runVariables).toEqual([]);
    expect(hydrated.nodes[1]!.data.config.inputs).toEqual([]);
    expect(
      nodeInputs({
        ...input().data,
        config: { inputs: [{ name: "", source: { type: "literal", value: "" } }] },
      }),
    ).toHaveLength(1);
  });
  it("offers only direct predecessors and declared entry variables", () => {
    const end = createNode("e", "end", { x: 0, y: 0 });
    const ancestor = createNode("a", "llm", { x: 0, y: 0 });
    const options = inputOptions(
      end,
      [start(), input(), ancestor, end],
      [
        { source: "a", target: "i" },
        { source: "i", target: "e" },
      ],
    );
    expect(options.some((option) => option.value.includes('"nodeId":"i"'))).toBe(true);
    expect(options.some((option) => option.value.includes('"nodeId":"a"'))).toBe(false);
    expect(options.some((option) => option.group === "运行输入")).toBe(true);
  });
  it("renames entry bindings, node output consumers and local templates/selectors precisely", () => {
    const llm = createNode(
      "l",
      "llm",
      { x: 0, y: 0 },
      {
        inputs: [{ name: "query", source: { type: "node", nodeId: "i", output: "query" } }],
        prompt: "query {{ query }} {{query2}}",
        outputs: [{ name: "raw", selector: "$inputs.query" }],
      },
    );
    let nodes = renameVariable([start(), input(), llm], "s", "runVariables", "query", "question");
    expect(nodeInputs(nodes[1]!.data)[0]!.source).toEqual({ type: "run", variable: "question" });
    nodes = renameVariable(nodes, "i", "outputs", "query", "question");
    expect(nodeInputs(nodes[2]!.data)[0]!.source).toEqual({
      type: "node",
      nodeId: "i",
      output: "question",
    });
    nodes = renameVariable(nodes, "l", "inputs", "query", "question");
    expect(nodes[2]!.data.config.prompt).toBe("query {{question}} {{query2}}");
    expect(nodeOutputs(nodes[2]!.data)[0]!.selector).toBe("$inputs.question");
  });
  it("reports deleted sources while retaining their bindings for repair", () => {
    const node = input();
    const empty = start();
    empty.data.config.runVariables = [];
    expect(validateWorkflowGraph([empty, node], [{ source: "s", target: "i" }], null)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "run-reference" })]),
    );
    expect(nodeInputs(node.data)[0]!.source).toEqual({ type: "run", variable: "query" });
  });
  it("offers known output fields and labels sampled dynamic fields separately", () => {
    const graph = createNode("g", "graph", { x: 0, y: 0 });
    const options = outputOptions(graph, {
      formatted: "text",
      dynamic: { title: "value" },
      rows: [{ value: 1 }],
    });
    expect(options.filter((option) => option.value === "$result.formatted")).toHaveLength(1);
    expect(options.find((option) => option.value === "$result.dynamic.title")?.group).toMatch(
      /样例/,
    );
    expect(options.some((option) => option.value.includes("rows.0"))).toBe(false);
    expect(nextVariableName(["input", "input3"], "input")).toBe("input2");
  });
});

it("renames MCP argument values without rewriting literal object keys", () => {
  const node = createNode(
    "m",
    "mcp",
    { x: 0, y: 0 },
    {
      inputs: [{ name: "query", source: { type: "literal", value: "hello" } }],
      arguments: '{"{{query}}":{"nested":["{{query}}","query"]}}',
    },
  );
  const changed = renameVariable([node], "m", "inputs", "query", "question");
  expect(JSON.parse(String(changed[0]!.data.config.arguments))).toEqual({
    "{{query}}": { nested: ["{{question}}", "query"] },
  });
});
