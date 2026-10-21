import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { Document } from "@langchain/core/documents";
import type {
  Chunk,
  ChunkStrategy,
  DocumentWriteMetadata,
  IngestResult,
  VectorStore,
} from "./types.js";
import { sha1 } from "./utils.js";
import { loaderFor, loaderForName } from "./loaders.js";
import { chunkDocuments, DEFAULT_SEPARATORS } from "./chunking.js";
import {
  DEFAULT_OCR_DECISION,
  isLikelyScanned,
  normalizeOcrDecision,
  totalTextLength,
  type OcrDecision,
  type OcrProvider,
  type OcrStatus,
} from "./ocr.js";

export { DEFAULT_SEPARATORS } from "./chunking.js";

export interface IngestOptions {
  store: VectorStore;
  /** 缺省时退化为纯 BM25 关键词入库（不存向量），便于无 API Key 环境演示。 */
  embeddings?: EmbeddingsInterface;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkStrategy?: ChunkStrategy;
  /** 递归切分时按顺序匹配的分段标识符。传入自定义值将整体回退旧版切分行为。 */
  separators?: string[];
  /** 语义切分相似度阈值（0-1），仅在有 embeddings 时生效。 */
  semanticThreshold?: number;
  /** PDF OCR 兜底：缺省关闭（纯文本路径），保持原生链路零变化。 */
  ocr?: OcrProvider;
  ocrDecision?: Partial<OcrDecision>;
}

/** 从本地路径入库一份文档，返回写入的分块数。幂等：先清该 source 旧数据。 */
export async function ingestPath(path: string, opts: IngestOptions): Promise<number> {
  const ocrDecision = normalizeOcrDecision(opts.ocrDecision);
  const loader = loaderFor(path, { ocr: opts.ocr, ocrDecision });
  const [docs, data] = await Promise.all([loader.load(path), readFile(path)]);
  return ingestDocuments(
    normalizeSource(path),
    docs,
    opts,
    fileMetadata(path, data, opts, ocrInfoForDocs(path, docs, ocrDecision)),
  );
}

/** 从内存 Buffer 入库一份文档（Web 上传场景），返回写入的分块数。幂等。 */
export async function ingestBuffer(
  name: string,
  data: Uint8Array,
  opts: IngestOptions,
): Promise<number> {
  const ocrDecision = normalizeOcrDecision(opts.ocrDecision);
  const loader = loaderForName(name, { ocr: opts.ocr, ocrDecision });
  const docs = await loader.loadBuffer(name, data);
  return ingestDocuments(
    normalizeSource(name),
    docs,
    opts,
    fileMetadata(name, data, opts, ocrInfoForDocs(name, docs, ocrDecision)),
  );
}

async function ingestDocuments(
  source: string,
  docs: Document[],
  opts: IngestOptions,
  metadata: DocumentWriteMetadata,
): Promise<number> {
  const chunks = await chunkDocuments(docs, {
    chunkSize: opts.chunkSize ?? 500,
    chunkOverlap: opts.chunkOverlap ?? 50,
    separators: opts.separators ?? [...DEFAULT_SEPARATORS],
    strategy: opts.chunkStrategy,
    embeddings: opts.embeddings,
    semanticThreshold: opts.semanticThreshold,
  });
  if (chunks.length === 0) throw diagnosticEmptyError(source, docs, metadata, opts.ocrDecision);

  const contents = chunks.map((c) => c.content);
  const vectors = opts.embeddings
    ? await opts.embeddings.embedDocuments(contents)
    : contents.map(() => new Float32Array(0));

  const rows = chunks.map((c, i) => ({
    chunk: { id: sha1(`${source}:${i}`), source, chunkIndex: i, content: c.content } as Chunk,
    vector: Float32Array.from(vectors[i] ?? []),
  }));
  // embeddings 完成后再进入原子替换；外部模型失败时旧版本仍然可检索。
  // SQLite 下是事务原子；ES 下是 delete+bulk best-effort，失败时需重传修复。
  await opts.store.replaceSource(
    source,
    rows.map(({ chunk, vector }) => ({ chunk, embedding: vector })),
    metadata,
  );
  return chunks.length;
}

