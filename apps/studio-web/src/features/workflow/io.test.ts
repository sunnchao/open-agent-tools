import { expect, it } from "vitest";
import { createEdge, createNode } from "./graph.js";
import { parseWorkflowFile, serializeWorkflow } from "./io.js";

const echo = () => ({
  name: "Echo",
  nodes: [
    createNode(
      "s",
      "start",
      { x: 0, y: 0 },
      { runVariables: [{ name: "query", type: "string", required: true }] },
    ),
    createNode("i", "input", { x: 280, y: 0 }),
    createNode(
      "e",
      "end",
      { x: 560, y: 0 },
      {
        inputs: [{ name: "query", source: { type: "node", nodeId: "i", output: "query" } }],
        outputs: [{ name: "result", selector: "$inputs.query" }],
      },
    ),
  ],
  edges: [createEdge("s", "i"), createEdge("i", "e")],
});
it("round trips definitions and variables without runtime or selection state", () => {
  const snapshot = echo();
  snapshot.nodes[1]!.data.status = "success";
  snapshot.nodes[1]!.selected = true;
  const text = serializeWorkflow(snapshot);
  const result = parseWorkflowFile(text, null);
  expect(result.name).toBe("Echo");
  expect(result.nodes[1]?.data.status).toBe("idle");
  expect(result.nodes[1]?.selected).toBeUndefined();
  expect(result.nodes[2]?.data.config).toEqual(snapshot.nodes[2]?.data.config);
  expect(result.edges.map((edge) => [edge.source, edge.target])).toEqual([
    ["s", "i"],
    ["i", "e"],
  ]);
});
it("rejects malformed, oversized, unknown-kind, dangling and credential-bearing files", () => {
  expect(() => parseWorkflowFile("{", null)).toThrow("合法 JSON");
  expect(() => parseWorkflowFile("x".repeat(2 * 1024 * 1024 + 1), null)).toThrow("2 MB");
  const value = JSON.parse(serializeWorkflow(echo()));
  value.graph.nodes[0].data.kind = "unknown";
  expect(() => parseWorkflowFile(JSON.stringify(value), null)).toThrow("kind");
  value.graph.nodes[0].data.kind = "start";
  value.graph.edges[0].source = "missing";
  expect(() => parseWorkflowFile(JSON.stringify(value), null)).toThrow("unknown node");
  const secret = echo();
  secret.nodes[0]!.data.config.apiKey = "sensitive";
  expect(() => serializeWorkflow(secret)).toThrow("凭据字段");
  const nested = JSON.parse(serializeWorkflow(echo()));
  nested.graph.nodes[1].data.config.arguments = '{"authorization":"Bearer secret"}';
  expect(() => parseWorkflowFile(JSON.stringify(nested), null)).toThrow("凭据字段");
});
it("rejects invalid references and unavailable RAG resources before creating a workflow", () => {
  const snapshot = echo();
  snapshot.nodes[1] = createNode(
    "i",
    "rag",
    { x: 280, y: 0 },
    {
      sources: ["missing.pdf"],
      query: "hi",
      outputs: [{ name: "query", selector: "$result.formatted" }],
    },
  );
  expect(() =>
    parseWorkflowFile(serializeWorkflow(snapshot), {
      rag: { sources: [] },
      mcp: { services: [], configured: false },
    } as never),
  ).toThrow("RAG 文档已失效");
});
