import { test } from "node:test";
import assert from "node:assert/strict";
import { reciprocalRankFusion, formatChunks } from "../src/retriever.js";
import { escapeFtsQuery } from "../src/utils.js";
import type { ScoredChunk } from "../src/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rag } from "../src/index.js";

function hit(id: string, score: number): ScoredChunk {
  return { id, source: "a.txt", chunkIndex: 0, content: id, score };
}

test("RRF：只看排名，融合两个列表", () => {
  const listA = [hit("d1", 9), hit("d2", 8), hit("d3", 7)];
  const listB = [hit("d3", 0.1), hit("d1", 0.05)];
  const merged = reciprocalRankFusion([listA, listB], 60);
  // d1: 1/61 + 1/62 > d3: 1/63 + 1/61 > d2: 1/62
  assert.deepEqual(
    merged.map((m) => m.id),
    ["d1", "d3", "d2"],
  );
  assert.ok(merged[0]!.score > merged[1]!.score);
});

test("RRF：单列表等价于保序（k 不影响相对顺序）", () => {
  const listA = [hit("x", 1), hit("y", 0.5), hit("z", 0.1)];
  const merged = reciprocalRankFusion([listA], 1);
  assert.deepEqual(
    merged.map((m) => m.id),
    ["x", "y", "z"],
  );
});

test("escapeFtsQuery 转义 FTS5 语法字符 + CJK 单字切分", () => {
  // 中文按单字切分（unicode61 分词兼容），ASCII 词保持原样
  assert.equal(escapeFtsQuery('"CPU" 内存(8G)'), '"CPU" "内" "存" "8G"');
  assert.equal(escapeFtsQuery("  多  空格  "), '"多" "空" "格"');
  assert.equal(escapeFtsQuery(""), "");
});

test("formatChunks 输出带引用格式", () => {
  const text = formatChunks([
    { id: "x", source: "部署说明.pdf", chunkIndex: 2, content: "正文", score: 1 },
  ]);
  assert.ok(text.includes("【来源: 部署说明.pdf · 第3段】"));
  assert.ok(text.includes("正文"));
});

test("formatChunks 空结果返回空串", () => {
  assert.equal(formatChunks([]), "");
});

test("文档 ACL：viewerGroups 只能拿到公开与命中文档", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-acl-"));
  const rag = new Rag({ dbPath: join(dir, "rag.db") });
  try {
    await rag.ingestBuffers([
      { name: "public.md", data: new TextEncoder().encode("员工年假标准。") },
      { name: "hr.md", data: new TextEncoder().encode("HR 薪酬带宽。") },
      { name: "finance.md", data: new TextEncoder().encode("财务预算流程。") },
    ]);
    await rag.updateDocument("hr.md", { allowedGroups: ["hr"] });
    await rag.updateDocument("finance.md", { allowedGroups: ["finance"] });

    const hrOnly = await rag.retrieve("标准 流程 带宽", {
      topK: 10,
      viewerGroups: ["hr"],
    });
    const sources = new Set(hrOnly.chunks.map((chunk) => chunk.source));
    assert.ok(sources.has("public.md"));
    assert.ok(sources.has("hr.md"));
    assert.ok(!sources.has("finance.md"), "未授权分组不能进入检索结果");

    const anonymous = await rag.retrieve("标准 流程 带宽", {
      topK: 10,
      viewerGroups: [],
    });
    assert.deepEqual([...new Set(anonymous.chunks.map((chunk) => chunk.source))], ["public.md"]);

    const admin = await rag.retrieve("标准 流程 带宽", { topK: 10 });
    assert.ok(admin.chunks.some((chunk) => chunk.source === "finance.md"));
  } finally {
    await rag.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
