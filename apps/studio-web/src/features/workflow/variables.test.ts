import { describe, expect, it } from "vitest";
import { createNode, hydrateWorkflowSnapshot, snapshotGraph } from "./graph.js";
import { nodeInputs, nodeOutputs, validateWorkflowGraph } from "./model.js";
import {
  inputOptions,
  nextVariableName,
  outputOptions,
  renameVariable,
  repairVariableReference,
  replaceTemplateReference,
} from "./variables.js";

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
    // 图谱节点已并入知识检索；这里改用 rag 节点验证同一个 formatted 输出契约。
    const graph = createNode("g", "rag", { x: 0, y: 0 });
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

describe("定向修复失效引用", () => {
  it("仅替换精确模板 token", () => {
    expect(replaceTemplateReference("{{qurey}} {{qurey2}} text", "qurey", "query")).toBe(
      "{{query}} {{qurey2}} text",
    );
  });

  it("JSON 只替换值中的模板，不替换 key 或普通字符串", () => {
    expect(
      JSON.parse(
        replaceTemplateReference(
          '{"{{qurey}}":"{{qurey}}", "literal":"qurey", "nested":["x {{qurey}}"]}',
          "qurey",
          "query",
          true,
        ),
      ),
    ).toEqual({
      "{{qurey}}": "{{query}}",
      literal: "qurey",
      nested: ["x {{query}}"],
    });
  });

  it("JSON 非法时保持原值", () => {
    expect(replaceTemplateReference('{"x":', "qurey", "query", true)).toBe('{"x":');
  });

  it("模板修复限定在白名单字段和本节点输入", () => {
    const node = createNode(
      "l",
      "llm",
      { x: 0, y: 0 },
      {
        inputs: [
          { name: "query", source: { type: "literal", value: "hello" } },
          { name: "other", source: { type: "literal", value: "world" } },
        ],
        prompt: "{{qurey}}",
        systemPrompt: "{{qurey}}",
        outputs: [{ name: "answer", selector: "$inputs.query" }],
      },
    );
    const issue = {
      code: "template-reference",
      message: "",
      nodeId: "l",
      reference: "qurey",
      field: "prompt",
    } as const;
    const graph = [node];
    const changed = repairVariableReference(graph, issue, "query");
    expect(changed[0]!.data.config.prompt).toBe("{{query}}");
    expect(changed[0]!.data.config.systemPrompt).toBe("{{qurey}}");
    expect(changed[0]!.data.config.outputs).toEqual(node.data.config.outputs);
    expect(repairVariableReference(graph, { ...issue, field: "outputs" }, "query")).toBe(graph);
    expect(repairVariableReference(graph, issue, "missing")).toBe(graph);
  });

  it("run 修复只改目标节点精确 source.variable，保留 alias 和模板", () => {
    const startNode = start();
    const node = createNode(
      "i",
      "input",
      { x: 0, y: 0 },
      {
        inputs: [
          { name: "alias", source: { type: "run", variable: "qurey" } },
          { name: "same", source: { type: "run", variable: "qurey" } },
        ],
        prompt: "{{qurey}}",
        outputs: [{ name: "out", selector: "$inputs.alias" }],
      },
    );
    const issue = {
      code: "run-reference",
      message: "",
      nodeId: "i",
      reference: "qurey",
    } as const;
    const changed = repairVariableReference([startNode, node], issue, "query");
    expect(changed[1]!.data.config.inputs).toEqual([
      { name: "alias", source: { type: "run", variable: "query" } },
      { name: "same", source: { type: "run", variable: "query" } },
    ]);
    expect(changed[1]!.data.config.prompt).toBe("{{qurey}}");
    expect(changed[1]!.data.config.outputs).toEqual(node.data.config.outputs);
    expect(startNode.data.config.runVariables).toEqual([{ name: "query", type: "string" }]);
  });
});

it("renames and repairs nested HTTP body and authentication templates without rewriting JSON keys", () => {
  const node = createNode(
    "h",
    "http",
    { x: 0, y: 0 },
    {
      url: "https://example.com/{{response.items[0].id}}",
      inputs: [{ name: "response", source: { type: "literal", value: {} } }],
      method: "post",
      body: { type: "json", data: '{"{{response}}":"{{response.items[0]}}"}' },
      authorization: { type: "bearer", config: { token: "{{response.token}}" } },
      outputs: [{ name: "out", selector: "$inputs.response.items[0].id" }],
    },
  );
  const renamed = renameVariable([node], "h", "inputs", "response", "reply")[0]!;
  expect(renamed.data.config.url).toBe("https://example.com/{{reply.items[0].id}}");
  expect(renamed.data.config.authorization).toEqual({
    type: "bearer",
    config: { token: "{{reply.token}}" },
  });
  expect(JSON.parse((renamed.data.config.body as { data: string }).data)).toEqual({
    "{{response}}": "{{reply.items[0]}}",
  });
  expect(nodeOutputs(renamed.data)[0]?.selector).toBe("$inputs.reply.items[0].id");
  renamed.data.config.inputs = [{ name: "reply", source: { type: "literal", value: {} } }];
  const broken = {
    ...renamed,
    data: {
      ...renamed.data,
      config: {
        ...renamed.data.config,
        authorization: { type: "bearer", config: { token: "{{replly.token}}" } },
      },
    },
  };
  const repaired = repairVariableReference(
    [broken],
    {
      code: "template-reference",
      message: "",
      nodeId: "h",
      field: "authorization",
      reference: "replly.token",
    },
    "reply.token",
  );
  expect(repaired[0]!.data.config.authorization).toEqual({
    type: "bearer",
    config: { token: "{{reply.token}}" },
  });
});
