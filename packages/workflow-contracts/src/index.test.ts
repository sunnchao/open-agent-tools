import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasRunDeclarations,
  runVariables,
  variableIssues,
  prepareRunInputs,
  selectorIssue,
  similarVariableNames,
  type VariableNode,
} from "./index.js";
const start: VariableNode = {
  id: "start",
  kind: "start",
  config: { runVariables: [{ name: "query", type: "string", required: true }] },
};
const input: VariableNode = {
  id: "input",
  kind: "input",
  config: {
    inputs: [{ name: "query", source: { type: "run", variable: "query" } }],
    outputs: [{ name: "query", selector: "$inputs.query" }],
  },
};
describe("workflow variable contracts", () => {
  it("infers legacy names once but treats an explicit empty list as authoritative", () => {
    assert.equal(hasRunDeclarations([input]), false);
    assert.deepEqual(runVariables([input]), [{ name: "query", type: "any", required: true }]);
    assert.deepEqual(runVariables([{ ...start, config: { runVariables: [] } }, input]), []);
    assert.deepEqual(
      variableIssues([{ ...start, config: { runVariables: [] } }, input]).find(
        (issue) => issue.code === "run-reference",
      ),
      {
        code: "run-reference",
        message: "入口变量 query 未声明，请在开始节点创建后选择",
        nodeId: "input",
        reference: "query",
      },
    );
  });
  it("rejects misspelled entry references without declaring new parameters", () => {
    const typo = {
      ...input,
      config: { inputs: [{ name: "query", source: { type: "run", variable: "qurey" } }] },
    };
    assert.deepEqual(
      runVariables([start, typo]).map((variable) => variable.name),
      ["query"],
    );
    assert.deepEqual(
      variableIssues([start, typo]).find((issue) => issue.code === "run-reference"),
      {
        code: "run-reference",
        message: "入口变量 qurey 未声明，请在开始节点创建后选择",
        nodeId: "input",
        suggestions: ["query"],
        reference: "qurey",
      },
    );
  });
  it("validates references in every template context, including nested MCP values", () => {
    for (const [kind, field, text] of [
      ["llm", "systemPrompt", "{{qurey}}"],
      ["llm", "prompt", "{{missing}}"],
      ["rag", "query", "{{missing}}"],
      ["condition", "expression", "{{missing}} > 0"],
      ["mcp", "arguments", '{"a":[{"b":"{{missing}}"}]}'],
    ]) {
      const issues = variableIssues([
        start,
        { ...input, kind: kind!, config: { ...input.config, [field!]: text } },
      ]);
      assert.ok(
        issues.some((issue) => issue.code === "template-reference"),
        `${kind}.${field}`,
      );
    }
    assert.deepEqual(
      variableIssues([
        start,
        { ...input, kind: "llm", config: { ...input.config, prompt: "{{qurey}}" } },
      ]).find((issue) => issue.code === "template-reference"),
      {
        code: "template-reference",
        message: "prompt 引用了未绑定变量 qurey；可修复为 query",
        nodeId: "input",
        suggestions: ["query"],
        reference: "qurey",
        field: "prompt",
      },
    );
  });
  it("validates names, duplicates and typed defaults, including malformed declarations", () => {
    const issues = variableIssues([
      {
        ...start,
        config: {
          runVariables: [
            null,
            { name: "bad-name", type: "string" },
            { name: "query", type: "number", defaultValue: "3" },
            { name: "query", type: "string" },
          ],
        },
      },
    ]);
    assert.ok(issues.some((issue) => issue.code === "run-default"));
    assert.ok(issues.filter((issue) => issue.code === "run-declaration").length >= 3);
  });
  it("validates known selectors without rejecting unknown dynamic fields", () => {
    assert.match(selectorIssue(input, "$inputs.qurey")!, /未声明/);
    assert.match(selectorIssue(input, "$result.qurey")!, /未声明/);
    // 图谱能力已并入知识检索节点：图谱相关输出仍按 rag 节点的结果签名校验。
    assert.match(selectorIssue({ id: "g", kind: "rag" }, "$result.formated")!, /不存在/);
    assert.match(
      selectorIssue({ id: "g", kind: "rag" }, "$result.formatted.text")!,
      /没有子字段/,
    );
    assert.ok(selectorIssue({ id: "l", kind: "llm" }, "$result.text"));
    assert.equal(selectorIssue({ id: "m", kind: "mcp" }, "$result.dynamic.value"), null);
    assert.ok(selectorIssue({ id: "m", kind: "mcp" }, "$result.__proto__"));
  });
  it("applies defaults only to missing values and preserves falsy typed inputs", () => {
    const variables = [
      { name: "limit", type: "number" as const, defaultValue: 5 },
      { name: "active", type: "boolean" as const, defaultValue: true },
      { name: "optional", type: "string" as const, required: false },
    ];
    assert.deepEqual(prepareRunInputs(variables, {}).input, { limit: 5, active: true });
    assert.deepEqual(prepareRunInputs(variables, { limit: 0, active: false }), {
      input: { limit: 0, active: false },
      errors: [],
    });
    assert.equal(prepareRunInputs(variables, { limit: "5" }).errors.length, 1);
    assert.equal(
      prepareRunInputs([{ name: "config", type: "object" }], { config: [] }).errors.length,
      1,
    );
    assert.equal(
      prepareRunInputs([{ name: "config", type: "object" }], { config: null }).errors.length,
      1,
    );
  });
  it("suggests common typos without conflating declarations", () => {
    assert.deepEqual(similarVariableNames("qurey", ["query", "count"]), ["query"]);
    assert.deepEqual(similarVariableNames("Query", ["query", "Query"]), ["query"]);
  });
});
