import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { Rag } from "@open-agent-tools/rag";
import { KnowledgeGraph } from "@open-agent-tools/rag/graph";
import { RagAnalyticsStore } from "./analytics.js";
import { resolveRagAuth } from "./auth.js";
import { buildCragController } from "./graph.js";
import { healthRouter } from "./health.js";
import { GraphLifecycle } from "./lifecycle.js";
import {
  buildAnswerSystemPrompt,
  buildRetrievalTrace,
  clampGraphHops,
  queryRouter,
  toRetrievalPayload,
} from "./query-api.js";

let server: Server;
let origin: string;
let dir: string;
let rag: Rag;
let plainRag: Rag;
let graph: KnowledgeGraph;
let analytics: RagAnalyticsStore;

const silent = { log: () => undefined, error: () => undefined };

const DOC_PUBLIC = "腾讯云，微信支付，小程序生态。腾讯云，云服务器，对象存储。";
const DOC_HR = "腾讯云，薪酬带宽，HR 制度。腾讯云，绩效考核，员工培训。";

interface QueryChunk {
  id: string;
  source: string;
  chunkIndex: number;
  content: string;
  score: number;
  debug?: {
    channels: string[];
    graphScore?: number | null;
    graphRank?: number | null;
  };
}

interface QueryResponse {
  queryId: string;
  graph: {
    enabled: boolean;
    seeds: Array<{ id: string; name: string; type: string }>;
    entities: number;
    relations: number;
    chunkHits: number;
    context: string;
  };
  chunks: QueryChunk[];
  retrieval: {
    graphEnabled: boolean;
    keywordEnabled?: boolean;
    graphHits?: Array<{ id: string; source: string; seeds: string[] }>;
    keywordHits?: Array<{ id: string }>;
    timingsMs: { graphMs?: number | null; keywordMs?: number };
  };
  answer: string | null;
}

