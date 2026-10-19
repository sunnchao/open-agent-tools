import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { CallbackHandler } from "@langfuse/langchain";
import { DEFAULT_SEPARATORS, Rag } from "@open-agent-tools/rag";
import { KnowledgeGraph } from "@open-agent-tools/rag/graph";
import { parseChunkStrategy, parseSemanticThreshold, parseSeparators } from "./chunk-settings.js";
import { querySources } from "./query-settings.js";
import { buildCragController, graphRouter } from "./graph.js";
import { GraphLifecycle } from "./lifecycle.js";
import { RagAnalyticsStore, type QueryEventInput } from "./analytics.js";
import { EvalRunner } from "./eval/runner.js";
import { evalRouter } from "./eval/router.js";
import { EvalStore } from "./eval/store.js";
import { documentMetadataPatch, queryFeedback } from "./request-validation.js";
// Langfuse 必须在创建 LangChain 模型（llm/embeddings）之前初始化并附加 CallbackHandler。
import { initLangfuse, runTraced, withTraceAttributes } from "@open-agent-tools/observability";
initLangfuse({ serviceName: "open-agent-rag-server", envRoot: "../" });

loadEnv({ path: resolve(import.meta.dirname, "../.env") });
loadEnv({ path: resolve(import.meta.dirname, "../.env.local"), override: true });

const PORT = Number(process.env.RAG_API_PORT) || 4001;
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_API_BASE_URL;
const dbPath = resolve(import.meta.dirname, process.env.RAG_DB_PATH ?? "../rag.db");
// 图谱库与知识库同生命周期，两者路径必须一起切换：只改一个会让新库对着旧图谱做对账。
const graphDbPath = resolve(
  import.meta.dirname,
  process.env.RAG_GRAPH_DB_PATH ?? "../rag-graph.db",
);
const defaultChunkSize = Number(process.env.RAG_CHUNK_SIZE) || 500;
const defaultChunkOverlap = Number(process.env.RAG_CHUNK_OVERLAP) || 50;
const defaultSeparators = parseSeparators(process.env.RAG_SEPARATORS, DEFAULT_SEPARATORS);
const defaultChunkStrategy = parseChunkStrategy(process.env.RAG_CHUNK_STRATEGY, "fixed");
// 相邻单元相似度低于阈值时断块；阈值越高，分块越细。
const defaultSemanticThreshold = parseSemanticThreshold(process.env.RAG_SEMANTIC_THRESHOLD, 0.75);

// LangChain CallbackHandler：把 llm 的调用自动写入 Langfuse。
// 未配置 LANGFUSE_* 时 instrumentation 内部禁用，handler 为 no-op。
const langfuseHandler = new CallbackHandler({ tags: ["rag-server"], version: "0.0.0" });

// 有 Key 则启用向量检索 + LLM 生成；无 Key 自动退化为 BM25 关键词检索（可离线演示）。
// 注：@langchain/openai v1 的 OpenAIEmbeddings 类型不暴露 callbacks，嵌入调用暂不单独上报；
// 检索行为由请求级 trace（rag-query / rag-ingest）覆盖。
const embeddings = apiKey
  ? new OpenAIEmbeddings({
      model: process.env.OPENAI_EMBEDDINGS_MODEL ?? "text-embedding-3-small",
      configuration: { baseURL, apiKey },
    })
  : undefined;

const llm = apiKey
  ? new ChatOpenAI({
      model: process.env.OPENAI_API_MODEL ?? "gpt-4o-mini",
      configuration: { baseURL, apiKey },
    })
  : undefined;
if (llm) llm.callbacks = [langfuseHandler];

const rag = new Rag({
  embeddings,
  dbPath,
  chunkSize: defaultChunkSize,
  chunkOverlap: defaultChunkOverlap,
  chunkStrategy: defaultChunkStrategy,
  separators: defaultSeparators,
  semanticThreshold: defaultSemanticThreshold,
});
const analytics = new RagAnalyticsStore(dbPath, Number(process.env.RAG_QUERY_RETENTION_DAYS) || 90);

