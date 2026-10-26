import assert from "node:assert/strict";
import { after, before, it, mock } from "node:test";
import { closeDb, openDb } from "../../platform/db.js";
import { formatRagRetrieval, retrieveRag, type RagQueryResponseBody } from "./catalog.js";

const chunk = { source: "guide.md", chunkIndex: 1, content: "混合检索说明" };
const graphContext = "OpenAI --[供应商]--> GPT-4\nGPT-4 --[能力]--> 推理";
const previousRagApiUrl = process.env.RAG_API_URL;

// 旧实现（graph 字段出现之前）的拼接方式，用来证明向后兼容是逐字节的。
const legacyFormatted = (chunks: RagQueryResponseBody["chunks"]) =>
  chunks
    .map((item) => `【来源: ${item.source} · 第${item.chunkIndex + 1}段】\n${item.content}`)
    .join("\n\n");

before(() => {
  // resourceConfig() 会经 getMcpGatewayCredentials() 读本地配置表，测试用内存库隔离。
  openDb(":memory:");
  // 固定请求地址：开发者本地导出的 RAG_API_URL 不应影响 fetch mock 的断言。
  process.env.RAG_API_URL = "http://localhost:4001/api";
});

after(() => {
  closeDb();
  mock.restoreAll();
  if (previousRagApiUrl === undefined) delete process.env.RAG_API_URL;
  else process.env.RAG_API_URL = previousRagApiUrl;
});

it("appends graph.context after the chunk text when the server returns a graph section", () => {
  const result = formatRagRetrieval({
    chunks: [chunk],
    graph: {
      enabled: true,
      seeds: [{ id: "e1", name: "OpenAI", type: "company" }],
      entities: 2,
      relations: 2,
      chunkHits: 1,
      context: graphContext,
    },
  });

  assert.equal(
    result.formatted,
    "【来源: guide.md · 第2段】\n混合检索说明\n\n【知识图谱】\n" + graphContext,
  );
  assert.equal(result.graph?.context, graphContext);
  assert.equal(result.graph?.chunkHits, 1);
});

it("keeps byte-identical formatting and omits graph when the server predates the graph field", () => {
  const result = formatRagRetrieval({ chunks: [chunk] });

  assert.equal(result.formatted, legacyFormatted([chunk]));
  assert.equal(result.formatted, "【来源: guide.md · 第2段】\n混合检索说明");
  assert.equal(Object.hasOwn(result, "graph"), false);
});

it("ignores empty or whitespace-only graph.context without adding separator lines", () => {
  for (const context of ["", "   \n "]) {
    const result = formatRagRetrieval({ chunks: [chunk], graph: { context } });
    assert.equal(result.formatted, legacyFormatted([chunk]));
  }
});

it("does not prepend blank lines when graph.context exists but no chunk survived", () => {
  // 图谱命中真实分块失败时 rag-server 仍可能返回 graph 文本；注入文本不应以空行开头。
  const result = formatRagRetrieval({ chunks: [], graph: { context: graphContext } });
  assert.equal(result.formatted, `【知识图谱】\n${graphContext}`);
});

it("forwards graph:false to rag-server and exposes the returned graph context", async () => {
  let receivedBody: Record<string, unknown> | undefined;
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "http://localhost:4001/api/query");
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        queryId: "q1",
        chunks: [chunk],
        graph: { enabled: false, entities: 0, relations: 0, chunkHits: 0, context: "" },
        retrieval: { graphEnabled: false },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const result = await retrieveRag({
    query: "混合检索",
    sources: ["guide.md"],
    topK: 5,
    graph: false,
  });

  assert.equal(receivedBody?.graph, false);
  assert.equal(receivedBody?.generate, false);
  assert.equal(result.formatted, legacyFormatted([chunk]));
  assert.deepEqual(result.graph, {
    enabled: false,
    entities: 0,
    relations: 0,
    chunkHits: 0,
    context: "",
  });
  assert.deepEqual(result.retrieval, { graphEnabled: false });
  mock.restoreAll();
});

it("forwards graphHops to rag-server so workflow nodes can tune the subgraph depth", async () => {
  let receivedBody: Record<string, unknown> | undefined;
  mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ chunks: [chunk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await retrieveRag({ query: "q", sources: ["guide.md"], topK: 3, graph: true, graphHops: 3 });

  assert.equal(receivedBody?.graph, true);
  assert.equal(receivedBody?.graphHops, 3);
  mock.restoreAll();
});

it("retrieveRag appends graph.context and does not add a graph key for old servers", async () => {
  mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ chunks: [chunk], graph: { context: graphContext } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const withGraph = await retrieveRag({ query: "q", sources: ["guide.md"], topK: 3 });
  assert.match(withGraph.formatted, /【知识图谱】\nOpenAI --\[供应商\]--> GPT-4/);
  mock.restoreAll();

  mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ chunks: [chunk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const legacy = await retrieveRag({ query: "q", sources: ["guide.md"], topK: 3 });
  assert.equal(legacy.formatted, legacyFormatted([chunk]));
  assert.equal(Object.hasOwn(legacy, "graph"), false);
  mock.restoreAll();
});
