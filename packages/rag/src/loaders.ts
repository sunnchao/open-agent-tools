import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import type { DocumentLoader } from "./types.js";
import {
  cleanOcrText,
  DEFAULT_OCR_DECISION,
  isLikelyScanned,
  normalizeOcrDecision,
  totalTextLength,
  type OcrDecision,
  type OcrProvider,
} from "./ocr.js";
import { NoopOcrProvider } from "./ocr.js";

/** 纯文本 / Markdown 加载器。 */
export class TextFileLoader implements DocumentLoader {
  async load(path: string): Promise<Document[]> {
    const text = await readFile(path, "utf-8");
    return [
      {
        pageContent: text,
        metadata: { source: basename(path), type: textKind(path) },
      },
    ];
  }

  async loadBuffer(name: string, data: Uint8Array): Promise<Document[]> {
    const text = Buffer.from(data).toString("utf-8");
    return [{ pageContent: text, metadata: { source: name, type: textKind(name) } }];
  }
}

/** 按扩展名标记文本类型，供切分器选择结构感知策略。 */
function textKind(name: string): "markdown" | "text" {
  return /\.(md|markdown)$/i.test(name) ? "markdown" : "text";
}

/** PDF 加载器（@langchain/community PDFLoader，基于 pdfjs）。文本层优先，疑似扫描时走 OCR 兜底。 */
export class PdfFileLoader implements DocumentLoader {
  private ocr: OcrProvider;
  private ocrDecision: OcrDecision;

  constructor(options: { ocr?: OcrProvider; ocrDecision?: Partial<OcrDecision> } = {}) {
    this.ocr = options.ocr ?? new NoopOcrProvider();
    this.ocrDecision = normalizeOcrDecision(options.ocrDecision);
  }

  async load(path: string): Promise<Document[]> {
    const loader = new PDFLoader(path);
    const fast = await loader.load();
    const source = fast[0]?.metadata?.source ? String(fast[0].metadata.source) : basename(path);
    for (const d of fast) {
      d.metadata.source = source;
      d.metadata.type = "pdf";
    }
    // 路径入库同样支持 OCR：需读原文件供 Provider 使用。
    try {
      const data = await readFile(path);
      return await this.withOcrFallback(source, fast, new Uint8Array(data));
    } catch {
      return this.tagFastDocs(source, fast);
    }
  }

  async loadBuffer(name: string, data: Uint8Array): Promise<Document[]> {
    const loader = new PDFLoader(new Blob([data.buffer as ArrayBuffer], { type: "application/pdf" }));
    const fast = await loader.load();
    return this.withOcrFallback(name, fast, data);
  }

  private tagFastDocs(source: string, fast: Document[]): Document[] {
    for (const d of fast) {
      d.metadata.source = source;
      d.metadata.type = "pdf";
      d.metadata.ocr = false;
    }
    return fast;
  }

  /**
   * 文本层优先、OCR 兜底：
   * - 平均每页字符数 >= 阈值 → 直接返回文本层（原生路径零变化）；
   * - 疑似扫描但 OCR 未启用/无结果 → 返回文本层并标记 ocrNeeded（上层报可诊断错误）；
   * - OCR 启用且有结果 → 按页合并（原生足够的页保留原生，否则用清洗后 OCR 文本）。
   */
  private async withOcrFallback(source: string, fast: Document[], data: Uint8Array): Promise<Document[]> {
    const tagged = this.tagFastDocs(source, fast);
    const pages = tagged.length > 0 ? tagged.length : 1;
    const textLen = totalTextLength(tagged);
    if (!isLikelyScanned(textLen, pages, this.ocrDecision.minCharsPerPage)) return tagged;
    if (!this.ocrDecision.enabled) {
      for (const d of tagged) d.metadata.ocrNeeded = true;
      return tagged;
    }
    if (pages > this.ocrDecision.maxPagesSync) {
      throw new Error(
        `too many scanned pages for sync ingest (${pages}>${this.ocrDecision.maxPagesSync}), please split the PDF or wait for async OCR tasks`,
      );
    }
    let ocrPages: Array<{ pageNumber: number; text: string; confidence: number }> = [];
    try {
      ocrPages = await this.ocr.extract(data);
    } catch (error) {
      for (const d of tagged) {
        d.metadata.ocrNeeded = true;
        d.metadata.ocrError = error instanceof Error ? error.message : String(error);
      }
      return tagged;
    }
    if (ocrPages.length === 0) {
      for (const d of tagged) d.metadata.ocrNeeded = true;
      return tagged;
    }
    const ocrByPage = new Map<number, string>();
    for (const p of ocrPages) {
      const cleaned = cleanOcrText(p.text);
      if (cleaned) ocrByPage.set(p.pageNumber, cleaned);
    }
    const total = Math.max(tagged.length, ocrPages.length);
    const out: Document[] = [];
    for (let i = 0; i < total; i++) {
      const fastText = (tagged[i]?.pageContent ?? "").trim();
      const ocrText = ocrByPage.get(i + 1) ?? "";
      const useOcr = fastText.length < this.ocrDecision.minCharsPerPage && ocrText.length > 0;
      out.push({
        pageContent: useOcr ? ocrText : fastText,
        metadata: {
          source,
          type: "pdf",
          ocr: useOcr,
          ocrNeeded: !useOcr && fastText.length === 0 && ocrText.length === 0,
          pageNumber: i + 1,
          loc: { pageNumber: i + 1 },
        },
      });
    }
    return out;
  }
}

export function loaderFor(path: string, ocrOptions?: { ocr?: OcrProvider; ocrDecision?: Partial<OcrDecision> }): DocumentLoader {
  return extname(path).toLowerCase() === ".pdf" ? new PdfFileLoader(ocrOptions ?? {}) : new TextFileLoader();
}

export function loaderForName(name: string, ocrOptions?: { ocr?: OcrProvider; ocrDecision?: Partial<OcrDecision> }): DocumentLoader {
  return extname(name).toLowerCase() === ".pdf" ? new PdfFileLoader(ocrOptions ?? {}) : new TextFileLoader();
}

export { DEFAULT_OCR_DECISION };
