import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpClient, McpApiError } from "./mcp.js";
import { createRagClient } from "./rag.js";
import { createGraphClient } from "./graph-client.js";
import { createObservatoryClient, pendingQuerySteps } from "./observatory.js";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("MCP tool and prompt mutations keep optimistic revisions and the control-plane response envelope", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const version = { id: "version", revision: 8 };
  const client = createMcpClient(async (path, init) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return json({ version });
  });
  const tool = { name: "echo", handler: "index.echo", inputSchema: { type: "object" } };
  const prompt = { name: "hello", arguments: [], messages: [] };
  assert.deepEqual(await client.addTool("s", "v", 7, tool), version);
  assert.deepEqual(await client.updateTool("s", "v", "t", 8, { name: "updated" }), version);
  await client.deleteTool("s", "v", "t", 9);
  assert.deepEqual(await client.addPrompt("s", "v", 10, prompt), version);
  assert.deepEqual(await client.updatePrompt("s", "v", "p", 11, { title: "updated" }), version);
  await client.deletePrompt("s", "v", "p", 12);
  assert.deepEqual(calls, [
    { path: "/services/s/versions/v/tools", method: "POST", body: { expectedRevision: 7, tool } },
    {
      path: "/services/s/versions/v/tools/t",
      method: "PATCH",
      body: { expectedRevision: 8, tool: { name: "updated" } },
    },
    { path: "/services/s/versions/v/tools/t", method: "DELETE", body: { expectedRevision: 9 } },
    {
      path: "/services/s/versions/v/prompts",
      method: "POST",
      body: { expectedRevision: 10, prompt },
    },
    {
      path: "/services/s/versions/v/prompts/p",
      method: "PATCH",
      body: { expectedRevision: 11, prompt: { title: "updated" } },
    },
    { path: "/services/s/versions/v/prompts/p", method: "DELETE", body: { expectedRevision: 12 } },
  ]);
});

test("MCP client preserves coded conflicts, malformed errors, 204 and strict successful JSON parsing", async () => {
  let response = json({ error: { code: "REVISION_CONFLICT", message: "Reload the version" } }, 409);
  const client = createMcpClient(async () => response);
  await assert.rejects(
    client.listServices(),
    (error: unknown) =>
      error instanceof McpApiError &&
      error.status === 409 &&
      error.code === "REVISION_CONFLICT" &&
      error.message === "Reload the version",
  );
  response = new Response("upstream unavailable", { status: 502 });
  await assert.rejects(client.listServices(), {
    code: "HTTP_ERROR",
    message: "MCP request failed (502)",
  });
  response = new Response(null, { status: 204 });
  await client.deleteService("s", 3);
  response = new Response("not JSON");
  await assert.rejects(client.listServices(), SyntaxError);
});

test("MCP direct uploads preserve binary bodies and finalize only after a successful upload", async (t) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const client = createMcpClient(async (path, init) => {
    requests.push({ path, body: JSON.parse(String(init?.body)) });
    return path.endsWith("upload-url")
      ? json({
          objectKey: "artifact.zip",
          upload: {
            url: "https://upload.invalid/signed",
            method: "PUT",
            headers: { "x-signed": "yes" },
          },
        })
      : json({ version: { id: "v" }, job: { id: "j" } });
  });
  const data = new Uint8Array([1, 2, 3]);
  const upload = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(_url, "https://upload.invalid/signed");
      assert.equal(init?.body, data);
      assert.deepEqual(init?.headers, { "x-signed": "yes" });
      return new Response(null, { status: 200 });
    },
  );
  const file = { data: data as unknown as BodyInit, size: 3, sha256: "sha256:abc" };
  assert.deepEqual(await client.uploadArtifact("s", "v", 4, file), {
    version: { id: "v" },
    job: { id: "j" },
  });
  assert.deepEqual(requests, [
    { path: "/services/s/versions/v/upload-url", body: { sha256: "sha256:abc", size: 3 } },
    {
      path: "/services/s/versions/v/complete-upload",
      body: { objectKey: "artifact.zip", sha256: "sha256:abc", size: 3, expectedRevision: 4 },
    },
  ]);
  upload.mock.mockImplementation(async () => new Response(null, { status: 403 }));
  requests.length = 0;
  await assert.rejects(client.uploadArtifact("s", "v", 4, file), /代码包上传失败 \(403\)/);
  assert.equal(requests.length, 1);
});

test("MCP shared queries retain filter encoding and response extraction", async () => {
  const paths: string[] = [];
  const client = createMcpClient(async (path) => {
    paths.push(path);
    return json({ services: ["service"], events: ["event"], event: { id: "audit" } });
  });
  assert.deepEqual(await client.listMarketplaceServices(), ["service"]);
  await client.listClientUsage("c", {
    serviceId: "s /中",
    from: "2026-01-01",
    to: "2026-01-02",
    limit: 0,
  });
  assert.deepEqual(await client.listAuditEvents({ outcome: "FAILED", action: "tool call" }), [
    "event",
  ]);
  assert.deepEqual(await client.getAuditEvent("a /中"), { id: "audit" });
  assert.deepEqual(paths, [
    "/marketplace?limit=100",
    "/clients/c/usage?limit=0&serviceId=s+%2F%E4%B8%AD&from=2026-01-01&to=2026-01-02",
    "/audit?limit=100&outcome=FAILED&action=tool+call",
    "/audit/a%20%2F%E4%B8%AD",
  ]);
});

