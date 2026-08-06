import { describe, expect, it } from "vitest";
import type { ResourceCatalog } from "../resources/api.js";
import {
  migrateNodeData,
  nodeInputs,
  nodeOutputs,
  validateNodeResources,
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
): WorkflowNodeData {
  return { kind, config, label: kind, description: "", status: "idle" };
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
});