async function postQuery(body: Record<string, unknown>): Promise<QueryResponse> {
  const response = await fetch(`${origin}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer runtime-token" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as QueryResponse;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "rag-graph-query-"));
  const dbPath = join(dir, "rag.db");
  graph = new KnowledgeGraph({ dbPath: join(dir, "graph.db") });
  rag = new Rag({
    dbPath,
    graph: {
      retrieve: (query, options) => graph.retrieve(query, options),
      getChunksByIds: (ids, sources) => rag.getChunksByIds(ids, sources),
    },
  });
  // 对照实例：不注入图谱通道，用来证明 graph:false 与旧两路检索结果一致。
  plainRag = new Rag({ dbPath });
  analytics = new RagAnalyticsStore(dbPath);

  await rag.ingestBuffers([
    { name: "public.md", data: new TextEncoder().encode(DOC_PUBLIC) },
    { name: "hr.md", data: new TextEncoder().encode(DOC_HR) },
  ]);
  await rag.updateDocument("hr.md", { allowedGroups: ["hr"] });
  const lifecycle = new GraphLifecycle({ rag, graph, logger: silent });
  await lifecycle.onDocumentsIngested(["public.md", "hr.md"]);
  await lifecycle.waitIdle();

  const crag = buildCragController({ rag, graph });
  const app = express();
  app.use(resolveRagAuth({ runtimeToken: "runtime-token", adminToken: "admin-token" }).middleware);
  app.use(express.json());
  app.use(
    "/api",
    queryRouter({
      rag,
      analytics,
      crag,
      embeddingsEnabled: false,
      storeKind: "sqlite",
      graphRetrieval: true,
    }),
  );
  app.use(
    "/api",
    healthRouter({
      storeKind: "sqlite",
      embeddingsEnabled: false,
      llmAvailable: false,
      ocrEnabled: false,
      ocrMinCharsPerPage: 50,
      ocrMaxPagesSync: 10,
      graphRetrieval: true,
    }),
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  await plainRag.close();
  analytics.close();
  graph.close();
  await rag.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("图谱查询参数与 prompt 拼装", () => {
  it("graphHops 默认 2，越界夹取到 1..4", () => {
    assert.equal(clampGraphHops(undefined), 2);
    assert.equal(clampGraphHops("abc"), 2);
    assert.equal(clampGraphHops(0), 1);
    assert.equal(clampGraphHops(2.9), 2);
    assert.equal(clampGraphHops(9), 4);
  });

  it("无图谱上下文时 prompt 与旧版逐字节一致", () => {
    const formatted = "【来源: a.md · 第1段】\n腾讯云";
    const base =
      "你是知识库问答助手。基于提供的资料回答用户问题；资料未覆盖的内容请如实说明，不要编造。引用请标注【来源】。\n\n" +
      formatted;
    assert.equal(buildAnswerSystemPrompt(formatted), base);
    assert.equal(buildAnswerSystemPrompt(formatted, ""), base);
    assert.equal(buildAnswerSystemPrompt(formatted, "   "), base);
  });

  it("有图谱上下文时追加【知识图谱】区块", () => {
    const prompt = buildAnswerSystemPrompt("知识", "(腾讯云) --related_to--> (微信支付)");
    assert.ok(prompt.includes("知识\n\n【知识图谱】\n(腾讯云) --related_to--> (微信支付)"));
  });

  it("检索 payload 带 graphEnabled/graphHits/graphMs，关闭时字段稳定", () => {
    const enabled = {
      query: "q",
      chunks: [],
      formatted: () => "",
      debug: {
        embeddingsEnabled: false,
        candidates: 30,
        rrfK: 60,
        graphEnabled: true,
        timingsMs: { vectorMs: null, keywordMs: 1, graphMs: 2, fusionMs: 1 },
        vectorHits: [],
        keywordHits: [],
        graphHits: [
          {
            id: "a:0",
            source: "a.md",
            chunkIndex: 0,
            content: "腾讯云",
            score: 1,
            rank: 0,
            seeds: ["腾讯云"],
          },
        ],
      },
      graph: {
        enabled: true,
        seeds: [{ id: "e1", name: "腾讯云", type: "concept" }],
        context: "(腾讯云) --related_to--> (微信支付)",
        entities: 2,
        relations: 1,
        chunkHits: 1,
      },
    } as unknown as Parameters<typeof buildRetrievalTrace>[0]["result"];
    const payload = toRetrievalPayload(enabled, { storeKind: "sqlite", embeddingsEnabled: false });
    assert.equal(payload.graphEnabled, true);
    assert.deepEqual((payload.timingsMs as { graphMs?: number }).graphMs, 2);
    assert.deepEqual((payload.graphHits as Array<{ seeds: string[] }>)[0]?.seeds, ["腾讯云"]);

    const disabled = { query: "q", chunks: [], formatted: () => "" } as unknown as Parameters<
      typeof buildRetrievalTrace
    >[0]["result"];
    const off = toRetrievalPayload(disabled, { storeKind: "sqlite", embeddingsEnabled: false });
    assert.equal(off.graphEnabled, false);
    assert.deepEqual(off.graphHits, []);
    assert.deepEqual(off.timingsMs, {
      vectorMs: null,
      keywordMs: 0,
      fusionMs: 0,
      graphMs: null,
    });
  });

  it("审计 trace 的 graphContext 超过 8000 字符时截断", () => {
    const longContext = `相关实体与关系:\n${"腾讯云 --related_to--> 微信支付\n".repeat(500)}`;
    assert.ok(longContext.length > 8000);
    const result = {
      query: "q",
      chunks: [],
      formatted: () => "",
      debug: {
        embeddingsEnabled: false,
        candidates: 30,
        rrfK: 60,
        graphEnabled: true,
        timingsMs: { vectorMs: null, keywordMs: 1, graphMs: 2, fusionMs: 1 },
        vectorHits: [],
        keywordHits: [],
        graphHits: [],
      },
      graph: {
        enabled: true,
        seeds: [],
        context: longContext,
        entities: 0,
        relations: 0,
        chunkHits: 0,
      },
    } as unknown as Parameters<typeof buildRetrievalTrace>[0]["result"];
    const trace = buildRetrievalTrace({
      storeKind: "sqlite",
      embeddingsEnabled: false,
      visibleSources: undefined,
      viewerGroups: undefined,
      result,
      formatted: "",
      answer: null,
    });
    assert.ok((trace.graphContext ?? "").length <= 8000 + "…(truncated)".length);
    assert.ok(trace.graphContext?.endsWith("…(truncated)"));
    assert.equal(trace.truncated, true);
  });
});

describe("POST /api/query 图谱第三路", () => {
  it("默认启用图谱增强并返回子图上下文", async () => {
    const body = await postQuery({ query: "腾讯云" });
    assert.equal(body.graph.enabled, true);
    assert.ok(
      body.graph.seeds.some((seed) => seed.name === "腾讯云"),
      "应命中种子实体",
    );
    assert.ok(body.graph.entities > 0 && body.graph.relations > 0);
    assert.match(body.graph.context, /腾讯云/);
    assert.match(body.graph.context, /--/, "context 应包含三元组序列化");
    assert.equal(body.retrieval.graphEnabled, true);
    assert.equal(typeof body.retrieval.timingsMs.graphMs, "number");
  });

  it("图谱回溯分块进入 RRF，候选可从 retrieval.graphHits 回放", async () => {
    const body = await postQuery({ query: "腾讯云", topK: 5 });
    assert.ok(body.graph.chunkHits > 0, "图谱应回溯到真实分块");
    assert.ok(body.retrieval.graphHits && body.retrieval.graphHits.length > 0);
    assert.ok(
      body.chunks.some((chunk) => chunk.debug?.channels.includes("graph")),
      "至少一个融合命中应标记 graph 通道",
    );
    const graphHitIds = new Set((body.retrieval.graphHits ?? []).map((hit) => hit.id));
    assert.ok(
      body.chunks.every((chunk) => !graphHitIds.has(chunk.id) || chunk.debug?.graphScore != null),
      "图谱候选被融合时必须带 graphScore",
    );
  });

  it("graph:false 回退两路，结果与未注入图谱时一致", async () => {
    const body = await postQuery({ query: "腾讯云", graph: false });
    assert.equal(body.graph.enabled, false);
    assert.deepEqual(body.graph, {
      enabled: false,
      seeds: [],
      entities: 0,
      relations: 0,
      chunkHits: 0,
      context: "",
    });
    assert.equal(body.retrieval.graphEnabled, false);
    assert.deepEqual(body.retrieval.graphHits, []);
    assert.ok(
      body.chunks.every((chunk) => !chunk.debug?.channels.includes("graph")),
      "关闭图谱后 channels 不得出现 graph",
    );
    const baseline = await plainRag.retrieve("腾讯云", { topK: 5, viewerGroups: [] });
    assert.deepEqual(
      body.chunks.map((chunk) => chunk.id),
      baseline.chunks.map((chunk) => chunk.id),
      "关闭图谱必须与旧两路检索结果一致",
    );
  });

  it("sources 限定只影响单文档时图谱不泄漏其他文档", async () => {
    const body = await postQuery({ query: "腾讯云", sources: ["public.md"] });
    assert.equal(body.graph.enabled, true);
    assert.ok(body.chunks.length > 0);
    assert.ok(body.chunks.every((chunk) => chunk.source === "public.md"));
    assert.ok((body.retrieval.graphHits ?? []).every((hit) => hit.source === "public.md"));
    assert.doesNotMatch(body.graph.context, /薪酬带宽/, "图谱上下文不得含 HR 文档事实");
  });

  it("图谱跳数被 clamp 到 1..4", async () => {
    const high = await postQuery({ query: "腾讯云", graphHops: 99 });
    assert.equal(high.graph.enabled, true);
    const low = await postQuery({ query: "腾讯云", graphHops: -3 });
    assert.equal(low.graph.enabled, true);
  });

  it("graph:false + keyword:false 退化为仅向量召回", async () => {
    const body = await postQuery({ query: "腾讯云", graph: false, keyword: false });
    assert.equal(body.graph.enabled, false);
    assert.equal(body.retrieval.graphEnabled, false);
    assert.equal(body.retrieval.keywordEnabled, false);
    assert.deepEqual(body.retrieval.keywordHits, [], "关键词通道关闭后不应有 BM25 候选");
    assert.ok(
      body.chunks.every((chunk) => !chunk.debug?.channels.includes("graph")),
      "关闭图谱后 channels 不得出现 graph",
    );
    assert.ok(
      body.chunks.every((chunk) => !chunk.debug?.channels.includes("keyword")),
      "仅向量模式下 channels 不得出现 keyword",
    );
  });

  it("默认（不传 keyword）保持三路召回，响应不写 keywordEnabled", async () => {
    const body = await postQuery({ query: "腾讯云" });
    assert.equal(body.retrieval.graphEnabled, true);
    assert.ok(body.retrieval.keywordHits && body.retrieval.keywordHits.length > 0);
    assert.equal(body.retrieval.keywordEnabled, undefined, "默认模式不应写 keywordEnabled");
    assert.ok(body.chunks.some((chunk) => chunk.debug?.channels.includes("keyword")));
  });

  it("仅关闭图谱（不关关键词）仍是向量 + 关键词两路", async () => {
    const body = await postQuery({ query: "腾讯云", graph: false });
    assert.equal(body.retrieval.graphEnabled, false);
    assert.equal(body.retrieval.keywordEnabled, undefined, "只关图谱不应影响关键词通道");
    assert.ok((body.retrieval.keywordHits?.length ?? 0) > 0);
    assert.ok(body.chunks.some((chunk) => chunk.debug?.channels.includes("keyword")));
  });

  it("审计链路记录图谱第三路", async () => {
    const body = await postQuery({ query: "腾讯云", graphHops: 2 });
    const detail = analytics.getQueryDetail(body.queryId);
    assert.ok(detail, "应能按 queryId 回放");
    const trace = detail?.trace;
    assert.ok(trace, "应持久化检索 trace");
    assert.equal(trace?.graphEnabled, true);
    assert.ok((trace?.graphHits?.length ?? 0) > 0);
    assert.match(trace?.graphContext ?? "", /腾讯云/);
    assert.equal(typeof trace?.timingsMs.graphMs, "number");
  });
});

describe("GET /api/health 图谱能力", () => {
  it("暴露 graphRetrieval 开关", async () => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.graphRetrieval, true);
    assert.equal(body.ok, true);
  });

  it("部署级关闭时如实返回 false", async () => {
    const app = express();
    app.use(
      "/api",
      healthRouter({
        storeKind: "sqlite",
        embeddingsEnabled: false,
        llmAvailable: false,
        ocrEnabled: false,
        ocrMinCharsPerPage: 50,
        ocrMaxPagesSync: 10,
        graphRetrieval: false,
      }),
    );
    const probe = app.listen(0, "127.0.0.1");
    await once(probe, "listening");
    try {
      const address = probe.address();
      assert.ok(address && typeof address === "object");
      const body = (await (
        await fetch(`http://127.0.0.1:${address.port}/api/health`)
      ).json()) as Record<string, unknown>;
      assert.equal(body.graphRetrieval, false);
    } finally {
      probe.close();
      await once(probe, "close");
    }
  });
});