function fileMetadata(
  name: string,
  data: Uint8Array,
  opts: IngestOptions,
  ocr?: { ocrApplied: boolean; ocrStatus: OcrStatus; ocrPages: number },
): DocumentWriteMetadata {
  const extension = extname(name).toLowerCase();
  const mimeType =
    extension === ".pdf"
      ? "application/pdf"
      : extension === ".md" || extension === ".markdown"
        ? "text/markdown"
        : "text/plain";
  return {
    mimeType,
    byteSize: data.byteLength,
    contentHash: createHash("sha256").update(data).digest("hex"),
    chunkStrategy: opts.chunkStrategy ?? (opts.embeddings ? "semantic" : "fixed"),
    chunkSize: opts.chunkSize ?? 500,
    chunkOverlap: opts.chunkOverlap ?? 50,
    separators: [...(opts.separators ?? DEFAULT_SEPARATORS)],
    semanticThreshold:
      (opts.chunkStrategy ?? (opts.embeddings ? "semantic" : "fixed")) === "semantic"
        ? (opts.semanticThreshold ?? 0.75)
        : null,
    ocrApplied: ocr?.ocrApplied ?? false,
    ocrStatus: ocr?.ocrStatus ?? (extension === ".pdf" ? "text_layer" : "none"),
    ocrPages: ocr?.ocrPages ?? 0,
  };
}

/** 按页文本推导 OCR 标记：供 fileMetadata 与 store 落库使用。 */
function ocrInfoForDocs(
  name: string,
  docs: Document[],
  ocrDecision?: Partial<OcrDecision>,
): { ocrApplied: boolean; ocrStatus: OcrStatus; ocrPages: number } {
  const decision = normalizeOcrDecision(ocrDecision);
  const isPdf = extname(name).toLowerCase() === ".pdf";
  const ocrApplied = docs.some((d) => d.metadata?.ocr === true);
  if (ocrApplied) return { ocrApplied: true, ocrStatus: "ocr", ocrPages: docs.length };
  if (!isPdf) return { ocrApplied: false, ocrStatus: "none", ocrPages: 0 };
  const pages = docs.length > 0 ? docs.length : 1;
  const textLen = totalTextLength(docs);
  if (isLikelyScanned(textLen, pages, decision.minCharsPerPage)) {
    const failed = docs.some((d) => typeof d.metadata?.ocrError === "string");
    return {
      ocrApplied: false,
      ocrStatus: failed ? "ocr_failed" : "ocr_needed",
      ocrPages: docs.length,
    };
  }
  return { ocrApplied: false, ocrStatus: "text_layer", ocrPages: docs.length };
}

/** 空内容错误细分：扫描疑似 vs OCR 后仍空，便于前端分流提示。 */
function diagnosticEmptyError(
  source: string,
  docs: Document[],
  metadata: DocumentWriteMetadata,
  ocrDecision?: Partial<OcrDecision>,
): Error {
  const decision = normalizeOcrDecision(ocrDecision ?? DEFAULT_OCR_DECISION);
  const pages = docs.length > 0 ? docs.length : 1;
  const textLen = totalTextLength(docs);
  const avg = Math.floor(textLen / pages);
  if (metadata.ocrApplied) {
    return new Error(
      `document "${source}" has no indexable content after OCR (ocr applied to ${pages} pages, still empty)`,
    );
  }
  if (isLikelyScanned(textLen, pages, decision.minCharsPerPage)) {
    const ocrOff = decision.enabled ? "" : " Enable OCR (RAG_OCR_ENABLED=true) and re-upload.";
    return new Error(
      `document "${source}" has no indexable content (likely scanned PDF, ${pages} pages, avg ${avg} chars).${ocrOff}`,
    );
  }
  return new Error(`document "${source}" has no indexable content`);
}

/** 归一化 source 为文件名，避免绝对路径写入元数据。 */
export function normalizeSource(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 便捷组合：批量路径入库并返回统计。
 * sources 只含本次入库的来源——下游据此增量重建图谱，返回全库会导致每次上传全量重抽。
 */
export async function ingestMany(paths: string[], opts: IngestOptions): Promise<IngestResult> {
  let total = 0;
  for (const p of paths) {
    total += await ingestPath(p, opts);
  }
  return {
    files: paths.length,
    chunks: total,
    sources: [...new Set(paths.map(normalizeSource))],
  };
}
