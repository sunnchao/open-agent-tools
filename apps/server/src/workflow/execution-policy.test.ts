import assert from "node:assert/strict";
import { it } from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { executeWorkflow, executeWorkflowNodeTest, type WorkflowEvent } from "./executor.js";

const tool = {
  id: "tool",
  kind: "mcp" as const,
  config: {
    serviceSlug: "fixture",
    toolName: "echo",
    arguments: "{}",
    retry: { maxRetries: 3, delayMs: 100 },
  },
};
it("retries transient tool failures, emits attempt counts, and shares policy with node tests", async () => {
  let calls = 0;
  const events: WorkflowEvent[] = [];
  await executeWorkflow({ nodes: [tool], edges: [], input: {} }, (event) => events.push(event), {
    callMcpTool: async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return { ok: true };
    },
  });
  assert.equal(calls, 2);
  assert.equal(events.find((event) => event.type === "node_result")?.metadata?.attempts, 2);
  const failed = await executeWorkflowNodeTest(
    { node: tool, inputs: {} },
    {
      callMcpTool: async () => {
        throw new Error("invalid argument");
      },
    },
  );
  assert.equal(failed.status, "error");
  assert.equal(failed.metadata.attempts, 1);
});
it("cancels during backoff without issuing another tool call", async () => {
  const controller = new AbortController();
  let calls = 0;
  const completion = executeWorkflow({ nodes: [tool], edges: [], input: {} }, () => {}, {
    signal: controller.signal,
    callMcpTool: async () => {
      calls++;
      setTimeout(() => controller.abort(), 20);
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(completion);
  assert.equal(calls, 1);
});
it("retries MCP SDK HTTP service failures without retrying client errors", async () => {
  for (const status of [503, 429, 401, 400]) {
    let calls = 0;
    const result = await executeWorkflowNodeTest(
      { node: tool, inputs: {} },
      {
        callMcpTool: async () => {
          if (++calls === 1) throw new StreamableHTTPError(status, "Service unavailable");
          return { ok: true };
        },
      },
    );
    const retryable = status === 503 || status === 429;
    assert.equal(calls, retryable ? 2 : 1, `HTTP ${status}`);
    assert.equal(result.status, retryable ? "success" : "error", `HTTP ${status}`);
    assert.equal(result.metadata.attempts, calls);
  }
});
it("uses configured timeouts and never retries LLM failures even when a retry policy was supplied", async () => {
  let calls = 0;
  const completion = executeWorkflowNodeTest(
    {
      node: {
        id: "llm",
        kind: "llm",
        config: { prompt: "test", timeoutMs: 1000, retry: { maxRetries: 3 } },
      },
      inputs: {},
    },
    {
      getDefaultProvider: () => ({ id: "fixture", models: ["fixture"] }) as never,
      completeLlm: async () => {
        calls++;
        return new Promise(() => {});
      },
      timeoutMs: { llm: 10000 },
    },
  );
  const result = await completion;
  assert.equal(result.status, "error");
  assert.match(result.error!, /1000ms/);
  assert.equal(calls, 1);
  assert.equal(result.metadata.attempts, 1);
});
it("applies a configured RAG timeout ahead of the node-kind default", async () => {
  const started = Date.now();
  const result = await executeWorkflowNodeTest(
    {
      node: {
        id: "rag",
        kind: "rag",
        config: { sources: ["source"], query: "q", timeoutMs: 1000 },
      },
      inputs: {},
    },
    {
      retrieveRag: async () => new Promise(() => {}),
      timeoutMs: { rag: 10000 },
    },
  );
  assert.equal(result.status, "error");
  assert.match(result.error!, /1000ms/);
  assert.ok(Date.now() - started < 2000);
});