// 检索评估基准：评测集/运行记录与知识库同库，检索直接复用在线链路，保证评测与线上口径一致。
const evalStore = new EvalStore(dbPath);
const evalRunner = new EvalRunner({
  store: evalStore,
  retrieve: async (query, options) => {
    const result = await rag.retrieve(query, { topK: options.topK, sources: options.sources });
    return result.chunks.map((chunk) => ({ source: chunk.source, content: chunk.content }));
  },
});

// 知识图谱：独立 SQLite 邻接表存储（与 rag 共用文档源，抽取输入为 rag 分块）。
// 有 Key 时接入 LLM 抽取器（语义三元组）+ 实体名向量兜底；无 Key 自动回退规则抽取（句内共现）。
const graph = new KnowledgeGraph({
  dbPath: graphDbPath,
  ...(llm
    ? {
        llmChat: (async (system: string, user: string) => {
          const resp = await llm.invoke([
            { role: "system", content: system },
            { role: "user", content: user },
          ]);
          return typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
        }) as (system: string, user: string) => Promise<string>,
      }
    : {}),
  ...(embeddings
    ? {
        embeddings: {
          embedDocuments: (texts: string[]) => embeddings.embedDocuments(texts),
        },
      }
    : {}),
});
const crag = buildCragController({ rag, graph });

// 知识库与图谱库的唯一联动入口：上传重建、删除级联、状态对账都必须经由此处，
// 直接操作 graph.store 会绕过状态登记，导致两库再次失联。
const lifecycle = new GraphLifecycle({
  rag,
  graph,
  autoExtract: process.env.RAG_AUTO_EXTRACT !== "false",
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  defParamCharset: "utf8", // multipart filename 字段按 UTF-8 解码，避免中文文件名变乱码
});

function clampTopK(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

function uploadChunkSettings(body: Record<string, unknown>): {
  chunkSize: number;
  chunkOverlap: number;
  chunkStrategy: "fixed" | "semantic";
  separators: string[];
  semanticThreshold: number;
} {
  const requestedSize = Number(body.chunkSize);
  const requestedOverlap = Number(body.chunkOverlap);
  const chunkSize = Math.max(
    100,
    Math.min(4000, Number.isFinite(requestedSize) ? requestedSize : defaultChunkSize),
  );
  const chunkOverlap = Math.max(
    0,
    Math.min(
      chunkSize - 1,
      Number.isFinite(requestedOverlap) ? requestedOverlap : defaultChunkOverlap,
    ),
  );
  return {
    chunkSize,
    chunkOverlap,
    chunkStrategy: parseChunkStrategy(body.chunkStrategy, defaultChunkStrategy),
    separators: parseSeparators(body.separators, defaultSeparators),
    semanticThreshold: parseSemanticThreshold(body.semanticThreshold, defaultSemanticThreshold),
  };
}

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, embeddingsEnabled: Boolean(embeddings), llmAvailable: Boolean(llm) });
});

