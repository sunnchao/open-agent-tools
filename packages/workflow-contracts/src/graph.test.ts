import assert from "node:assert/strict";
import { it } from "node:test";
import { effectiveNodeConfig, nodeKindSchema, nodeConfigSchemas, workflowGraphSchema } from "./graph.js";

it("provides one kind/config contract and enforces execution bounds", () => {
  assert.equal(nodeKindSchema.options.length, 10);
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
it("types graph document scopes while allowing an unconfigured draft", () => {
  assert.equal(nodeConfigSchemas.graph.safeParse({ query: "query" }).success, true);
  assert.deepEqual(effectiveNodeConfig("graph").sources, []);
  assert.equal(nodeConfigSchemas.graph.safeParse({ sources: ["guide.md"] }).success, true);
  for (const sources of ["guide.md", [42], [""], [" "]]) {
    assert.equal(nodeConfigSchemas.graph.safeParse({ sources }).success, false);
  }
});
it("validates SQL query nodes and their result limits", () => {
  assert.equal(
    nodeConfigSchemas.sql.safeParse({
      sourceId: "ops",
      query: "{{question}}",
      maxRows: 20,
      timeoutMs: 60000,
    }).success,
    true,
  );
  for (const maxRows of [0, 101, 1.5, "10"]) {
    assert.equal(nodeConfigSchemas.sql.safeParse({ maxRows }).success, false);
  }
  assert.equal(
    workflowGraphSchema.safeParse({
      name: "SQL workflow",
      nodes: [
        { id: "sql", data: { id: "sql", kind: "sql", config: { query: "查询前 10 个用户" } } },
      ],
      edges: [],
    }).success,
    true,
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
