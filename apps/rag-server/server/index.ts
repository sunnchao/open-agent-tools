import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { DEFAULT_SEPARATORS, Rag } from "@open-agent-tools/rag";
import { parseSeparators } from "./chunk-settings.js";

loadEnv({ path: resolve(import.meta.dirname, "../.env") });
loadEnv({ path: resolve(import.meta.dirname, "../.env.local"), override: true });

const PORT = Number(process.env.RAG_API_PORT) || 4001;
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_API_BASE_URL;
const dbPath = resolve(import.meta.dirname, process.env.RAG_DB_PATH ?? "../rag.db");
const defaultChunkSize = Number(process.env.RAG_CHUNK_SIZE) || 500;
const defaultChunkOverlap = Number(process.env.RAG_CHUNK_OVERLAP) || 50;
const defaultSeparators = parseSeparators(process.env.RAG_SEPARATORS, DEFAULT_SEPARATORS);

// 有 Key 则启用向量检索 + LLM 生成；无 Key 自动退化为 BM25 关键词检索（可离线演示）。
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

const rag = new Rag({
  embeddings,
  dbPath,
  chunkSize: defaultChunkSize,
  chunkOverlap: defaultChunkOverlap,
  separators: defaultSeparators,
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
  separators: string[];
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
    separators: parseSeparators(body.separators, defaultSeparators),
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
  try {
    const result = await rag.ingestBuffers(
      files.map((f) => ({ name: f.originalname, data: new Uint8Array(f.buffer) })),
      chunkSettings,
    );
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 知识库概览：来源列表（含每个来源的分块数）+ 总分块数 + 能力状态。 */
app.get("/api/documents", (_req: Request, res: Response) => {
  const sources = rag.listSources();
  res.json({
    sources: sources.map((source) => ({
      source,
      chunks: rag.listChunks(source).length,
    })),
    chunks: rag.getStats().chunks,
    embeddingsEnabled: Boolean(embeddings),
    llmAvailable: Boolean(llm),
    chunkSize: defaultChunkSize,
    chunkOverlap: defaultChunkOverlap,
    separators: defaultSeparators,
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

/** 删除某个来源的全部数据。 */
app.delete("/api/documents/:source", (req: Request, res: Response) => {
  const raw = req.params.source;
  const source = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
  if (!source) {
    res.status(400).json({ error: "source is required" });
    return;
  }
  rag.clearSource(source);
  res.json({ ok: true, source });
});

/** 混合检索（+ 可选 LLM 生成回答）。 */
app.post("/api/query", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { query?: unknown; topK?: unknown; generate?: unknown };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  const topK = clampTopK(body.topK);
  const generate = Boolean(body.generate);
  try {
    const result = await rag.retrieve(query, { topK });
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
      answer = typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
    }
    res.json({
      query,
      chunks: result.chunks,
      answer,
      generate,
      llmAvailable: Boolean(llm),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[rag-server] api listening on http://localhost:${PORT}`);
  console.log(`[rag-server] sqlite: ${dbPath}`);
  console.log(
    `[rag-server] embeddings=${embeddings ? "on" : "off (BM25 only)"} llm=${llm ? "on" : "off"}`,
  );
});