/** 上传文档（支持多文件 .pdf/.txt/.md），幂等入库。 */
app.post("/api/documents", upload.array("files"), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: "no files uploaded (field name: files)" });
    return;
  }
  let chunkSettings: ReturnType<typeof uploadChunkSettings>;
  try {
    chunkSettings = uploadChunkSettings(req.body as Record<string, unknown>);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (chunkSettings.chunkStrategy === "semantic" && !embeddings) {
    res.status(400).json({ error: "semantic chunking requires embeddings" });
    return;
  }
  try {
    await runTraced("rag-ingest", async (span) => {
      span.update({
        input: { files: files.map((f) => f.originalname), chunkSettings },
      });
      await withTraceAttributes(
        {
          tags: ["rag"],
          metadata: { source: "ingest", files: files.map((f) => f.originalname).join(",") },
        },
        async () => {
          const result = await rag.ingestBuffers(
            files.map((f) => ({ name: f.originalname, data: new Uint8Array(f.buffer) })),
            chunkSettings,
          );
          // 图谱重建交由生命周期编排器串行排队（先清后建），不阻塞上传响应；
          // 进度与结果通过 GET /api/graph/sync-status 查询
          if (result.sources.length > 0) lifecycle.onDocumentsIngested(result.sources);
          span.update({ output: { sources: result.sources } });
          res.status(201).json({ ...result, graph: lifecycle.status() });
        },
      );
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 知识库概览：来源列表（含每个来源的分块数）+ 总分块数 + 能力状态。 */
app.get("/api/documents", (_req: Request, res: Response) => {
  res.json({
    sources: rag.listDocuments(),
    chunks: rag.getStats().chunks,
    embeddingsEnabled: Boolean(embeddings),
    llmAvailable: Boolean(llm),
    chunkSize: defaultChunkSize,
    chunkOverlap: defaultChunkOverlap,
    chunkStrategy: defaultChunkStrategy,
    separators: defaultSeparators,
    semanticThreshold: defaultSemanticThreshold,
  });
});

/** 查看某来源的全部分块详情（id、序号、原文、长度、是否含向量）。 */
app.get("/api/documents/:source/chunks", (req: Request, res: Response) => {
  const raw = req.params.source;
  const source = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
  if (!source) {
    res.status(400).json({ error: "source is required" });
    return;
  }
  res.json({ source, chunks: rag.listChunks(source) });
});

/** 编辑展示标题与标签。source 是稳定检索标识，不允许原地重命名。 */
app.patch("/api/documents/:source", (req: Request, res: Response) => {
  const raw = req.params.source;
  const source = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
  if (!source) {
    res.status(400).json({ error: "source is required" });
    return;
  }
  try {
    const updated = rag.updateDocument(source, documentMetadataPatch(req.body));
    if (!updated) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    res.json({ document: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** 删除某个来源的全部数据（分块 + 派生的图谱实体关系一并清理）。 */
app.delete("/api/documents/:source", (req: Request, res: Response) => {
  const raw = req.params.source;
  const source = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
  if (!source) {
    res.status(400).json({ error: "source is required" });
    return;
  }
  rag.clearSource(source);
  const removed = lifecycle.onDocumentRemoved(source);
  res.json({ ok: true, source, graph: removed });
});

/** 产品运营指标：查询量、空召回、延迟、反馈、热门来源与最近查询。 */
app.get("/api/analytics/overview", (req: Request, res: Response) => {
  res.json(analytics.overview(Number(req.query.days) || 14));
});

app.put("/api/query/:queryId/feedback", (req: Request, res: Response) => {
  const raw = req.params.queryId;
  const queryId = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  try {
    const feedback = queryFeedback(req.body);
    const saved = analytics.saveFeedback(queryId, feedback.rating, feedback.comment);
    if (!saved) {
      res.status(404).json({ error: "query not found" });
      return;
    }
    res.json({ feedback: saved });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** 混合检索（+ 可选 LLM 生成回答 / CRAG 纠正评估）。 */
app.post("/api/query", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    query?: unknown;
    topK?: unknown;
    generate?: unknown;
    sources?: unknown;
    crag?: unknown;
  };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  const topK = clampTopK(body.topK);
  const generate = Boolean(body.generate);
  const useCrag = Boolean(body.crag);
  const queryId = randomUUID();
  const queryStartedAt = Date.now();
  let analyticsRecorded = false;
  let sources: string[] | undefined;
  try {
    sources = querySources(body.sources);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  try {
    await runTraced("rag-query", async (span) => {
      span.update({
        input: { query, topK, sources, generate, crag: useCrag },
        metadata: { sources: (sources ?? []).join(","), topK: String(topK) },
      });
      await withTraceAttributes(
        {
          tags: ["rag"],
          metadata: { source: "query", generate: String(generate), crag: String(useCrag) },
        },
        async () => {
          try {
            // CRAG 模式：评估 + 纠正 + 条带精炼
            if (useCrag) {
              const result = await crag.retrieve(query, { sources });
              let answer: string | null = null;
              if (generate && llm && result.formatted) {
                const resp = await llm.invoke([
                  {
                    role: "system",
                    content:
                      "你是知识库问答助手。基于提供的资料回答用户问题；资料未覆盖的内容请如实说明，不要编造。引用请标注【来源】。\n\n" +
                      result.formatted,
                  },
                  { role: "user", content: query },
                ]);
                answer =
                  typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
              }
              span.update({
                output: {
                  assessment: result.assessment,
                  confidence: result.confidence,
                  actions: result.actions.join(","),
                  citations: result.citations.length,
                  answer: summarize(answer),
                },
              });
              recordAnalytics({
                id: queryId,
                query,
                sources,
                topK,
                generate,
                crag: true,
                hits: result.citations,
                answerGenerated: Boolean(answer),
                latencyMs: Date.now() - queryStartedAt,
              });
              analyticsRecorded = true;
              res.json({
                queryId,
                query,
                crag: {
                  assessment: result.assessment,
                  confidence: result.confidence,
                  actions: result.actions,
                },
                formatted: result.formatted,
                citations: result.citations,
                answer,
                generate,
                llmAvailable: Boolean(llm),
              });
              return;
            }

            const result = await rag.retrieve(query, { topK, sources });
            let answer: string | null = null;
            if (generate && llm && result.chunks.length > 0) {
              const resp = await llm.invoke([
                {
                  role: "system",
                  content:
                    "你是知识库问答助手。基于提供的资料回答用户问题；资料未覆盖的内容请如实说明，不要编造。引用请标注【来源】。\n\n" +
                    result.formatted(),
                },
                { role: "user", content: query },
              ]);
              answer =
                typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
            }
            span.update({
              output: {
                chunks: result.chunks.length,
                answer: summarize(answer),
              },
            });
            recordAnalytics({
              id: queryId,
              query,
              sources,
              topK,
              generate,
              crag: false,
              hits: result.chunks,
              answerGenerated: Boolean(answer),
              latencyMs: Date.now() - queryStartedAt,
            });
            analyticsRecorded = true;
            res.json({
              queryId,
              query,
              chunks: result.chunks,
              answer,
              generate,
              llmAvailable: Boolean(llm),
            });
          } catch (error) {
            span.update({
              level: "ERROR",
              statusMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      );
    });
  } catch (e) {
    if (!analyticsRecorded) {
      recordAnalytics({
        id: queryId,
        query,
        sources,
        topK,
        generate,
        crag: useCrag,
        hits: [],
        answerGenerated: false,
        latencyMs: Date.now() - queryStartedAt,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    res.status(500).json({ error: String(e), queryId });
  }
});

/** 统计写入失败不应拖垮在线问答，错误保留在服务日志中。 */
function recordAnalytics(input: QueryEventInput): void {
  try {
    analytics.recordQuery(input);
  } catch (error) {
    console.error(`[rag-analytics] failed to record query ${input.id}: ${String(error)}`);
  }
}

/** 截断长回答，仅用于 trace output，不影响响应内容。 */
function summarize(value: string | null): string | null {
  if (!value) return value;
  return value.length > 500 ? `${value.slice(0, 500)}…(+${value.length - 500} chars)` : value;
}

// 知识图谱 API
app.use("/api/graph", graphRouter({ rag, graph, lifecycle }));

// 检索评估 API（评测集 CRUD + 运行 + 看板）
app.use("/api/eval", evalRouter({ store: evalStore, runner: evalRunner }));

app.listen(PORT, () => {
  console.log(`[rag-server] api listening on http://localhost:${PORT}`);
  console.log(`[rag-server] sqlite: ${dbPath}`);
  console.log(`[rag-server] graph: ${graphDbPath}`);
  console.log(
    `[rag-server] embeddings=${embeddings ? "on" : "off (BM25 only)"} llm=${llm ? "on" : "off"} crag=${crag ? "on" : "off"}`,
  );
});
