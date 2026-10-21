import type { Document } from "@langchain/core/documents";

/** OCR 单页结果。pageNumber 从 1 开始，与 pdfjs 的 loc.pageNumber 对齐。 */
export interface OcrPage {
  pageNumber: number;
  text: string;
  confidence: number;
}

/** OCR 提供方。P1 用 tesseract，P2 可换云/ocrmypdf，实现同接口替换即可。 */
export interface OcrProvider {
  readonly kind: "tesseract" | "cloud" | "custom" | "noop" | "fake";
  extract(data: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<OcrPage[]>;
}

/** OCR 决策参数。minCharsPerPage 低于此值判定为疑似扫描页。 */
export interface OcrDecision {
  enabled: boolean;
  /** 每页平均字符数阈值，默认 50。 */
  minCharsPerPage: number;
  /** 同步入库允许的最大扫描页数，超限走 413 限流（等 P2 异步任务）。默认 10。 */
  maxPagesSync: number;
}

export const DEFAULT_OCR_DECISION: OcrDecision = {
  enabled: false,
  minCharsPerPage: 50,
  maxPagesSync: 10,
};

/** 文档级 OCR 状态，与 documents.ocr_status 列一一对应。 */
export type OcrStatus = "none" | "text_layer" | "ocr" | "ocr_needed" | "ocr_failed";

export function normalizeOcrDecision(input?: Partial<OcrDecision>): OcrDecision {
  return {
    enabled: input?.enabled ?? DEFAULT_OCR_DECISION.enabled,
    minCharsPerPage: normalizePositiveInt(
      input?.minCharsPerPage,
      DEFAULT_OCR_DECISION.minCharsPerPage,
    ),
    maxPagesSync: normalizePositiveInt(input?.maxPagesSync, DEFAULT_OCR_DECISION.maxPagesSync),
  };
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored > 0 ? floored : fallback;
}

/**
 * 疑似扫描判定：按“全文字符数 / 页数”估算。
 * - pages<=0 时无法判定，返回 false（交给后续空内容错误）。
 * - 全空（textLen===0 且 pages>0）直接判定为疑似扫描，便于报可诊断错误。
 */
export function isLikelyScanned(textLen: number, pages: number, minCharsPerPage: number): boolean {
  if (!Number.isFinite(textLen) || !Number.isFinite(pages) || pages <= 0) return false;
  if (textLen <= 0) return true;
  const threshold = Number.isFinite(minCharsPerPage) ? minCharsPerPage : 50;
  return textLen / pages < threshold;
}

export function totalTextLength(docs: Array<Pick<Document, "pageContent">>): number {
  return docs.reduce((sum, d) => sum + (d.pageContent?.length ?? 0), 0);
}

/**
 * OCR 文本清洗：去连字符断行、合并被打碎的 CJK 行、归一空白，保留中日韩标点。
 * - \r\n 统一为 \n
 * - 英文连字符断行 `word-\nword` 还原为 `wordword`
 * - CJK 字符间的单个 \n 直接拼接（扫描换行碎行常见）
 * - 3+ 连续换行压为双换行（段落），2+ 空格压为单空格
 */
export function cleanOcrText(text: string): string {
  if (!text) return "";
  let out = text.replace(/\r\n?/g, "\n");
  // 英文连字符断行：hyphena-\ntion -> hyphenation
  out = out.replace(/([A-Za-z])-\n([A-Za-z])/g, "$1$2");
  // CJK 间的单个换行是碎行，直接拼接
  out = out.replace(/([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\n([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g, "$1$2");
  // 其余单个换行（非段落）转为空格，避免句子被硬切
  out = out.replace(/(?<!\n)\n(?!\n)/g, " ");
  // 归一空白与换行
  out = out.replace(/[ \t\f\v]+/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/** 未配置 OCR 时的空实现：extract 直接返回空数组，上层据此报 ocr_needed。 */
export class NoopOcrProvider implements OcrProvider {
  readonly kind = "noop" as const;
  async extract(_data: Uint8Array): Promise<OcrPage[]> {
    return [];
  }
}

/** 测试/演示用假 OCR：固定返回预置文本，不依赖原生模型与网络。 */
export class FakeOcrProvider implements OcrProvider {
  readonly kind = "fake" as const;
  constructor(private pages: string[] = []) {}
  async extract(_data: Uint8Array): Promise<OcrPage[]> {
    return this.pages.map((text, i) => ({
      pageNumber: i + 1,
      text: cleanOcrText(text),
      confidence: 1,
    }));
  }
}
