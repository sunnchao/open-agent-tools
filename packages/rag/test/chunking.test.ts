import { test } from "node:test";
import assert from "node:assert/strict";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { Document } from "@langchain/core/documents";
import { chunkDocuments, DEFAULT_SEPARATORS } from "../src/chunking.js";

function doc(text: string, name: string, type?: string): Document {
  return { pageContent: text, metadata: { source: name, ...(type ? { type } : {}) } };
}

function opts(partial: Partial<Parameters<typeof chunkDocuments>[1]> = {}) {
  return { chunkSize: 500, chunkOverlap: 0, separators: [...DEFAULT_SEPARATORS], ...partial };
}

/** 话题可控的假 embedding：含「苹果」→ 话题 A，「篮球」→ 话题 B。 */
class TopicEmbeddings implements EmbeddingsInterface {
  model = "topic";
  async embedDocuments(docs: string[]): Promise<number[][]> {
    return docs.map((d) => {
      if (d.includes("苹果")) return [1, 0, 0];
      if (d.includes("篮球")) return [0, 1, 0];
      return [0, 0, 0];
    });
  }
  async embedQuery(query: string): Promise<number[]> {
    const [v] = await this.embedDocuments([query]);
    return v ?? [];
  }
}

test("txt 结构切分：句子边界不腰斩 + 每块不超 chunkSize", async () => {
  const text = "第一句。第二句。第三句。第四句。第五句。";
  const chunks = await chunkDocuments([doc(text, "note.txt", "text")], opts({ chunkSize: 12 }));
  assert.ok(chunks.length >= 2, "应切成多块");
  for (const c of chunks) {
    assert.ok(c.content.length <= 12, `块超长: ${c.content}`);
    // 边界应在句读处：除最后一块外均以中文句号收尾
    assert.ok(/[。！？]$/.test(c.content), `句子被腰斩: ${c.content}`);
  }
  // 无内容丢失
  assert.ok(chunks.map((c) => c.content).join("").includes("第一句。"));
  assert.ok(chunks.map((c) => c.content).join("").includes("第五句。"));
});

test("txt 超长句硬切：内容完整还原且每块 ≤ chunkSize", async () => {
  const text = "这是一个非常长的没有标点的连续句子内容段啊第二部分";
  const chunks = await chunkDocuments([doc(text, "long.txt", "text")], opts({ chunkSize: 10 }));
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.content.length <= 10));
  assert.equal(chunks.map((c) => c.content).join(""), text, "硬切不应丢字");
});

test("markdown 结构切分：标题为块首锚点、无内容丢失", async () => {
  const md = `# 第一章 概述
这是第一章的内容。讲安装部署。

## 环境要求
需要 CPU 4 核。内存 16G。

# 第二章 使用
本章讲日常使用。操作步骤说明。`;
  const chunks = await chunkDocuments([doc(md, "guide.md", "markdown")], opts({ chunkSize: 60 }));
  assert.ok(chunks.length > 1, "chunkSize 小应切开");
  // 标题不夹在块中间：含标题的块都以标题开头（语义场景锚点完整）
  for (const c of chunks.filter((c) => c.content.includes("#"))) {
    assert.ok(/^\s*#/.test(c.content), `标题未处于块首: ${c.content}`);
  }
  // 每个章节标题都保留
  const all = chunks.map((c) => c.content).join("");
  for (const heading of ["# 第一章 概述", "## 环境要求", "# 第二章 使用"]) {
    assert.ok(all.includes(heading), `标题丢失: ${heading}`);
  }
});

test("PDF 多页合并：页边界不再是硬边界", async () => {
  const pages = [
    doc("第一页开头内容。", "doc.pdf", "pdf"),
    doc("第二页延续内容。", "doc.pdf", "pdf"),
  ];
  const chunks = await chunkDocuments(pages, opts({ chunkSize: 200 }));
  assert.equal(chunks.length, 1, "两页内容应合并到同一 chunk");
  assert.ok(chunks[0]!.content.includes("第一页"));
  assert.ok(chunks[0]!.content.includes("第二页"));
});

test("语义切分：话题切换处断块", async () => {
  const text = "苹果种植技术要点。苹果施肥方法总结。篮球比赛基本规则。篮球训练注意事项。";
  const chunks = await chunkDocuments(
    [doc(text, "topics.txt", "text")],
    opts({ chunkSize: 200, embeddings: new TopicEmbeddings() }),
  );
  assert.equal(chunks.length, 2, "苹果/篮球两个话题应切成两块");
  assert.ok(chunks[0]!.content.includes("苹果"));
  assert.ok(chunks[1]!.content.includes("篮球"));
});

test("语义切分 overlap：新块以上一句开头衔接", async () => {
  const text = "苹果种植技术要点。苹果施肥方法总结。篮球比赛基本规则。篮球训练注意事项。";
  const chunks = await chunkDocuments(
    [doc(text, "topics.txt", "text")],
    opts({ chunkSize: 200, chunkOverlap: 100, embeddings: new TopicEmbeddings() }),
  );
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1]!.content.startsWith("苹果施肥方法总结。"), "新块应复用上一句做语义衔接");
});

test("无 embeddings 回退 L1：仅按长度合并", async () => {
  const text = "苹果种植技术要点。苹果施肥方法总结。篮球比赛基本规则。篮球训练注意事项。";
  const chunks = await chunkDocuments(
    [doc(text, "topics.txt", "text")],
    opts({ chunkSize: 200 }),
  );
  assert.equal(chunks.length, 1, "无 embedding 时不做话题切分");
});

test("自定义 separators 回退旧版切分行为", async () => {
  const chunks = await chunkDocuments(
    [doc("alpha|bravo|charlie", "separators.txt", "text")],
    opts({ chunkSize: 8, separators: ["|"] }),
  );
  assert.deepEqual(
    chunks.map((c) => c.content),
    ["alpha", "|bravo", "|charlie"],
  );
});

test("语义阈值可调：阈值越高切得越碎", async () => {
  // 两句话的 embedding 相似度恰为 0.6，夹在 0.5 与 0.8 两个阈值之间
  const text = "A 段主题内容。B 段相邻内容。";
  class FixedSim implements EmbeddingsInterface {
    model = "fixed";
    async embedDocuments(docs: string[]): Promise<number[][]> {
      return docs.map((d) => (d.startsWith("A") ? [1, 0] : [0.6, 0.8]));
    }
    async embedQuery(query: string): Promise<number[]> {
      const [v] = await this.embedDocuments([query]);
      return v ?? [];
    }
  }
  const loose = await chunkDocuments(
    [doc(text, "t.txt", "text")],
    opts({ chunkSize: 200, embeddings: new FixedSim(), semanticThreshold: 0.5 }),
  );
  assert.equal(loose.length, 1, "低阈值允许弱相关句合并");
  const tight = await chunkDocuments(
    [doc(text, "t.txt", "text")],
    opts({ chunkSize: 200, embeddings: new FixedSim(), semanticThreshold: 0.8 }),
  );
  assert.ok(tight.length >= 2, "高阈值在弱相关处断开");
});
