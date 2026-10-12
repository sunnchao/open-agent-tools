import { expect, it } from "vitest";
import { createEdge, createNode } from "./graph.js";
import { parseWorkflowFile, serializeWorkflow } from "./io.js";
import { validateWorkflowGraph } from "./model.js";

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

it("strips fixed HTTP authentication and literal credential bindings on export and import while keeping an editable draft", () => {
  for (const authorization of [
    { type: "bearer", config: { token: "private-bearer" } },
    { type: "basic", config: { username: "demo", password: "private-password" } },
    { type: "custom", config: { header: "X-Demo", value: "{{credential}}" } },
  ]) {
    const snapshot = echo();
    snapshot.nodes[1] = createNode(
      "i",
      "http",
      { x: 280, y: 0 },
      {
        url: "https://example.com",
        authorization,
        inputs: [{ name: "credential", source: { type: "literal", value: "private-literal" } }],
        headers: "Authorization:Bearer private-header\nAccept:application/json",
        outputs: [{ name: "query", selector: "$result.body" }],
      },
    );
    const text = serializeWorkflow(snapshot);
    expect(text).not.toContain("private-bearer");
    expect(text).not.toContain("private-password");
    expect(text).not.toContain("private-header");
    if (authorization.type === "custom") expect(text).not.toContain("private-literal");
    expect(snapshot.nodes[1].data.config.authorization).toEqual(authorization);
    const imported = parseWorkflowFile(text, null);
    expect(validateWorkflowGraph(imported.nodes, imported.edges, null)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "http-auth" })]),
    );
    const unsanitized = JSON.parse(text);
    unsanitized.graph.nodes[1].data.config.authorization = {
      type: "bearer",
      config: { token: "private-incoming" },
    };
    expect(JSON.stringify(parseWorkflowFile(JSON.stringify(unsanitized), null))).not.toContain(
      "private-incoming",
    );
  }
});

it("removes entry defaults used as HTTP credentials even when the entry variable has an ordinary name", () => {
  const snapshot = echo();
  snapshot.nodes[0]!.data.config.runVariables = [
    { name: "query", type: "string", required: true, defaultValue: "private-entry-default" },
  ];
  snapshot.nodes[1] = createNode(
    "i",
    "http",
    { x: 280, y: 0 },
    {
      url: "https://example.com",
      inputs: [{ name: "credential", source: { type: "run", variable: "query" } }],
      authorization: { type: "bearer", config: { token: "{{credential}}" } },
      outputs: [{ name: "query", selector: "$result.body" }],
    },
  );
  const text = serializeWorkflow(snapshot);
  expect(text).not.toContain("private-entry-default");
  const imported = parseWorkflowFile(text, null);
  expect(imported.nodes[0]!.data.config.runVariables).toEqual([
    { name: "query", type: "string", required: true },
  ]);
  expect(snapshot.nodes[0]!.data.config.runVariables).toEqual([
    { name: "query", type: "string", required: true, defaultValue: "private-entry-default" },
  ]);
});
