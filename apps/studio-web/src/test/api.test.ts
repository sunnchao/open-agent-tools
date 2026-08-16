import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSseBuffer, streamChat, streamWorkflow, testWorkflowNode } from "../lib/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSseBuffer", () => {
  it("parses a single complete SSE event", () => {
    const { events, rest } = parseSseBuffer('data: {"delta":"hi"}\n\n');
    expect(events).toEqual([{ delta: "hi" }]);
    expect(rest).toBe("");
  });

  it("returns incomplete trailing data as rest without parsing it", () => {
    const { events, rest } = parseSseBuffer('data: {"delta":"hi"}\n\ndata: {"delta":"par');
    expect(events).toEqual([{ delta: "hi" }]);
    expect(rest).toBe('data: {"delta":"par');
  });

  it("ignores non-data lines", () => {
    const buf = 'event: ping\ndata: {"a":1}\n\n';
    const { events } = parseSseBuffer(buf);
    expect(events).toEqual([{ a: 1 }]);
  });

  it("parses multiple events and tool_call / tool_result shapes", () => {
    const buf =
      'data: {"tool_call":{"id":"c1","name":"get_financial_reports","arguments":"{}"}}\n\n' +
      'data: {"tool_result":{"id":"c1","name":"get_financial_reports","ui":{"type":"financial_report_card","props":{"reports":[]}}}}\n\n';
    const { events } = parseSseBuffer(buf);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      tool_call: { id: "c1", name: "get_financial_reports", arguments: "{}" },
    });
    expect(events[1]).toEqual({
      tool_result: {
        id: "c1",
        name: "get_financial_reports",
        ui: { type: "financial_report_card", props: { reports: [] } },
      },
    });
  });

  it("drops malformed JSON events but keeps the rest", () => {
    const buf = 'data: {bad json}\n\ndata: {"ok":true}\n\n';
    const { events } = parseSseBuffer(buf);
    expect(events).toEqual([{ ok: true }]);
  });

  it("sends resource bindings and emits RAG citations", async () => {
    const encoder = new TextEncoder();
    const citations = [{ source: "guide.md", chunkIndex: 0, content: "hello" }];
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ rag_citations: citations })}\n\n`),
              );
              controller.enqueue(encoder.encode('data: {"done":true}\n\n'));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new Promise<void>((resolve, reject) => {
      streamChat(
        [{ role: "user", content: "hi" }],
        undefined,
        {
          onDelta: () => undefined,
          onRagCitations: (value) => expect(value).toEqual(citations),
          onDone: () => resolve(),
          onError: reject,
        },
        {
          resources: {
            mcpTools: [{ serviceSlug: "docs", toolName: "search" }],
            rag: { sources: ["guide.md"], topK: 3 },
          },
        },
      );
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      resources: {
        mcpTools: [{ serviceSlug: "docs", toolName: "search" }],
        rag: { sources: ["guide.md"], topK: 3 },
      },
    });
  });

  it("calls onDone when the stream closes without a done event (fallback)", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"delta":"hello"}\n\n'));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    await new Promise<void>((resolve, reject) => {
      streamChat(
        [{ role: "user", content: "hi" }],
        undefined,
        {
          onDelta: (value) => deltas.push(value),
          onDone: () => resolve(),
          onError: reject,
        },
      );
    });
    expect(deltas).toEqual(["hello"]);
  });

  it("does not call onDone twice when the server sends done then closes", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"done":true}\n\n'));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    let doneCalls = 0;
    await new Promise<void>((resolve, reject) => {
      streamChat(
        [{ role: "user", content: "hi" }],
        undefined,
        {
          onDelta: () => undefined,
          onDone: () => {
            doneCalls += 1;
            resolve();
          },
          onError: reject,
        },
      );
    });
    expect(doneCalls).toBe(1);
  });

  it("consumes workflow node events and final outputs", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"node_start","nodeId":"a","label":"Start","kind":"start"}\n\n',
                ),
              );
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"node_result","nodeId":"a","status":"success","inputs":{"text":"hi"},"outputs":{"value":"ok"},"result":"ok","prompt":"请回答：hi","systemPrompt":"你是助手","metadata":{"durationMs":12,"tokenUsage":{"inputTokens":1,"outputTokens":2,"totalTokens":3}}}\n\n',
                ),
              );
              controller.enqueue(
                encoder.encode('data: {"type":"run_done","outputs":{"a":{"value":"ok"}}}\n\n'),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const starts: Array<[string, string | undefined]> = [];
    const results: Array<{ id: string; status: string; meta: unknown }> = [];
    await new Promise<void>((resolve, reject) => {
      streamWorkflow(
        { nodes: [{ id: "a", kind: "start", label: "Start", config: {} }], edges: [], input: {} },
        {
          onNodeStart: (id, _label, kind) => starts.push([id, kind]),
          onNodeResult: (id, status, meta) => results.push({ id, status, meta }),
          onDone: (outputs) => {
            expect(outputs.a?.value).toBe("ok");
            resolve();
          },
          onError: reject,
        },
      );
    });
    expect(starts).toEqual([["a", "start"]]);
    expect(results).toEqual([
      {
        id: "a",
        status: "success",
        meta: {
          inputs: { text: "hi" },
          outputs: { value: "ok" },
          result: "ok",
          prompt: "请回答：hi",
          systemPrompt: "你是助手",
          metadata: {
            durationMs: 12,
            tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        },
      },
    ]);
  });

  it("tests a single workflow node and preserves observable result metadata", async () => {
    const nodeResult = {
      nodeId: "input-1",
      status: "success" as const,
      inputs: { text: "hello" },
      result: { text: "hello" },
      outputs: { text: "hello" },
      metadata: {
        nodeKind: "input",
        startedAt: "2026-08-06T00:00:00.000Z",
        finishedAt: "2026-08-06T00:00:00.003Z",
        durationMs: 3,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ result: nodeResult }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testWorkflowNode(
      { id: "input-1", kind: "input", label: "用户输入", config: {} },
      { text: "hello" },
    );

    expect(result).toEqual(nodeResult);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/node/test",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      node: { id: "input-1", kind: "input", label: "用户输入", config: {} },
      inputs: { text: "hello" },
    });
  });
});
