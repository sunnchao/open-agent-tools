import { describe, expect, it } from "vitest";
import type { ResourceCatalog } from "../resources/api.js";
import {
  migrateNodeData,
  nodeInputs,
  nodeOutputs,
  validateNodeResources,
  validateWorkflowGraph,
  type WorkflowNodeData,
} from "./model.js";

const catalog: ResourceCatalog = {
  mcp: {
    configured: true,
    services: [
      {
        serviceSlug: "docs",
        serviceStatus: "ACTIVE",
        versionStatus: "PUBLISHED",
        tools: [{ serviceSlug: "docs", name: "search", inputSchema: { type: "object" } }],
      },
    ],
  },
  rag: { sources: [{ source: "guide.md", chunks: 4 }] },
};

function data(
  kind: WorkflowNodeData["kind"],
  config: WorkflowNodeData["config"],
  id = "test-1",
): WorkflowNodeData {
  return { id, kind, config, label: kind, description: "", status: "idle" };
}

describe("workflow resource model", () => {
  it("migrates legacy RAG and MCP config keys", () => {
    expect(
      migrateNodeData(data("rag", { knowledgeBase: "guide.md", topK: 3 })).config,
    ).toMatchObject({
      sources: ["guide.md"],
      topK: 3,
      inputs: [],
      outputs: [],
    });
    expect(
      migrateNodeData(data("mcp", { service: "docs", tool: "search", arguments: "{}" })).config,
    ).toMatchObject({
      serviceSlug: "docs",
      toolName: "search",
      arguments: "{}",
      inputs: [],
      outputs: [],
    });
  });

  it("migrates legacy output and preserves multiple variable bindings", () => {
    const migrated = migrateNodeData(
      data("llm", {
        model: "legacy-model",
        output: "answer",
        inputs: [{ name: "context", source: { type: "run", variable: "context" } }],
        outputs: [
          { name: "answer", selector: "$result" },
          { name: "raw", selector: "$inputs.context" },
        ],
      }),
    );
    expect(migrated.config.providerId).toBe("default");
    expect(nodeInputs(migrated)).toHaveLength(1);
    expect(nodeOutputs(migrated)).toHaveLength(2);
  });

  it("migrates legacy llm prompt into systemPrompt and keeps prompt empty", () => {
    const migrated = migrateNodeData(
      data("llm", {
        providerId: "p1",
        model: "m",
        prompt: "旧版系统提示词",
        inputs: [],
        outputs: [],
      }),
    );
    expect(migrated.config.systemPrompt).toBe("旧版系统提示词");
    expect(migrated.config.prompt).toBe("");
  });

  it("keeps explicit systemPrompt and prompt pair unchanged", () => {
    const migrated = migrateNodeData(
      data("llm", {
        providerId: "p1",
        model: "m",
        systemPrompt: "角色设定",
        prompt: "用户消息模板",
        inputs: [],
        outputs: [],
      }),
    );
    expect(migrated.config.systemPrompt).toBe("角色设定");
    expect(migrated.config.prompt).toBe("用户消息模板");
  });

  it("backs up node id into data, preferring the existing data id", () => {
    const legacy = data("rag", { knowledgeBase: "guide.md" });
    delete (legacy as { id?: string }).id;
    expect(migrateNodeData(legacy, "rag-1").id).toBe("rag-1");
    expect(migrateNodeData(data("llm", {}, "llm-2"), "rag-1").id).toBe("llm-2");
    expect(migrateNodeData(legacy).id).toBe("");
  });

  it("validates current resource identity and MCP arguments", () => {
    expect(validateNodeResources(data("rag", { sources: [], topK: 5 }), catalog)).toMatch(/至少/);
    expect(validateNodeResources(data("rag", { sources: ["missing.md"] }), catalog)).toMatch(
      /失效/,
    );
    expect(
      validateNodeResources(
        data("mcp", { serviceSlug: "docs", toolName: "search", arguments: "{" }),
        catalog,
      ),
    ).toMatch(/合法 JSON/);
    expect(
      validateNodeResources(
        data("mcp", { serviceSlug: "docs", toolName: "search", arguments: "{}" }),
        catalog,
      ),
    ).toBeNull();
  });

  it("validates a connected workflow and reports structural issues", () => {
    const start = data("start", { inputs: [], outputs: [] }, "start-1");
    const end = data(
      "end",
      {
        inputs: [{ name: "answer", source: { type: "node", nodeId: "llm-1", output: "answer" } }],
        outputs: [{ name: "answer", selector: "$inputs.answer" }],
      },
      "end-1",
    );
    const llm = data(
      "llm",
      {
        prompt: "hello",
        inputs: [],
        outputs: [{ name: "answer", selector: "$result" }],
      },
      "llm-1",
    );
    const nodes = [start, llm, end].map((node) => ({ id: node.id, data: node }));
    const edges = [
      { source: "start-1", target: "llm-1" },
      { source: "llm-1", target: "end-1" },
    ];

    expect(validateWorkflowGraph(nodes, edges, catalog)).toEqual([]);
    expect(
      validateWorkflowGraph(nodes, [...edges, { source: "end-1", target: "llm-1" }], catalog),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "cycle" })]));
    expect(validateWorkflowGraph(nodes.slice(0, 2), edges.slice(0, 1), catalog)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "end-count" })]),
    );
  });

  it("reports invalid variable bindings and condition routes", () => {
    const start = data("start", { inputs: [], outputs: [] }, "start-1");
    const condition = data(
      "condition",
      {
        inputs: [
          { name: "value", source: { type: "node", nodeId: "start-1", output: "missing" } },
          { name: "value", source: { type: "run", variable: "" } },
        ],
        outputs: [{ name: "result", selector: "result" }],
      },
      "condition-1",
    );
    const end = data(
      "end",
      { inputs: [], outputs: [{ name: "answer", selector: "$inputs.answer" }] },
      "end-1",
    );
    const nodes = [start, condition, end].map((node) => ({ id: node.id, data: node }));
    const issues = validateWorkflowGraph(
      nodes,
      [
        { source: "start-1", target: "condition-1" },
        { source: "condition-1", target: "end-1", label: "true" },
      ],
      catalog,
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "input-duplicate" }),
        expect.objectContaining({ code: "run-variable" }),
        expect.objectContaining({ code: "node-output" }),
        expect.objectContaining({ code: "output-selector" }),
        expect.objectContaining({ code: "condition-routes" }),
      ]),
    );
  });
});