test("RAG routes preserve source encoding, recall switches and feedback omission rules", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({ path, init });
    return {} as T;
  };
  const client = createRagClient(request);
  await client.listChunks("文档 / a");
  await client.deleteDocument("文档 / a");
  await client.queryKnowledge({
    query: "q",
    topK: 3,
    generate: false,
    sources: [],
    ...client.recallOptions(false),
  });
  await client.submitQueryFeedback("q /中", "negative", "");
  assert.equal(calls[0]?.path, "/documents/%E6%96%87%E6%A1%A3%20%2F%20a/chunks");
  assert.equal(calls[1]?.init?.method, "DELETE");
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    query: "q",
    topK: 3,
    generate: false,
    sources: [],
    graph: false,
    keyword: false,
  });
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { rating: "negative" });
  assert.deepEqual(client.recallOptions(true), {});
});

test("RAG upload shares chunk settings without overwriting multipart headers or file entries", async () => {
  const form = new FormData();
  form.append("files", new Blob(["hello"]), "a.txt");
  let captured: RequestInit | undefined;
  const client = createRagClient(async <T>(_path: string, init?: RequestInit): Promise<T> => {
    assert.equal(_path, "/documents");
    captured = init;
    return { files: 1, chunks: 2 } as T;
  });
  const settings = {
    chunkSize: 300,
    chunkOverlap: 20,
    chunkStrategy: "fixed" as const,
    separators: ["\n", "。"],
    semanticThreshold: 0.8,
  };
  assert.deepEqual(await client.uploadDocuments(form, settings), { files: 1, chunks: 2 });
  assert.equal(captured?.body, form);
  assert.equal(captured?.headers, undefined);
  assert.equal(form.get("chunkSize"), "300");
  assert.equal(form.get("separators"), '["\\n","。"]');
  assert.equal(form.getAll("files").length, 1);
});

test("graph client distinguishes an omitted source from an explicit empty source allowlist", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = createGraphClient(async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({ path, init });
    return {} as T;
  });
  await client.retrieveGraph("q");
  await client.retrieveGraph("q", 3, []);
  await client.neighborsOf("entity/中", 2, "");
  await client.listEntities({ limit: 0, search: "two words", type: "公司" });
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { query: "q", maxHops: 2 });
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    query: "q",
    maxHops: 3,
    sources: [],
  });
  assert.equal(calls[2]?.path, "/graph/neighbors/entity%2F%E4%B8%AD?hops=2&source=");
  assert.equal(calls[3]?.path, "/graph/entities?type=%E5%85%AC%E5%8F%B8&search=two+words");
});

test("observatory streaming maps progress and result and cancels the reader at the business terminator", async () => {
  let cancelled = 0;
  const progress: unknown[] = [];
  const result = { sourceId: "source", question: "q", rows: [{ count: 3 }] };
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify({ type: "start", auditId: "a", steps: [] })}\r\n\r\ndata: ${JSON.stringify({ type: "step", auditId: "a", step: { id: "schema" } })}\r\n\r\ndata: ${JSON.stringify({ type: "result", result })}\r\n\r\n`,
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled++;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const client = createObservatoryClient(async (_path, init) => {
    assert.equal(_path, "/api/observatory/query");
    assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
    return response;
  });
  assert.deepEqual(
    await client.runObservatoryQuery("source", "q", [], (event) => progress.push(event)),
    result,
  );
  assert.equal(progress.length, 2);
  assert.equal(cancelled, 1);
  assert.equal(response.body?.locked, false);
});

test("observatory preserves JSON responses, source audit filters and abort signals", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = createObservatoryClient(async (path, init) => {
    calls.push({ path, init });
    return json({ sourceId: "s" });
  });
  const controller = new AbortController();
  await client.runObservatoryQuery("s", "q", [], undefined, controller.signal, "original");
  assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    sourceId: "s",
    question: "q",
    history: [],
    originalQuestion: "original",
  });
  await client.fetchQueryAudits({
    source: "chat",
    sqlSource: "edited",
    offset: 0,
    search: "中 文",
    from: "",
  });
  assert.equal(
    calls[1]?.path,
    "/api/observatory/audits?source=chat&sqlSource=edited&offset=0&search=%E4%B8%AD+%E6%96%87",
  );
  const first = pendingQuerySteps();
  first[0]!.status = "failed";
  assert.equal(pendingQuerySteps()[0]?.status, "pending");
});

test("observatory retains the native text fallback and rejects truncated business streams", async () => {
  const text = 'data: {"type":"result","result":{"sourceId":"s"}}\n\n';
  const response = () =>
    ({
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      text: async () => text,
    }) as Response;
  await assert.rejects(
    createObservatoryClient(async () => response()).runObservatoryQuery("s", "q", [], () => {}),
    /查询响应为空/,
  );
  const native = createObservatoryClient(async () => response(), {
    requireReadableBody: false,
    requireResult: true,
  });
  assert.deepEqual(await native.runObservatoryQuery("s", "q", [], () => {}), { sourceId: "s" });
  const truncated = createObservatoryClient(
    async () =>
      new Response('data: {"type":"start","auditId":"a","steps":[]}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  await assert.rejects(
    truncated.runObservatoryQuery("s", "q", [], () => {}),
    /查询连接中断/,
  );
});
