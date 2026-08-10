import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LlmGraphExtractor,
  RuleGraphExtractor,
  extractJson,
  extractCandidateNames,
  splitSentences,
} from "../src/extract.js";

const chunk = { id: "doc:0", source: "doc.txt", chunkIndex: 0, content: "OpenAI 依赖 Azure 提供云计算资源。" };

test("extractJson 容忍代码块与前后噪声", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson("prefix {\"a\":1} suffix"), { a: 1 });
  assert.equal(extractJson("no json here"), null);
});

test("LlmGraphExtractor 解析 LLM 三元组输出", async () => {
  const llm = new LlmGraphExtractor(async () =>
    JSON.stringify({
      entities: [
        { name: "OpenAI", type: "org", props: { 总部: "旧金山" } },
        { name: "Azure", type: "tech", props: {} },
      ],
      relations: [{ subject: "OpenAI", predicate: "depends_on", object: "Azure" }],
    }),
  );
  const result = await llm.extract(chunk);
  assert.equal(result.entities.length, 2);
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0]!.relType, "depends_on");
  assert.equal(result.relations[0]!.srcId, result.entities.find((e) => e.name === "openai")!.id);
  assert.equal(result.entities[0]!.props["总部"], "旧金山");
});

test("LlmGraphExtractor 未知类型回退 concept、未知谓词回退 related_to", async () => {
  const llm = new LlmGraphExtractor(async () =>
    JSON.stringify({
      entities: [
        { name: "Foo", type: "mystery" },
        { name: "Bar", type: "org" },
      ],
      relations: [{ subject: "Foo", predicate: "unknown_pred", object: "Bar" }],
    }),
  );
  const result = await llm.extract(chunk);
  assert.equal(result.entities.find((e) => e.name === "foo")!.type, "concept");
  assert.equal(result.relations[0]!.relType, "related_to");
});

test("LlmGraphExtractor 实体去重（同规范化名只保留一个）", async () => {
  const llm = new LlmGraphExtractor(async () =>
    JSON.stringify({
      entities: [
        { name: "OpenAI", type: "org", props: {} },
        { name: "openai", type: "org", props: {} },
      ],
      relations: [],
    }),
  );
  const result = await llm.extract(chunk);
  assert.equal(result.entities.length, 1);
});

test("RuleGraphExtractor 离线回退抽取候选实体与共现边", async () => {
  const rule = new RuleGraphExtractor();
  const result = await rule.extract({
    id: "c:0",
    source: "t.txt",
    chunkIndex: 0,
    content: "OpenAI 与 Anthropic 都是 AI 公司。",
  });
  assert.ok(result.entities.length >= 2);
  assert.ok(result.relations.length > 0);
  assert.ok(result.relations.every((r) => r.relType === "related_to"));
  assert.ok(result.entities.some((e) => e.name === "openai"));
  assert.ok(result.entities.some((e) => e.name === "anthropic"));
});

test("RuleGraphExtractor 句内共现建边,跨句不建边", async () => {
  const rule = new RuleGraphExtractor();
  const result = await rule.extract({
    id: "c:0",
    source: "t.txt",
    chunkIndex: 0,
    content: "OpenAI 发布 GPT-5。Azure 提供云计算资源。",
  });
  // OpenAI 与 GPT 同句 → 有边；OpenAI 与 Azure 跨句 → 无边
  const hasEdge = (a: string, b: string) =>
    result.relations.some(
      (r) =>
        (r.srcId === a && r.dstId === b) || (r.srcId === b && r.dstId === a),
    );
  assert.ok(hasEdge(result.entities.find((e) => e.name === "openai")!.id, result.entities.find((e) => e.name === "gpt")!.id));
  assert.ok(!hasEdge(result.entities.find((e) => e.name === "openai")!.id, result.entities.find((e) => e.name === "azure")!.id));
});

test("RuleGraphExtractor 不产出滑窗残词", async () => {
  const rule = new RuleGraphExtractor();
  const result = await rule.extract({
    id: "c:0",
    source: "t.txt",
    chunkIndex: 0,
    content: "Azure 提供云计算资源给客户。",
  });
  // 7 字长串"提供云计算资源"应被整块跳过,不产生"提供云计算资"残词
  assert.ok(!result.entities.some((e) => e.name.includes("提供云计算资")));
});

test("splitSentences 按句读切分", () => {
  const sentences = splitSentences("第一句。第二句！第三句");
  assert.deepEqual(sentences, ["第一句。", "第二句！", "第三句"]);
});

test("extractCandidateNames 提取英文大写词与中文短语", () => {
  const names = extractCandidateNames("OpenAI 依赖 Azure 云计算");
  assert.ok(names.includes("OpenAI"));
  assert.ok(names.includes("Azure"));
  assert.ok(names.some((n) => n.includes("云计算")));
});

test("extractCandidateNames 过滤停用词与长串", () => {
  const names = extractCandidateNames("提供 支持 使用 云计算资源给客户");
  assert.ok(!names.some((n) => n.includes("提供") || n.includes("支持") || n.includes("使用")));
  assert.ok(names.every((n) => n.length <= 6));
});
