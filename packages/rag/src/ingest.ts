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
}

/** 从本地路径入库一份文档，返回写入的分块数。幂等：先清该 source 旧数据。 */
export async function ingestPath(path: string, opts: IngestOptions): Promise<number> {
  const loader = loaderFor(path);
  const [docs, data] = await Promise.all([loader.load(path), readFile(path)]);
  return ingestDocuments(normalizeSource(path), docs, opts, fileMetadata(path, data, opts));
}

/** 从内存 Buffer 入库一份文档（Web 上传场景），返回写入的分块数。幂等。 */
export async function ingestBuffer(
  name: string,
  data: Uint8Array,
  opts: IngestOptions,
): Promise<number> {
  const loader = loaderForName(name);
  const docs = await loader.loadBuffer(name, data);
  return ingestDocuments(normalizeSource(name), docs, opts, fileMetadata(name, data, opts));
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
  if (chunks.length === 0) throw new Error(`document "${source}" has no indexable content`);

  const contents = chunks.map((c) => c.content);
  const vectors = opts.embeddings
    ? await opts.embeddings.embedDocuments(contents)
    : contents.map(() => new Float32Array(0));

  const rows = chunks.map((c, i) => ({
    chunk: { id: sha1(`${source}:${i}`), source, chunkIndex: i, content: c.content } as Chunk,
    vector: Float32Array.from(vectors[i] ?? []),
  }));
  // embeddings 完成后再进入原子替换；外部模型失败时旧版本仍然可检索。
  opts.store.replaceSource(
    source,
    rows.map(({ chunk, vector }) => ({ chunk, embedding: vector })),
    metadata,
  );
  return chunks.length;
}

function fileMetadata(name: string, data: Uint8Array, opts: IngestOptions): DocumentWriteMetadata {
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
  };
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
