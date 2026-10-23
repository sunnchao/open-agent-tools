import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  fetchWorkflow,
  fetchWorkflowRunEvents,
  fetchWorkflowRuns,
  fetchWorkflows,
  publishWorkflow,
  rollbackWorkflow,
  saveWorkflowDraft,
  streamWorkflow,
  testWorkflowNode,
} from "./workflow";
import { setAuthMemory, __resetAuth } from "../lib/http";
import { setStorageBackend } from "../lib/storage";

const snapshot = { name: "w", nodes: [], edges: [] };

describe("workflow api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
  });
  it("uses current server URL, token and workspace after settings change", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ workflows: [] }));
    vi.stubGlobal("fetch", fetchMock);
    setAuthMemory({ agentUrl: "http://first:3000", token: "token-1", workspaceId: "ws-1" });
    await fetchWorkflows();
    setAuthMemory({ agentUrl: "http://second:3000", token: "token-2", workspaceId: "ws-2" });
    await fetchWorkflows();
    for (const [index, host, token, workspace] of [
      [0, "first", "token-1", "ws-1"],
      [1, "second", "token-2", "ws-2"],
    ] as const) {
      expect(fetchMock.mock.calls[index]?.[0]).toBe(`http://${host}:3000/api/workflows`);
      const headers = new Headers(fetchMock.mock.calls[index]?.[1]?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("x-workspace-id")).toBe(workspace);
    }
  });

  it("covers CRUD/publish/runs/test", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workflows: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflow: { app: { id: "w" } }, apiKeys: [] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workflow: { app: { id: "w" } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workflow: { app: { id: "w" } } }) })
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workflow: { app: { id: "w" } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workflow: { app: { id: "w" } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workflow: { app: { id: "w" } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ run: {}, events: [], graph: snapshot }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: "success" } }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchWorkflows()).toEqual([]);
    expect((await fetchWorkflow("w")).apiKeys).toEqual([]);
    await createWorkflow({ name: "w" });
    await duplicateWorkflow("w");
    await deleteWorkflow("w");
    await saveWorkflowDraft("w", 1, snapshot);
    await publishWorkflow("w", 1);
    await rollbackWorkflow("w", "v1");
    expect(await fetchWorkflowRuns("w")).toEqual([]);
    expect((await fetchWorkflowRunEvents("w", "r")).events).toEqual([]);
    expect(
      (await testWorkflowNode({ id: "n", kind: "llm", label: "l", config: {} }, {})).status,
    ).toBe("success");
  });
  it("streams workflow run events", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const text =
      'data: {"type":"node_start","nodeId":"n1","label":"LLM","kind":"llm"}\n\ndata: {"type":"node_result","nodeId":"n1","status":"success","outputs":{"a":1},"metadata":{"durationMs":3,"tokenUsage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}}\n\ndata: {"type":"run_done","outputs":{"a":1},"nodeOutputs":{"n1":{"a":1}}}\n\n';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: stream }));
    const started: string[] = [];
    let outputs: Record<string, unknown> = {};
    streamWorkflow(
      { nodes: [], edges: [], input: {} },
      {
        onNodeStart: (id) => started.push(id),
        onNodeResult: () => {},
        onDone: (o) => {
          outputs = o;
        },
        onError: () => {
          throw new Error("should not error");
        },
      },
    );
    await vi.waitFor(() => expect(outputs).toEqual({ a: 1 }));
    expect(started).toEqual(["n1"]);
  });
});
