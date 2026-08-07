import { test } from "node:test";
import assert from "node:assert/strict";
import { CragController } from "../src/controller.js";
import { HeuristicRetrievalEvaluator } from "../src/heuristic.js";
import type { RetrievalDomain, RetrievalEvidence } from "../src/types.js";

/** 内存 block 域：返回预置命中，用于模拟相关/无关检索。 */
function blockDomain(hits: Array<{ content: string; source?: string }>): RetrievalDomain {
  return {
    name: "block",
    async retrieve(_query): Promise<RetrievalEvidence> {
      return {
        domain: "block",
        chunks: hits.map((h, i) => ({ source: h.source ?? "a.txt", chunkIndex: i, content: h.content })),
      };
    },
  };
}

function graphDomain(): RetrievalDomain {
  return {
    name: "graph",
    async retrieve(query): Promise<RetrievalEvidence> {
      return {
        domain: "graph",
        chunks:
          query.includes("图谱")
            ? [{ source: "[图谱]", chunkIndex: 0, content: "实体A --depends_on--> 实体B" }]
            : [],
      };
    },
  };
}

test("correct 时直接精炼注入", async () => {
  const crag = new CragController({
    evaluator: new HeuristicRetrievalEvaluator(),
    domains: [blockDomain([{ content: "苹果 香蕉 橙子 西瓜 都是水果。" }])],
  });
  const result = await crag.retrieve("苹果 香蕉 橙子 西瓜");
  assert.equal(result.assessment, "correct");
  assert.match(result.formatted, /水果/);
  assert.deepEqual(result.actions, ["block-rag"]);
});

test("incorrect 时触发纠正链并如实声明", async () => {
  const crag = new CragController({
    evaluator: new HeuristicRetrievalEvaluator(),
    domains: [blockDomain([{ content: "今天天气很好。" }])],
    maxRetries: 1,
  });
  const result = await crag.retrieve("苹果 香蕉 橙子 西瓜 都是什么");
  assert.equal(result.assessment, "incorrect");
  assert.equal(result.formatted, "");
  assert.ok(result.actions.includes("declared-uncovered"));
});

test("incorrect 时 rewrite-retry 能救回", async () => {
  let calls = 0;
  const domain: RetrievalDomain = {
    name: "block",
    async retrieve(query): Promise<RetrievalEvidence> {
      calls += 1;
      // 第一次返回无关；改写后的查询（含关键词）返回相关
      return {
        domain: "block",
        chunks:
          calls === 1
            ? [{ source: "a.txt", chunkIndex: 0, content: "完全无关的内容。" }]
            : [{ source: "a.txt", chunkIndex: 0, content: "苹果 香蕉 橙子 西瓜 都是水果。" }],
      };
    },
  };
  const crag = new CragController({
    evaluator: new HeuristicRetrievalEvaluator(),
    domains: [domain],
  });
  const result = await crag.retrieve("苹果 香蕉 橙子 西瓜 都是什么");
  assert.ok(result.actions.includes("rewrite-retry"));
  assert.equal(result.assessment, "correct");
  assert.ok(calls >= 2);
});

test("ambiguous 时触发 graph 补充", async () => {
  const crag = new CragController({
    evaluator: new HeuristicRetrievalEvaluator(),
    domains: [blockDomain([{ content: "苹果和西瓜都是水果 今天天气好" }]), graphDomain()],
  });
  const result = await crag.retrieve("苹果 香蕉 橙子 西瓜 图谱");
  assert.ok(result.actions.includes("graph-supplement") || result.actions.includes("graph-domain"));
  assert.notEqual(result.assessment, "incorrect");
});

test("寒暄查询跳过检索", async () => {
  const crag = new CragController({
    evaluator: new HeuristicRetrievalEvaluator(),
    domains: [blockDomain([{ content: "苹果 香蕉 橙子 西瓜 都是水果。" }])],
  });
  const result = await crag.retrieve("你好");
  assert.ok(result.actions.includes("trigger-skipped"));
  assert.equal(result.formatted, "");
});

test("block 域缺失时构造报错", () => {
  assert.throws(
    () =>
      new CragController({
        evaluator: new HeuristicRetrievalEvaluator(),
        domains: [graphDomain()],
      }),
    /block/,
  );
});
