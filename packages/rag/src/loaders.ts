import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import type { DocumentLoader } from "./types.js";

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

/** PDF 加载器（@langchain/community PDFLoader，基于 pdfjs）。 */
export class PdfFileLoader implements DocumentLoader {
  async load(path: string): Promise<Document[]> {
    const loader = new PDFLoader(path);
    return loader.load();
  }

  async loadBuffer(name: string, data: Uint8Array): Promise<Document[]> {
    const loader = new PDFLoader(new Blob([data.buffer as ArrayBuffer], { type: "application/pdf" }));
    const docs = await loader.load();
    for (const d of docs) {
      d.metadata.source = name;
      d.metadata.type = "pdf";
    }
    return docs;
  }
}

export function loaderFor(path: string): DocumentLoader {
  return extname(path).toLowerCase() === ".pdf" ? new PdfFileLoader() : new TextFileLoader();
}

export function loaderForName(name: string): DocumentLoader {
  return extname(name).toLowerCase() === ".pdf" ? new PdfFileLoader() : new TextFileLoader();
}
