import { describe, expect, it } from "vitest";
import {
  effectiveNodeConfig,
  resultFields,
  selectorIssue,
  variableIssues,
} from "@open-agent-tools/workflow-contracts";
import { createEdge, createNode } from "./graph.js";
import { defaultConfig, validateNodeResources } from "./model.js";
import { outputOptions } from "./variables.js";
import { parseWorkflowFile, serializeWorkflow } from "./io.js";
import type { ResourceCatalog } from "../resources/api.js";

const catalog: ResourceCatalog = {
  mcp: { configured: false, services: [] },
  rag: { sources: [] },
  sql: { sources: [{ id: "ops", name: "运营库", connector: "mysql", isDefault: true }] },
};

describe("workflow SQL query node", () => {
  it("uses shared defaults and provides SQL, rows, counts, and audit outputs", () => {
    expect(defaultConfig("sql")).toEqual(effectiveNodeConfig("sql"));
    const node = createNode("q", "sql", { x: 0, y: 0 });
    expect(node.data.config.outputs).toEqual([
      { name: "rows", selector: "$result.rows" },
      { name: "sql", selector: "$result.sql" },
      { name: "rowCount", selector: "$result.rowCount" },
      { name: "auditId", selector: "$result.auditId" },
    ]);
    expect(outputOptions(node).map((option) => option.value)).toContain("$result.rowCount");
    expect(resultFields("sql")).toMatchObject({
      rows: "array",
      auditId: "string",
      rowCount: "number",
    });
    expect(selectorIssue({ id: "q", kind: "sql" }, "$result.rows")).toBeNull();
    expect(selectorIssue({ id: "q", kind: "sql" }, "$result.missing")).toMatch(/不存在字段/);
  });

  it("validates explicit and default data sources and detects missing templates", () => {
    const node = createNode("q", "sql", { x: 0, y: 0 }, { query: "最近 10 条订单" });
    expect(validateNodeResources(node.data, catalog)).toBeNull();
    expect(
      validateNodeResources(
        { ...node.data, config: { ...node.data.config, sourceId: "ops" } },
        catalog,
      ),
    ).toBeNull();
    expect(
      validateNodeResources(
        { ...node.data, config: { ...node.data.config, sourceId: "deleted" } },
        catalog,
      ),
    ).toMatch(/失效/);
    expect(validateNodeResources(node.data, null)).toMatch(/尚未加载/);
    expect(validateNodeResources(node.data, { ...catalog, sql: { sources: [] } })).toMatch(
      /默认 SQL 数据源/,
    );
    expect(validateNodeResources({ ...node.data, config: { query: " " } }, catalog)).toMatch(
      /请配置/,
    );
    expect(
      variableIssues([{ id: "q", kind: "sql", config: { query: "{{question}}" } }])[0]?.code,
    ).toBe("template-reference");
  });

  it("round trips SQL workflows without losing data source or variable bindings", () => {
    const snapshot = {
      name: "SQL 查询",
      nodes: [
        createNode(
          "s",
          "start",
          { x: 0, y: 0 },
          {
            runVariables: [{ name: "question", type: "string", required: true }],
          },
        ),
        createNode(
          "q",
          "sql",
          { x: 280, y: 0 },
          {
            sourceId: "ops",
            query: "{{question}}",
            maxRows: 20,
            inputs: [{ name: "question", source: { type: "run", variable: "question" } }],
          },
        ),
        createNode(
          "e",
          "end",
          { x: 560, y: 0 },
          {
            inputs: [{ name: "rows", source: { type: "node", nodeId: "q", output: "rows" } }],
            outputs: [{ name: "result", selector: "$inputs.rows" }],
          },
        ),
      ],
      edges: [createEdge("s", "q"), createEdge("q", "e")],
    };
    const restored = parseWorkflowFile(serializeWorkflow(snapshot), catalog);
    expect(restored.nodes[1]?.data.kind).toBe("sql");
    expect(restored.nodes[1]?.data.config).toEqual(snapshot.nodes[1]?.data.config);
    expect(() =>
      parseWorkflowFile(serializeWorkflow(snapshot), {
        ...catalog,
        sql: { sources: [] },
      }),
    ).toThrow(/SQL 数据源已失效/);
  });
});
