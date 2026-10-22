import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  executeWorkflow,
  executeWorkflowNodeTest,
  normalizeGraphHops,
  validateWorkflow,
  type WorkflowEvent,
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
        (event) =>
          JSON.stringify(event) ===
          JSON.stringify({ type: "run_done", outputs: { answer: "hello" }, nodeOutputs: result }),
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event &&
          typeof event === "object" &&
          (event as { type: string }).type === "node_start" &&
          (event as { nodeId: string }).nodeId === "source" &&
          (event as { kind: string }).kind === "input",
      ),
    );
    const endResult = events.find(
      (event) =>
        event &&
        typeof event === "object" &&
        (event as { type: string }).type === "node_result" &&
        (event as { nodeId: string }).nodeId === "end",
    ) as
      | {
          inputs?: Record<string, unknown>;
          outputs?: Record<string, unknown>;
          result?: unknown;
          metadata?: { durationMs: number; tokenUsage: { totalTokens: number } };
        }
      | undefined;
    assert.ok(endResult);
    assert.deepEqual(endResult.inputs, { text: "hello", literal: "ok" });
    assert.deepEqual(endResult.outputs, { answer: "hello" });
    assert.deepEqual(endResult.result, { text: "hello", literal: "ok" });
    assert.ok(endResult.metadata && endResult.metadata.durationMs >= 0);
    assert.deepEqual(endResult.metadata.tokenUsage, {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
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
    const starts: Array<{ nodeId?: string; incomingEdgeIds?: string[] }> = [];
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
      (event) => {
        if (event.type === "node_start") starts.push(event);
      },
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
    assert.deepEqual(starts.find((event) => event.nodeId === "end")?.incomingEdgeIds, [
      "yes-end-3",
    ]);
    assert.equal(
      starts.some((event) => event.nodeId === "no"),
      false,
    );
  });

  it("rejects unknown node kinds and out-of-range execution policy at validation time", () => {
    assert.throws(
      () =>
        validateWorkflow(
          base({
            nodes: [{ id: "x", kind: "unknown" as never }],
            edges: [],
          }),
        ),
      /invalid node kind/,
    );
    assert.throws(
      () =>
        validateWorkflow(
          base({
            nodes: [{ id: "x", kind: "mcp", config: { retry: { maxRetries: 4 } } }],
            edges: [],
          }),
        ),
      /maxRetries/,
    );
  });

  it("emits the interpolated prompt on llm node result events", async () => {
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
    const events: Array<Record<string, unknown>> = [];
    let receivedPrompt: string | undefined;
    let receivedSystemPrompt: string | undefined;
    await executeWorkflow(
      base({
        input: { question: "如何优化 LLM 调用" },
        nodes: [
          {
            id: "user",
            kind: "input",
            config: {
              inputs: [{ name: "question", source: { type: "run", variable: "question" } }],
              outputs: [{ name: "text", selector: "$inputs.question" }],
            },
          },
          {
            id: "llm",
            kind: "llm",
            config: {
              model: "m",
              systemPrompt: "你是助手，请使用 {{lang}} 回答",
              prompt: "请回答：{{q}}",
              inputs: [
                { name: "q", source: { type: "node", nodeId: "user", output: "text" } },
                { name: "lang", source: { type: "literal", value: "中文" } },
              ],
              outputs: [{ name: "answer", selector: "$result" }],
            },
          },
        ],
        edges: [{ source: "user", target: "llm" }],
      }),
      (event) => events.push(event as unknown as Record<string, unknown>),
      {
        getDefaultProvider: () => provider,
        completeLlm: async (_provider, input) => {
          receivedPrompt = input.prompt;
          receivedSystemPrompt = input.systemPrompt;
          return "好的";
        },
      },
    );
    assert.equal(receivedSystemPrompt, "你是助手，请使用 中文 回答");
    assert.equal(receivedPrompt, "请回答：如何优化 LLM 调用");
    const llmEvent = events.find((event) => event.type === "node_result" && event.nodeId === "llm");
    assert.ok(llmEvent);
    assert.equal(llmEvent.status, "success");
    assert.equal(llmEvent.systemPrompt, "你是助手，请使用 中文 回答");
    assert.equal(llmEvent.prompt, "请回答：如何优化 LLM 调用");
    assert.deepEqual(llmEvent.inputs, { q: "如何优化 LLM 调用", lang: "中文" });
    assert.deepEqual(llmEvent.outputs, { answer: "好的" });
    assert.ok(llmEvent.metadata);
  });

  it("auto-joins input variables as the user message when no prompt template is set", async () => {
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
    const events: Array<Record<string, unknown>> = [];
    let receivedPrompt: string | undefined;
    let receivedSystemPrompt: string | undefined;
    await executeWorkflow(
      base({
        input: { question: "如何优化 LLM 调用" },
        nodes: [
          {
            id: "user",
            kind: "input",
            config: {
              inputs: [{ name: "question", source: { type: "run", variable: "question" } }],
              outputs: [{ name: "text", selector: "$inputs.question" }],
            },
          },
          {
            id: "llm",
            kind: "llm",
            config: {
              model: "m",
              systemPrompt: "你是严格的翻译助手",
              inputs: [{ name: "q", source: { type: "node", nodeId: "user", output: "text" } }],
              outputs: [{ name: "answer", selector: "$result" }],
            },
          },
        ],
        edges: [{ source: "user", target: "llm" }],
      }),
      (event) => events.push(event as unknown as Record<string, unknown>),
      {
        getDefaultProvider: () => provider,
        completeLlm: async (_provider, input) => {
          receivedPrompt = input.prompt;
          receivedSystemPrompt = input.systemPrompt;
          return "翻译结果";
        },
      },
    );
    // prompt 未配置时，上游入参数据自动拼接为 user 消息，不再被系统提示词覆盖。
    assert.equal(receivedSystemPrompt, "你是严格的翻译助手");
    assert.equal(receivedPrompt, "q:\n如何优化 LLM 调用");
    const llmEvent = events.find((event) => event.type === "node_result" && event.nodeId === "llm");
    assert.ok(llmEvent);
    assert.equal(llmEvent.systemPrompt, "你是严格的翻译助手");
    assert.equal(llmEvent.prompt, "q:\n如何优化 LLM 调用");
    assert.deepEqual(llmEvent.inputs, { q: "如何优化 LLM 调用" });
    assert.deepEqual(llmEvent.outputs, { answer: "翻译结果" });
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

  it("migrates a legacy graph node to a rag node and runs it through retrieveRag", async () => {
    let ragCalls = 0;
    let graphCalls = 0;
    let received:
      { query: string; sources: string[]; graph?: boolean; graphHops?: number } | undefined;
    const outputs = await executeWorkflow(
      base({
        input: { query: "OpenAI" },
        nodes: [
          {
            id: "graph",
            kind: "graph" as never,
            config: {
              sources: ["guide.md"],
              query: "{{query}} 供应商",
              inputs: [{ name: "query", source: { type: "run", variable: "query" } }],
              outputs: [{ name: "formatted", selector: "$result.formatted" }],
            },
          },
        ],
        edges: [],
      }),
      () => undefined,
      {
        retrieveRag: async (input) => {
          ragCalls += 1;
          received = input;
          return {
            chunks: [],
            formatted: `图谱结果: ${input.query}`,
            graph: { enabled: true, context: "OpenAI -> GPT-4", entities: 2, relations: 1 },
          };
        },
        retrieveRagGraph: async () => {
          graphCalls += 1;
          return { formatted: "", seeds: [] };
        },
      },
    );
    const nodeOutput = (outputs as Record<string, Record<string, unknown>>).graph;
    assert.ok(nodeOutput);
    assert.equal(nodeOutput.formatted, "图谱结果: OpenAI 供应商");
    assert.equal(ragCalls, 1, "旧 graph 节点迁移后必须走 retrieveRag");
    assert.equal(graphCalls, 0, "executor 不应再调用 retrieveRagGraph");
    assert.equal(received?.graph, true, "迁移后的节点保持图谱增强开启");
    assert.equal(received?.graphHops, 2);
    assert.deepEqual(received?.sources, ["guide.md"]);
  });

  it("validateWorkflow migrates legacy graph nodes before kind validation", () => {
    const validation = validateWorkflow(
      base({
        nodes: [
          {
            id: "graph",
            kind: "graph" as never,
            label: "图谱检索",
            config: { query: "topic", sources: ["guide.md"] },
          },
        ],
        edges: [],
      }),
    );
    assert.equal(validation.nodes[0]!.kind, "rag");
    // 默认旧名统一改为「知识检索」，避免画布上继续显示已删除的节点类型名。
    assert.equal(validation.nodes[0]!.label, "知识检索");
  });

  it("migrates legacy graph nodes in isolated node tests too", async () => {
    let received: Record<string, unknown> | undefined;
    const result = await executeWorkflowNodeTest(
      {
        node: {
          id: "legacy-graph",
          kind: "graph" as never,
          config: { query: "topic", sources: ["guide.md"] },
        },
        inputs: {},
      },
      {
        retrieveRag: async (input) => {
          received = input as unknown as Record<string, unknown>;
          return { chunks: [], formatted: "ok", graph: { context: "A -> B" } };
        },
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.metadata.nodeKind, "rag");
    assert.equal(received?.graph, true);
  });

  it("passes graph:true by default for rag nodes", async () => {
    let received: Record<string, unknown> | undefined;
    await executeWorkflow(
      base({
        nodes: [{ id: "rag", kind: "rag", config: { sources: ["guide.md"], query: "q" } }],
        edges: [],
      }),
      () => undefined,
      {
        retrieveRag: async (input) => {
          received = input as unknown as Record<string, unknown>;
          return { chunks: [], formatted: "" };
        },
      },
    );
    assert.equal(received?.graph, true);
    assert.equal(received?.graphHops, 2);
  });

  it("passes graph:false when the rag node disables graph augmentation", async () => {
    let received: Record<string, unknown> | undefined;
    await executeWorkflow(
      base({
        nodes: [
          {
            id: "rag",
            kind: "rag",
            config: { sources: ["guide.md"], query: "q", graph: false, graphHops: 3 },
          },
        ],
        edges: [],
      }),
      () => undefined,
      {
        retrieveRag: async (input) => {
          received = input as unknown as Record<string, unknown>;
          return { chunks: [], formatted: "" };
        },
      },
    );
    assert.equal(received?.graph, false);
    assert.equal(received?.graphHops, 3);
  });

  it("passes graphHops through and clamps out-of-contract values defensively", async () => {
    const seen: unknown[] = [];
    for (const graphHops of [1, 2, 4]) {
      await executeWorkflow(
        base({
          nodes: [
            { id: "rag", kind: "rag", config: { sources: ["guide.md"], query: "q", graphHops } },
          ],
          edges: [],
        }),
        () => undefined,
        {
          retrieveRag: async (input) => {
            seen.push(input.graphHops);
            return { chunks: [], formatted: "" };
          },
        },
      );
    }
    assert.deepEqual(seen, [1, 2, 4]);
    // 合法值原样透传；非常规来源的越界/非整数值在 runNode 侧兜底收敛。
    assert.equal(normalizeGraphHops(0), 1);
    assert.equal(normalizeGraphHops(9), 4);
    assert.equal(normalizeGraphHops(2.7), 2);
    assert.equal(normalizeGraphHops("3"), 3);
    assert.equal(normalizeGraphHops(undefined), 2);
    assert.equal(normalizeGraphHops(null), 2);
    assert.equal(normalizeGraphHops(""), 2);
    assert.equal(normalizeGraphHops("abc"), 2);
  });

  it("returns graph context from retrieveRag on the rag node result", async () => {
    const events: WorkflowEvent[] = [];
    await executeWorkflow(
      base({
        nodes: [
          {
            id: "rag",
            kind: "rag",
            config: {
              sources: ["guide.md"],
              query: "q",
              outputs: [
                { name: "formatted", selector: "$result.formatted" },
                { name: "graph", selector: "$result.graph" },
              ],
            },
          },
        ],
        edges: [],
      }),
      (event) => events.push(event),
      {
        retrieveRag: async () => ({
          queryId: "q1",
          chunks: [{ source: "guide.md", chunkIndex: 0, content: "x" }],
          formatted: "x",
          graph: { enabled: true, context: "A -> B", entities: 2, relations: 1, chunkHits: 1 },
          retrieval: { graphEnabled: true },
        }),
      },
    );
    const result = events.find((event) => event.type === "node_result");
    assert.equal(result?.nodeId, "rag");
    const nodeResult = result?.result as Record<string, unknown>;
    assert.equal(nodeResult.queryId, "q1");
    assert.deepEqual(nodeResult.retrieval, { graphEnabled: true });
    assert.deepEqual(result?.outputs?.graph, {
      enabled: true,
      context: "A -> B",
      entities: 2,
      relations: 1,
      chunkHits: 1,
    });
  });
});

describe("declared workflow variables", () => {
  it("rejects misspelled templates and run variables before calling external tools", async () => {
    const nodes: WorkflowRunRequest["nodes"] = [
      { id: "start", kind: "start", config: { runVariables: [{ name: "query", type: "string" }] } },
      {
        id: "tool",
        kind: "mcp",
        config: {
          serviceSlug: "docs",
          toolName: "search",
          inputs: [{ name: "query", source: { type: "run", variable: "query" } }],
          arguments: '{"query":"{{qurey}}"}',
        },
      },
    ];
    let calls = 0;
    await assert.rejects(
      executeWorkflow(
        { nodes, edges: [{ source: "start", target: "tool" }], input: { query: "hello" } },
        () => {},
        {
          callMcpTool: async () => {
            calls++;
            return {};
          },
        },
      ),
      /未绑定变量 qurey/,
    );
    assert.equal(calls, 0);
    nodes[1]!.config = { inputs: [{ name: "query", source: { type: "run", variable: "qurey" } }] };
    assert.throws(
      () => validateWorkflow({ nodes, edges: [{ source: "start", target: "tool" }], input: {} }),
      /qurey 未声明/,
    );
  });
  it("uses typed defaults during execution and rejects mismatched values", async () => {
    const request: WorkflowRunRequest = {
      nodes: [
        {
          id: "start",
          kind: "start",
          config: { runVariables: [{ name: "count", type: "number", defaultValue: 3 }] },
        },
        {
          id: "end",
          kind: "end",
          config: {
            inputs: [{ name: "count", source: { type: "run", variable: "count" } }],
            outputs: [{ name: "count", selector: "$inputs.count" }],
          },
        },
      ],
      edges: [{ source: "start", target: "end" }],
      input: {},
    };
    assert.equal((await executeWorkflow(request, () => {})).end?.count, 3);
    await assert.rejects(
      executeWorkflow({ ...request, input: { count: "3" } }, () => {}),
      /应为 number/,
    );
  });
  it("allows declared optional inputs to be absent in a template", async () => {
    const request: WorkflowRunRequest = {
      nodes: [
        {
          id: "start",
          kind: "start",
          config: { runVariables: [{ name: "suffix", type: "string", required: false }] },
        },
        {
          id: "tool",
          kind: "mcp",
          config: {
            serviceSlug: "docs",
            toolName: "search",
            inputs: [
              { name: "suffix", source: { type: "run", variable: "suffix" }, required: false },
            ],
            arguments: '{"query":"hello{{suffix}}"}',
            outputs: [{ name: "result", selector: "$result" }],
          },
        },
      ],
      edges: [{ source: "start", target: "tool" }],
      input: {},
    };
    const outputs = await executeWorkflow(request, () => {}, {
      callMcpTool: async (_binding, args) => args,
    });
    assert.deepEqual(outputs.tool?.result, { query: "hello" });
  });
});

it("reports missing dynamic output paths instead of silently dropping the output", async () => {
  const result = await executeWorkflowNodeTest(
    {
      node: {
        id: "tool",
        kind: "mcp",
        config: {
          serviceSlug: "docs",
          toolName: "search",
          arguments: "{}",
          outputs: [{ name: "title", selector: "$result.titel" }],
        },
      },
      inputs: {},
    },
    { callMcpTool: async () => ({ title: "document" }) },
  );
  assert.equal(result.status, "error");
  assert.match(result.error!, /输出路径.*titel.*不存在/);
});
