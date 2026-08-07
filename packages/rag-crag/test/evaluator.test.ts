import { test } from "node:test";
import assert from "node:assert/strict";
import { HeuristicRetrievalEvaluator, extractKeywords } from "../src/heuristic.js";
import { KnowledgeRefiner } from "../src/refine.js";
import { splitStrips } from "../src/evaluator.js";
import type { EvidenceChunk, RetrievalEvidence } from "../src/types.js";

function chunk(content: string, source = "a.txt", chunkIndex = 0): EvidenceChunk {
  return { source, chunkIndex, content };
}

function evidence(chunks: EvidenceChunk[], domain = "block"): RetrievalEvidence {
  return { domain, chunks };
}

test("extractKeywords 提取英文与中文关键词", () => {
  const kws = extractKeywords("OpenAI 发布新产品 2024");
  assert.ok(kws.includes("openai"));
  assert.ok(kws.includes("发布"));
  assert.ok(kws.includes("产品"));
});

test("splitStrips 按中文句读切分", () => {
  const strips = splitStrips(chunk("第一句。第二句！第三句；第四句"));
  assert.equal(strips.length, 4);
  assert.equal(strips[0]!.text, "第一句。");
});

test("启发式:命中数不足判 incorrect", async () => {
  const e = new HeuristicRetrievalEvaluator({ minHits: 2 });
  const result = await e.evaluate("查询词A", [evidence([chunk("无相关内容")])]);
  assert.equal(result.assessment, "incorrect");
});

test("启发式:覆盖率低判 incorrect、中等 ambiguous、高 correct", async () => {
  const e = new HeuristicRetrievalEvaluator();
  const low = await e.evaluate("苹果 香蕉 橙子 西瓜", [evidence([chunk("今天天气很好")])]);
  assert.equal(low.assessment, "incorrect");
  const mid = await e.evaluate("苹果 香蕉 橙子 西瓜", [evidence([chunk("苹果和西瓜都是水果 今天天气好")])]);
  assert.equal(mid.assessment, "ambiguous");
  const high = await e.evaluate("苹果 香蕉 橙子 西瓜", [
    evidence([chunk("苹果 香蕉 橙子 西瓜 都是水果")]),
  ]);
  assert.equal(high.assessment, "correct");
});

test("启发式:条带按关键词标注相关性", async () => {
  const e = new HeuristicRetrievalEvaluator();
  const result = await e.evaluate("OpenAI 模型", [
    evidence([chunk("OpenAI 发布了新模型。今天天气很好。")]),
  ]);
  const strips = result.strips;
  assert.ok(strips[0]!.relevant);
  assert.ok(!strips[1]!.relevant);
});

test("KnowledgeRefiner 过滤无关条带并带引用重组", () => {
  const refiner = new KnowledgeRefiner();
  const strips = splitStrips(chunk("相关句A。无关句B。相关句C。", "doc.txt", 2)).map((s, i) => ({
    ...s,
    relevant: i !== 1,
  }));
  const text = refiner.recompose(strips);
  assert.match(text, /相关句A/);
  assert.doesNotMatch(text, /无关句B/);
  assert.match(text, /相关句C/);
  assert.match(text, /【来源: doc.txt · 第3段】/);
  assert.equal(refiner.citations(strips).length, 2);
});

test("KnowledgeRefiner 无相关条带返回空串", () => {
  const refiner = new KnowledgeRefiner();
  const strips = splitStrips(chunk("全部无关"), "x", 0).map((s) => ({ ...s, relevant: false }));
  assert.equal(refiner.recompose(strips), "");
});
