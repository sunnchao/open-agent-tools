import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  executeWorkflow,
  executeWorkflowNodeTest,
  validateWorkflow,
  type WorkflowRunRequest,
} from "./executor.js";

const base = (overrides: Partial<WorkflowRunRequest>): WorkflowRunRequest => ({
  nodes: [],
  edges: [],
  input: {},
  ...overrides,
});

describe("workflow executor", () => {
  it("rejects cycles and invalid predecessor output references", () => {
    assert.throws(
      () =>
        validateWorkflow(
          base({
            nodes: [
              { id: "a", kind: "start" },
              { id: "b", kind: "end" },
            ],
            edges: [
              { source: "a", target: "b" },
              { source: "b", target: "a" },
            ],
          }),
        ),
      /cycle/,
    );
    assert.throws(
      () =>
        validateWorkflow(
          base({
            nodes: [
              { id: "a", kind: "start", config: { outputs: [{ name: "x", selector: "$result" }] } },
              {
                id: "b",
                kind: "end",
                config: {
                  inputs: [
                    { name: "value", source: { type: "node", nodeId: "a", output: "missing" } },
                  ],
                },
              },
            ],
            edges: [{ source: "a", target: "b" }],
          }),
        ),
      /not declared/,
    );
  });

  it("passes multiple inputs and registers multiple outputs", async () => {
    const events: unknown[] = [];
    const result = await executeWorkflow(
      base({
        input: { question: "hello" },
        nodes: [
          { id: "start", kind: "start" },
          {
            id: "source",
            kind: "input",
            config: {
              inputs: [{ name: "question", source: { type: "run", variable: "question" } }],
              outputs: [
                { name: "text", selector: "$inputs.question" },
                { name: "count", selector: "$inputs.question" },
              ],
            },
          },
          {
            id: "end",
            kind: "end",
            config: {
              inputs: [
                { name: "text", source: { type: "node", nodeId: "source", output: "text" } },
                { name: "literal", source: { type: "literal", value: "ok" } },
              ],
              outputs: [{ name: "answer", selector: "$inputs.text" }],
            },
          },
        ],
        edges: [
          { source: "start", target: "source" },
          { source: "source", target: "end" },
        ],
      }),
      (event) => events.push(event),
    );
    assert.deepEqual(result, {
      start: {},
      source: { text: "hello", count: "hello" },
      end: { answer: "hello" },
    });
    assert.ok(
      events.some(
        (event) => JSON.stringify(event) === JSON.stringify({ type: "run_done", outputs: result }),
      ),
    );
  });

  it("tests an input node in isolation and exposes inputs, result, outputs, and metadata", async () => {
    const result = await executeWorkflowNodeTest({
      node: {
        id: "input",
        kind: "input",
        config: {
          inputs: [
            { name: "text", source: { type: "run", variable: "text" }, required: true },
            { name: "limit", source: { type: "literal", value: 3 } },
          ],
          outputs: [
            { name: "text", selector: "$result.text" },
            { name: "limit", selector: "$inputs.limit" },
          ],
        },
      },
      inputs: { text: "hello" },
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.inputs, { text: "hello", limit: 3 });
    assert.deepEqual(result.result, { text: "hello", limit: 3 });
    assert.deepEqual(result.outputs, { text: "hello", limit: 3 });
    assert.equal(result.metadata.nodeKind, "input");
    assert.equal(result.metadata.tokenUsage.totalTokens, 0);
    assert.ok(result.metadata.startedAt);
    assert.ok(result.metadata.finishedAt);
  });

  it("captures LLM token usage and returns runtime failures as test results", async () => {
    const provider = {
      id: "default",
      name: "test",
      baseUrl: "http://localhost",
      models: ["m"],
      enabled: true,
      isDefault: true,
      apiKeyMasked: null,
      apiKey: null,
      format: "openai-chat" as const,
      createdAt: "",
      updatedAt: "",
    };
    const llm = await executeWorkflowNodeTest(
      {
        node: {
          id: "llm",
          kind: "llm",
          config: {
            model: "m",
            prompt: "say {{topic}}",
            inputs: [{ name: "topic", source: { type: "run", variable: "topic" } }],
            outputs: [{ name: "answer", selector: "$result" }],
          },
        },
        inputs: { topic: "hello" },
      },
      {
        getDefaultProvider: () => provider,
        completeLlm: async () => ({
          content: "world",
          tokenUsage: { inputTokens: 5, outputTokens: 2 },
        }),
      },
    );
    assert.deepEqual(llm.outputs, { answer: "world" });
    assert.deepEqual(llm.metadata.tokenUsage, {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });

    const failed = await executeWorkflowNodeTest({
      node: {
        id: "end",
        kind: "end",
        config: {
          inputs: [{ name: "answer", source: { type: "run", variable: "answer" } }],
        },
      },
      inputs: {},
    });
    assert.equal(failed.status, "error");
    assert.match(failed.error ?? "", /required input answer/);
    assert.deepEqual(failed.inputs, { answer: undefined });
    assert.deepEqual(failed.outputs, {});
  });

  it("runs only the selected condition branch and supports joins", async () => {
    let completeCalls = 0;
    const result = await executeWorkflow(
      base({
        input: {},
        nodes: [
          { id: "start", kind: "start" },
          { id: "condition", kind: "condition", config: { expression: "true" } },
          {
            id: "yes",
            kind: "llm",
            config: { prompt: "yes", outputs: [{ name: "answer", selector: "$result" }] },
          },
          {
            id: "no",
            kind: "llm",
            config: { prompt: "no", outputs: [{ name: "answer", selector: "$result" }] },
          },
          {
            id: "end",
            kind: "end",
            config: {
              inputs: [
                { name: "answer", source: { type: "node", nodeId: "yes", output: "answer" } },
              ],
            },
          },
        ],
        edges: [
          { source: "start", target: "condition" },
          { source: "condition", target: "yes", label: "true" },
          { source: "condition", target: "no", label: "false" },
          { source: "yes", target: "end" },
          { source: "no", target: "end" },
        ],
      }),
      () => undefined,
      {
        completeLlm: async () => {
          completeCalls += 1;
          return "yes";
        },
        getDefaultProvider: () => ({
          id: "default",
          name: "test",
          baseUrl: "http://localhost",
          models: ["m"],
          enabled: true,
          isDefault: true,
          apiKeyMasked: null,
          apiKey: null,
          format: "openai-chat" as const,
          createdAt: "",
          updatedAt: "",
        }),
      },
    );
    assert.equal(completeCalls, 1);
    assert.deepEqual(result.yes, { answer: "yes" });
    assert.equal(result.no, undefined);
  });

  it("aborts on node errors", async () => {
    const events: Array<{ type: string; nodeId?: string }> = [];
    await assert.rejects(
      executeWorkflow(
        base({
          nodes: [
            { id: "start", kind: "start" },
            { id: "rag", kind: "rag", config: { sources: ["x"], query: "q" } },
          ],
          edges: [{ source: "start", target: "rag" }],
        }),
        (event) => events.push(event),
        {
          retrieveRag: async () => {
            throw new Error("RAG down");
          },
        },
      ),
      /RAG down/,
    );
    assert.ok(events.some((event) => event.type === "node_result" && event.nodeId === "rag"));
  });

  it("interpolates typed MCP arguments without corrupting JSON", async () => {
    let received: Record<string, unknown> | undefined;
    await executeWorkflow(
      base({
        input: { query: "hello", limit: 3 },
        nodes: [
          {
            id: "tool",
            kind: "mcp",
            config: {
              serviceSlug: "docs",
              toolName: "search",
              inputs: [
                { name: "query", source: { type: "run", variable: "query" } },
                { name: "limit", source: { type: "run", variable: "limit" } },
              ],
              arguments: '{"query":"{{query}}","limit":"{{limit}}","label":"q={{query}}"}',
            },
          },
        ],
        edges: [],
      }),
      () => undefined,
      {
        callMcpTool: async (_binding, args) => {
          received = args;
          return { ok: true };
        },
      },
    );
    assert.deepEqual(received, { query: "hello", limit: 3, label: "q=hello" });
  });

  it("times out a slow node and stops the run", async () => {
    await assert.rejects(
      executeWorkflow(
        base({
          nodes: [{ id: "rag", kind: "rag", config: { sources: ["x"], query: "q" } }],
          edges: [],
        }),
        () => undefined,
        {
          retrieveRag: async () => new Promise(() => undefined),
          timeoutMs: { rag: 5 },
        },
      ),
      /timed out/,
    );
  });
});
