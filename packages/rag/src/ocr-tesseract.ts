import type { OcrPage, OcrProvider } from "./ocr.js";
import { cleanOcrText } from "./ocr.js";

/**
 * P1 本地 OCR 占位实现（tesseract.js）。
 *
 * 现状：为保持 `rag-server` 零原生依赖即跑，本包暂不硬依赖 `tesseract.js`，
 * 也不在 Node 侧做 PDF→图片渲染（需 canvas/poppler 原生链）。
 * 真实接入时在此类中实现：
 *   pdf bytes → 按页渲染为 PNG（pdfjs + canvas 或 poppler）→ tesseract 识别 → OcrPage[]
 *
 * 当前行为：构造成功但 `extract` 直接抛错，上层捕获后按 `ocr_failed` 处理，
 * 并提示安装可选依赖。单测/演示请用 `FakeOcrProvider`。
 */
export interface TesseractOcrOptions {
  langs?: string;
  modelPath?: string;
}

export class TesseractOcrProvider implements OcrProvider {
  readonly kind = "tesseract" as const;
  private langs: string;
  private modelPath?: string;

  constructor(options: TesseractOcrOptions = {}) {
    this.langs = options.langs?.trim() || "chi_sim+eng";
    this.modelPath = options.modelPath?.trim() || undefined;
  }

  getLanguages(): string {
    return this.langs;
  }

  async extract(_data: Uint8Array, _onProgress?: (done: number, total: number) => void): Promise<OcrPage[]> {
    throw new Error(
      `tesseract OCR not installed (langs=${this.langs}` +
        `${this.modelPath ? `, modelPath=${this.modelPath}` : ""}). ` +
        `Install optional dependency "tesseract.js" with PDF page rendering (canvas/poppler) ` +
        `or inject a custom OcrProvider; tests should use FakeOcrProvider.`,
    );
  }

  /** 清洗 helper 供调用方复用，保持与 Fake 路径一致的文本口径。 */
  clean(text: string): string {
    return cleanOcrText(text);
  }
}
