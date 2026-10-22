import { Router, type Request, type Response } from "express";
import multer from "multer";
import { runTraced, withTraceAttributes } from "@open-agent-tools/observability";
import type { OcrDecision } from "@open-agent-tools/rag";
import { uploadChunkSettings, type ChunkSettings } from "../chunk-settings.js";
import type { KnowledgeBase } from "../knowledge.js";
import { documentMetadataPatch, routeParam } from "../request-validation.js";
import type { HealthPayloadOptions } from "./health.js";

interface DocumentsRouterOptions {
  knowledge: KnowledgeBase;
  defaults: ChunkSettings;
  ocrDecision: OcrDecision;
  capabilities: HealthPayloadOptions;
}

export function documentsRouter(options: DocumentsRouterOptions): Router {
  const { knowledge, defaults, ocrDecision, capabilities } = options;
  const { rag } = knowledge;
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
    defParamCharset: "utf8",
  });

  /** 上传文档（支持多文件 .pdf/.txt/.md），幂等入库。 */
  router.post("/documents", upload.array("files"), async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "no files uploaded (field name: files)" });
      return;
    }
    let chunkSettings: ChunkSettings;
    try {
      chunkSettings = uploadChunkSettings(req.body as Record<string, unknown>, defaults);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (chunkSettings.chunkStrategy === "semantic" && !capabilities.embeddingsEnabled) {
      res.status(400).json({ error: "semantic chunking requires embeddings" });
      return;
    }
    try {
      await runTraced("rag-ingest", async (span) => {
        span.update({
          input: {
            files: files.map((f) => f.originalname),
            chunkSettings,
            ocr: { ...ocrDecision },
          },
        });
        await withTraceAttributes(
          {
            tags: ["rag"],
            metadata: {
              source: "ingest",
              files: files.map((f) => f.originalname).join(","),
              ocrEnabled: String(ocrDecision.enabled),
            },
          },
          async () => {
            const startedAt = Date.now();
            const result = await knowledge.ingestBuffers(
              files.map((f) => ({ name: f.originalname, data: new Uint8Array(f.buffer) })),
              chunkSettings,
            );
            const allDocuments = await rag.listDocuments();
            const documents = allDocuments.filter((d) => result.sources.includes(d.source));
            const ocrApplied = documents.filter((d) => d.ocrApplied).length;
            console.log(
              `[rag-ocr] sources=${result.sources.join(",")} chunks=${result.chunks} ` +
                `ocrApplied=${ocrApplied}/${documents.length} elapsed=${Date.now() - startedAt}ms`,
            );
            span.update({ output: { sources: result.sources, ocrApplied } });
            res.status(201).json({ ...result, graph: await knowledge.status() });
          },
        );
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 可诊断错误细分：413 同步页数超限，422 无可索引内容（含疑似扫描/OCR后仍空），其余 500。
      if (/too many scanned pages/i.test(message)) {
        res.status(413).json({ error: message });
        return;
      }
      if (/no indexable content/i.test(message)) {
        res.status(422).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  /** 知识库概览：来源列表（含每个来源的分块数）+ 总分块数 + 能力状态。 */
  router.get("/documents", async (_req: Request, res: Response) => {
    const sources = await rag.listDocuments();
    res.json({
      sources,
      chunks: sources.reduce((total, document) => total + document.chunks, 0),
      embeddingsEnabled: capabilities.embeddingsEnabled,
      llmAvailable: capabilities.llmAvailable,
      ocrEnabled: ocrDecision.enabled,
      ocrMinCharsPerPage: ocrDecision.minCharsPerPage,
      ocrMaxPagesSync: ocrDecision.maxPagesSync,
      // 部署级图谱总开关：前端据此禁用「图谱检索」勾选并提示，避免默认开启造成误导。
      graphRetrieval: capabilities.graphRetrieval,
      ...defaults,
    });
  });

  /** 查看某来源的全部分块详情（id、序号、原文、长度、是否含向量）。 */
  router.get("/documents/:source/chunks", async (req: Request, res: Response) => {
    const source = routeParam(req.params.source);
    if (!source) {
      res.status(400).json({ error: "source is required" });
      return;
    }
    res.json({ source, chunks: await rag.listChunks(source) });
  });

  /** 编辑展示标题与标签。source 是稳定检索标识，不允许原地重命名。 */
  router.patch("/documents/:source", async (req: Request, res: Response) => {
    const source = routeParam(req.params.source);
    if (!source) {
      res.status(400).json({ error: "source is required" });
      return;
    }
    try {
      const updated = await rag.updateDocument(source, documentMetadataPatch(req.body));
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
  router.delete("/documents/:source", async (req: Request, res: Response) => {
    const source = routeParam(req.params.source);
    if (!source) {
      res.status(400).json({ error: "source is required" });
      return;
    }
    const removed = await knowledge.clearSource(source);
    res.json({ ok: true, source, graph: removed });
  });

  return router;
}
