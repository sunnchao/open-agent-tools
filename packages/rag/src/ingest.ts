import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { Document } from "@langchain/core/documents";
import type { Chunk, IngestResult, VectorStore } from "./types.js";
import { sha1 } from "./utils.js";
import { loaderFor, loaderForName } from "./loaders.js";

export interface IngestOptions {
  store: VectorStore;
  /** 缺省时退化为纯 BM25 关键词入库（不存向量），便于无 API Key 环境演示。 */
  embeddings?: EmbeddingsInterface;
  chunkSize?: number;
  chunkOverlap?: number;
}

/** 从本地路径入库一份文档，返回写入的分块数。幂等：先清该 source 旧数据。 */
export async function ingestPath(path: string, opts: IngestOptions): Promise<number> {
  const loader = loaderFor(path);
  const docs = await loader.load(path);
  return ingestDocuments(normalizeSource(path), docs, opts);
}

/** 从内存 Buffer 入库一份文档（Web 上传场景），返回写入的分块数。幂等。 */
export async function ingestBuffer(
  name: string,
  data: Uint8Array,
  opts: IngestOptions,
): Promise<number> {
  const loader = loaderForName(name);
  const docs = await loader.loadBuffer(name, data);
  return ingestDocuments(normalizeSource(name), docs, opts);
}

async function ingestDocuments(
  source: string,
  docs: Document[],
  opts: IngestOptions,
): Promise<number> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: opts.chunkSize ?? 500,
    chunkOverlap: opts.chunkOverlap ?? 50,
    separators: ["\n\n", "\n", "。", "！", "？", ". ", " "],
  });
  const chunks = await splitter.splitDocuments(docs);
  opts.store.removeBySource(source); // 幂等重灌
  if (chunks.length === 0) return 0;

  const contents = chunks.map((c) => c.pageContent);
  const vectors = opts.embeddings
    ? await opts.embeddings.embedDocuments(contents)
    : contents.map(() => new Float32Array(0));

  const rows = chunks.map((c, i) => ({
    chunk: { id: sha1(`${source}:${i}`), source, chunkIndex: i, content: c.pageContent } as Chunk,
    vector: Float32Array.from(vectors[i] ?? []),
  }));
  for (const { chunk, vector } of rows) {
    opts.store.insert(chunk, vector);
  }
  return chunks.length;
}

/** 归一化 source 为文件名，避免绝对路径写入元数据。 */
function normalizeSource(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 便捷组合：批量路径入库并返回统计。 */
export async function ingestMany(
  paths: string[],
  opts: IngestOptions,
): Promise<IngestResult> {
  let total = 0;
  for (const p of paths) {
    total += await ingestPath(p, opts);
  }
  return { files: paths.length, chunks: total, sources: opts.store.listSources() };
}
