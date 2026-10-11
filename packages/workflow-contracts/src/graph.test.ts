import assert from "node:assert/strict";
import { it } from "node:test";
import { nodeKindSchema, nodeConfigSchemas, workflowGraphSchema } from "./graph.js";

it("provides one kind/config contract and enforces execution bounds", () => {
  assert.equal(nodeKindSchema.options.length, 8);
  assert.equal(nodeKindSchema.safeParse("unknown").success, false);
  assert.equal(nodeConfigSchemas.llm.safeParse({ timeoutMs: 999 }).success, false);
  assert.equal(nodeConfigSchemas.mcp.safeParse({ retry: { maxRetries: 4 } }).success, false);
  assert.equal(nodeConfigSchemas.rag.safeParse({ sources: "x" }).success, false);
  assert.equal(
    nodeConfigSchemas.mcp.safeParse({ timeoutMs: 3000, retry: { maxRetries: 3, delayMs: 100 } })
      .success,
    true,
  );
  assert.equal(
    (nodeConfigSchemas.mcp.parse({ service: "legacy" }) as { service?: string }).service,
    "legacy",
  );
});
it("rejects unknown kinds and inconsistent node identities when saving a draft", () => {
  const graph = {
    name: "draft",
    nodes: [{ id: "a", data: { id: "a", kind: "start", config: {} } }],
    edges: [],
  };
  assert.equal(workflowGraphSchema.safeParse(graph).success, true);
  assert.equal(
    workflowGraphSchema.safeParse({ ...graph, nodes: [{ id: "a", data: { kind: "unknown" } }] })
      .success,
    false,
  );
  assert.equal(
    workflowGraphSchema.safeParse({
      ...graph,
      nodes: [{ id: "a", data: { id: "b", kind: "start" } }],
    }).success,
    false,
  );
  assert.equal(
    workflowGraphSchema.safeParse({ ...graph, nodes: [...graph.nodes, ...graph.nodes] }).success,
    false,
  );
});
