import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { Document } from "@langchain/core/documents";
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { ChunkStrategy } from "./types.js";
import { cosine } from "./utils.js";

/** 默认递归切分分隔符（按优先级）。句读标点同时作为「语义单元」的边界。 */
export const DEFAULT_SEPARATORS = ["\n\n", "\n", "。", "！", "？", ". ", " "] as const;

export interface ChunkingOptions {
  chunkSize: number;
  chunkOverlap: number;
  separators: readonly string[];
  /** 显式选择固定/结构切分或基于 embedding 相似度的语义切分。 */
  strategy?: ChunkStrategy;
  embeddings?: EmbeddingsInterface;
  /** L2 相似度阈值（0-1），低于此值判定话题切换而断块。默认 0.75。 */
  semanticThreshold?: number;
}

interface Segment {
  unit: string;
  /** 该 unit 与后一个 unit 之间的拼接符（"" / 空格 / "\n"），用于还原原文。 */
  joiner: string;
}

const EMPTY_EMBEDDING: number[] = [];

/**
 * 固定模式保持原结构切分；语义模式把文本拆成句/段，用相邻 embedding 相似度识别话题边界。
 * strategy 缺省时保留旧调用行为：有 embeddings 走语义，否则走固定。
 */
export async function chunkDocuments(
  docs: Document[],
  opts: ChunkingOptions,
): Promise<Array<{ content: string }>> {
  const strategy = opts.strategy ?? (opts.embeddings ? "semantic" : "fixed");
  const merged = mergePdfPages(docs);
  if (strategy === "semantic") {
    if (!opts.embeddings) throw new Error("semantic chunking requires embeddings");
    const out: Array<{ content: string }> = [];
    for (const doc of merged) out.push(...(await semanticSplit(doc.pageContent, opts)));
    return out;
  }

  if (!arraysEqual(opts.separators, DEFAULT_SEPARATORS)) {
    return legacySplit(docs, opts);
  }

  const out: Array<{ content: string }> = [];
  for (const doc of merged) {
    if (isMarkdown(doc)) {
      const splitter = new MarkdownTextSplitter({
        chunkSize: opts.chunkSize,
        chunkOverlap: opts.chunkOverlap,
      });
      const chunks = await splitter.splitDocuments([doc]);
      out.push(...chunks.map((c) => ({ content: c.pageContent })));
    } else {
      out.push(...structuralSplit(doc.pageContent, opts));
    }
  }
  return out;
}

/** 向后兼容：自定义 separators 时保持原 RecursiveCharacterTextSplitter 行为。 */
async function legacySplit(
  docs: Document[],
  opts: ChunkingOptions,
): Promise<Array<{ content: string }>> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: opts.chunkSize,
    chunkOverlap: opts.chunkOverlap,
    separators: [...opts.separators],
  });
  const chunks = await splitter.splitDocuments(docs);
  return chunks.map((c) => ({ content: c.pageContent }));
}

/** L2：段落/句子单元 + embedding 相似度悬崖断块。 */
async function semanticSplit(
  text: string,
  opts: ChunkingOptions,
): Promise<Array<{ content: string }>> {
  const segments = segmentText(text);
  const units = splitLongUnits(segments, opts.chunkSize);
  if (units.length === 0) return [];
  if (units.length === 1) {
    return assembleUnits(units, opts).map((content) => ({ content }));
  }

  const threshold = opts.semanticThreshold ?? 0.75;
  const vectors = await opts.embeddings!.embedDocuments(units.map((s) => s.unit));
  const chunks: string[] = [];
  let cur = "";
  for (let i = 0; i < units.length; i++) {
    const seg = units[i]!;
    if (cur && i > 0) {
      const sim = cosine(
        Float32Array.from(vectors[i - 1] ?? EMPTY_EMBEDDING),
        Float32Array.from(vectors[i] ?? EMPTY_EMBEDDING),
      );
      const tooBig = cur.length + (cur ? seg.joiner.length : 0) + seg.unit.length > opts.chunkSize;
      if (tooBig || sim < threshold) {
        chunks.push(cur);
        // 单元级 overlap：重复上一个 unit（一句话），比字符 overlap 更有语义衔接
        cur = opts.chunkOverlap > 0 ? units[i - 1]!.unit : "";
      }
    }
    cur = cur ? cur + seg.joiner + seg.unit : seg.unit;
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length > 0).map((content) => ({ content }));
}

/** L1：段落/句子单元按长度贪心合并，段落不腰斩、超长段落在句读处切。 */
function structuralSplit(text: string, opts: ChunkingOptions): Array<{ content: string }> {
  const units = splitLongUnits(segmentText(text), opts.chunkSize);
  return assembleUnits(units, opts)
    .filter((c) => c.trim().length > 0)
    .map((content) => ({ content }));
}

/** 将单元按长度贪心合并为 chunk，overlap 复用上一块末尾字符。 */
function assembleUnits(units: Segment[], opts: ChunkingOptions): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const seg of units) {
    const nextLen = cur.length + (cur ? seg.joiner.length : 0) + seg.unit.length;
    if (cur && nextLen > opts.chunkSize) {
      chunks.push(cur);
      cur = opts.chunkOverlap > 0 ? cur.slice(-opts.chunkOverlap) : "";
    }
    cur = cur ? cur + seg.joiner + seg.unit : seg.unit;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 把文本切成最小语义单元（句子/短行）。
 * 中文句号/叹号/问号后切（保留标点），英文句点/分号后切（保留句点），换行处切（joiner="\n" 还原段落）。
 */
function segmentText(text: string): Segment[] {
  const result: Segment[] = [];
  // 先按换行分块，保留段落信息
  const parts = text.split(/(\r?\n+)/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 1) {
      // 换行分隔符：把段落边界记到上一个 unit 的 joiner 上
      const prev = result[result.length - 1];
      if (prev) prev.joiner = "\n";
      continue;
    }
    if (!part) continue;
    // 段内按句读切（lookbehind 保留尾部标点）
    const sentences = part.split(/(?<=[。！？!?])\s*|(?<=[.;])\s+/);
    for (const s of sentences) {
      if (!s) continue;
      result.push({ unit: s, joiner: /[。！？]$/.test(s) ? "" : /[.;]$/.test(s) ? " " : "" });
    }
  }
  return result;
}

/** 超长单元（一句话超 chunkSize）硬切为 ≤ chunkSize 的片段，保证 chunk 不越界。 */
function splitLongUnits(segments: Segment[], chunkSize: number): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.unit.length <= chunkSize) {
      out.push(seg);
      continue;
    }
    for (let i = 0; i < seg.unit.length; i += chunkSize) {
      out.push({ unit: seg.unit.slice(i, i + chunkSize), joiner: seg.joiner });
    }
  }
  return out;
}

/** PDF 按页返回多个 document，页边界不是语义边界——合并后再切，overlap 可跨页衔接。 */
function mergePdfPages(docs: Document[]): Document[] {
  if (docs.length <= 1) return docs;
  const first = docs[0]!;
  return [
    {
      pageContent: docs.map((d) => d.pageContent).join("\n\n"),
      metadata: { ...first.metadata },
    },
  ];
}

function isMarkdown(doc: Document): boolean {
  const src = (doc.metadata?.source as string | undefined) ?? "";
  return doc.metadata?.type === "markdown" || /\.(md|markdown)$/i.test(src);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
