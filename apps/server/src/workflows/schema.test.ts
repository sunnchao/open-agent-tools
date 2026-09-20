import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveWorkflowSchemas, validatePublishedInputs } from "./schema.js";
import type { WorkflowGraph } from "./types.js";
describe("declared workflow API schemas", () => {
  const graph: WorkflowGraph = {
    name: "typed",
    nodes: [
      {
        id: "start",
        data: {
          kind: "start",
          config: {
            runVariables: [
              { name: "query", type: "string", required: true },
              { name: "limit", type: "number", required: true, defaultValue: 3 },
              { name: "enabled", type: "boolean", required: false },
            ],
          },
        },
      },
      {
        id: "end",
        data: {
          kind: "end",
          config: {
            inputs: [{ name: "q", source: { type: "run", variable: "qurey" } }],
            outputs: [{ name: "answer", selector: "$inputs.q" }],
          },
        },
      },
    ],
    edges: [{ source: "start", target: "end" }],
  };
  it("derives the public input schema from declarations, not consumer typos", () => {
    const { inputSchema } = deriveWorkflowSchemas(graph);
    assert.deepEqual(inputSchema.properties, {
      query: { type: "string" },
      limit: { type: "number", default: 3 },
      enabled: { type: "boolean" },
    });
    assert.deepEqual(inputSchema.required, ["query"]);
  });
  it("checks typed public inputs, defaults, unknown properties and optional values", () => {
    const { inputSchema } = deriveWorkflowSchemas(graph);
    assert.deepEqual(validatePublishedInputs(inputSchema, { query: "hello" }), []);
    assert.deepEqual(
      validatePublishedInputs(inputSchema, { query: "hello", limit: 0, enabled: false }),
      [],
    );
    assert.ok(
      validatePublishedInputs(inputSchema, { query: "hello", limit: "3" }).some((error) =>
        error.includes("number"),
      ),
    );
    assert.ok(
      validatePublishedInputs(inputSchema, { qurey: "hello" }).some((error) =>
        error.includes("not declared"),
      ),
    );
  });
  it("retains schema inference for older published snapshots", () => {
    const legacy = structuredClone(graph);
    delete legacy.nodes[0]!.data.config!.runVariables;
    assert.deepEqual(deriveWorkflowSchemas(legacy).inputSchema.required, ["qurey"]);
  });
});
