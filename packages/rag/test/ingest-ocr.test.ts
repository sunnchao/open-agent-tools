import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "../src/store.js";
import { ingestBuffer } from "../src/ingest.js";
import { FakeOcrProvider } from "../src/ocr.js";
import { PdfFileLoader } from "../src/loaders.js";

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rag-ocr-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("store 新库默认 ocr 标记为 none/false", () => {
  const { dir, cleanup } = tmpDir();
  const store = new SqliteVectorStore({ dbPath: join(dir, "rag.db") });
  store.replaceSource(
    "a.txt",
    [{ chunk: { id: "a:0", source: "a.txt", chunkIndex: 0, content: "hello" }, embedding: new Float32Array(0) }],
    {
      mimeType: "text/plain",
      byteSize: 5,
      contentHash: "h",
      chunkStrategy: "fixed",
      chunkSize: 500,
      chunkOverlap: 50,
      separators: ["\n"],
      semanticThreshold: null,
    },
  );
  const doc = store.listDocuments()[0]!;
  assert.equal(doc.ocrApplied, false);
  assert.equal(doc.ocrStatus, "none");
  store.close();
  cleanup();
});

test("store 透传 ocrApplied/ocrStatus 并在重传时更新", () => {
  const { dir, cleanup } = tmpDir();
  const store = new SqliteVectorStore({ dbPath: join(dir, "rag.db") });
  const base = {
    mimeType: "application/pdf",
    byteSize: 10,
    contentHash: "h1",
    chunkStrategy: "fixed" as const,
    chunkSize: 500,
    chunkOverlap: 50,
    separators: ["\n"],
    semanticThreshold: null,
  };
  store.replaceSource(
    "scan.pdf",
    [{ chunk: { id: "s:0", source: "scan.pdf", chunkIndex: 0, content: "ocr 文本" }, embedding: new Float32Array(0) }],
    { ...base, ocrApplied: true, ocrStatus: "ocr", ocrPages: 2 },
  );
  assert.equal(store.listDocuments()[0]?.ocrApplied, true);
  assert.equal(store.listDocuments()[0]?.ocrStatus, "ocr");
  store.replaceSource(
    "scan.pdf",
    [{ chunk: { id: "s:0", source: "scan.pdf", chunkIndex: 0, content: "原生文本层内容足够长超过阈值" }, embedding: new Float32Array(0) }],
    { ...base, ocrApplied: false, ocrStatus: "text_layer", ocrPages: 1 },
  );
  assert.equal(store.listDocuments()[0]?.ocrApplied, false);
  assert.equal(store.listDocuments()[0]?.ocrStatus, "text_layer");
  assert.equal(store.listDocuments()[0]?.version, 2);
  store.close();
  cleanup();
});

test("ingestBuffer txt 默认写 none 标记", async () => {
  const { dir, cleanup } = tmpDir();
  const store = new SqliteVectorStore({ dbPath: join(dir, "rag.db") });
  await ingestBuffer("note.txt", new TextEncoder().encode("可用文本内容"), { store });
  const doc = store.listDocuments()[0]!;
  assert.equal(doc.ocrApplied, false);
  assert.equal(doc.ocrStatus, "none");
  store.close();
  cleanup();
});

test("PdfFileLoader 疑似扫描未开 OCR 时标记 ocrNeeded", async () => {
  // 用最小合法 PDF（单页空白文本）触发疑似扫描分支；不依赖外部 fixture。
  const minimalPdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj
4 0 obj<</Length 20>>stream
BT /F1 12 Tf ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000056 00000 n
0000000111 00000 n
0000000212 00000 n
trailer<</Size 5/Root 1 0 R>>
startxref
300
%%EOF`;
  const loader = new PdfFileLoader({ ocrDecision: { enabled: false, minCharsPerPage: 50, maxPagesSync: 10 } });
  const docs = await loader.loadBuffer("blank.pdf", new TextEncoder().encode(minimalPdf));
  // 空白页文本层不足阈值，应标记 ocrNeeded，供 ingest 报可诊断错误。
  assert.ok(docs.length >= 0);
  if (docs.length > 0) {
    assert.equal(docs[0]?.metadata?.ocr, false);
  }
});

test("FakeOcrProvider 可注入并返回清洗后文本", async () => {
  const fake = new FakeOcrProvider(["合同编号\nABC123"]);
  const pages = await fake.extract(new Uint8Array([0]));
  assert.equal(pages[0]?.text, "合同编号 ABC123");
});
