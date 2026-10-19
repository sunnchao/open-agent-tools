import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { computeCaseResult, errorCaseResult, summarizeRun } from "./eval/metrics.js";
import { evalRouter } from "./eval/router.js";
import { EvalRunner, type RetrievalFn } from "./eval/runner.js";
import { EvalStore } from "./eval/store.js";
import type {
  EvalCaseResult,
  EvalDataset,
  EvalDatasetSummary,
  EvalOverview,
  EvalRun,
  EvalRunSummary,
  RetrievedChunk,
} from "./eval/types.js";
import { parseDatasetInput, parseRunOptions } from "./eval/validation.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rag-eval-"));
  const store = new EvalStore(join(dir, "rag.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function retriever(map: Record<string, RetrievedChunk[]>): RetrievalFn {
  return async (query) => map[query] ?? [];
}

async function startApi(options: { store: EvalStore; runner: EvalRunner }) {
  const app = express();
  app.use(express.json());
  app.use("/api/eval", evalRouter(options));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("用例命中时计算排名、召回与准确率", () => {
  const result = computeCaseResult(
    { id: "c1", query: "如何部署", expectedSources: ["guide.md"], expectedKeywords: [] },
    [
      { source: "guide.md", content: "部署步骤" },
      { source: "faq.md", content: "常见问题" },
    ],
  );
  assert.equal(result.hit, true);
  assert.equal(result.retrieved, 2);
  assert.deepEqual(result.relevantSources, ["guide.md"]);
  assert.equal(result.firstRelevantRank, 1);
  assert.equal(result.reciprocalRank, 1);
  assert.equal(result.recall, 1);
  assert.equal(result.precision, 0.5);
  assert.equal(result.topSource, "guide.md");
  assert.equal(result.keywordCoverage, null);
  assert.equal(result.error, null);
});

test("多期望来源时按首个相关结果排名计算 MRR", () => {
  const result = computeCaseResult(
    { id: "c2", query: "问题", expectedSources: ["a.md", "c.md"], expectedKeywords: [] },
    [
      { source: "b.md", content: "" },
      { source: "a.md", content: "" },
      { source: "c.md", content: "" },
    ],
  );
  assert.deepEqual(result.relevantSources, ["a.md", "c.md"]);
  assert.equal(result.firstRelevantRank, 2);
  assert.equal(result.reciprocalRank, 0.5);
  assert.equal(result.recall, 1);
  assert.equal(result.precision, 2 / 3);
});

test("未命中与空召回时指标归零", () => {
  const missed = computeCaseResult(
    { id: "c3", query: "缺失", expectedSources: ["a.md"], expectedKeywords: [] },
    [{ source: "b.md", content: "无关" }],
  );
  assert.equal(missed.hit, false);
  assert.equal(missed.recall, 0);
  assert.equal(missed.precision, 0);
  assert.equal(missed.firstRelevantRank, null);
  assert.equal(missed.reciprocalRank, 0);

  const empty = computeCaseResult(
    { id: "c4", query: "空", expectedSources: ["a.md"], expectedKeywords: ["alpha"] },
    [],
  );
  assert.equal(empty.precision, 0);
  assert.equal(empty.topSource, null);
  assert.equal(empty.keywordCoverage, 0);
});

test("关键词覆盖率按命中关键词占比计算", () => {
  const result = computeCaseResult(
    { id: "c5", query: "覆盖", expectedSources: ["a.md"], expectedKeywords: ["alpha", "beta"] },
    [{ source: "a.md", content: "Alpha 是第一个" }],
  );
  assert.equal(result.keywordCoverage, 0.5);
});

test("检索异常记录为错误用例", () => {
  const result = errorCaseResult(
    { id: "c6", query: "x", expectedSources: ["a.md"], expectedKeywords: [] },
    new Error("boom"),
  );
  assert.equal(result.error, "boom");
  assert.equal(result.hit, false);
  assert.equal(result.retrieved, 0);
  assert.equal(result.keywordCoverage, null);
});

test("汇总运行指标含命中率、MRR 与关键词忠实度", () => {
  const results: EvalCaseResult[] = [
    computeCaseResult(
      { id: "c1", query: "q1", expectedSources: ["a.md"], expectedKeywords: ["alpha"] },
      [{ source: "a.md", content: "alpha" }],
    ),
    computeCaseResult(
      { id: "c2", query: "q2", expectedSources: ["b.md"], expectedKeywords: ["beta"] },
      [{ source: "x.md", content: "none" }],
    ),
    errorCaseResult(
      { id: "c3", query: "q3", expectedSources: ["c.md"], expectedKeywords: [] },
      new Error("fail"),
    ),
  ];
  const summary = summarizeRun(
    {
      runId: "r1",
      datasetId: "d1",
      datasetName: "回归集",
      topK: 5,
      startedAt: "2026-07-31T12:00:00.000Z",
      finishedAt: "2026-07-31T12:00:02.000Z",
    },
    results,
  );
  assert.equal(summary.cases, 3);
  assert.equal(summary.hits, 1);
  assert.equal(summary.hitRate, 1 / 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.recall, 1 / 3);
  assert.equal(summary.mrr, 1 / 3);
  assert.equal(summary.faithfulness, 0.5);
  assert.equal(summary.durationMs, 2000);
});

test("无期望关键词时忠实度为 null", () => {
  const summary = summarizeRun(
    {
      runId: "r2",
      datasetId: "d1",
      datasetName: "空",
      topK: 5,
      startedAt: "2026-07-31T12:00:00.000Z",
      finishedAt: "2026-07-31T12:00:00.000Z",
    },
    [
      computeCaseResult(
        { id: "c1", query: "q", expectedSources: ["a.md"], expectedKeywords: [] },
        [],
      ),
    ],
  );
  assert.equal(summary.faithfulness, null);
  assert.equal(summary.durationMs, 0);
});

test("评测集入参校验归一化并生成用例 id", () => {
  const input = parseDatasetInput({
    name: " 回归集 ",
    cases: [
      {
        query: "如何部署",
        expectedSources: ["guide.md", "guide.md"],
        expectedKeywords: ["部署"],
      },
    ],
  });
  assert.equal(input.name, "回归集");
  assert.equal(input.description, "");
  const first = input.cases[0];
  assert.ok(first);
  assert.deepEqual(first.expectedSources, ["guide.md"]);
  assert.ok(first.id.length > 0);
});

test("评测集入参非法时抛错", () => {
  assert.throws(() => parseDatasetInput(null), /dataset must be an object/);
  assert.throws(() => parseDatasetInput({ cases: [] }), /name is required/);
  assert.throws(
    () => parseDatasetInput({ name: "x", cases: [] }),
    /cases must be a non-empty array/,
  );
  assert.throws(
    () => parseDatasetInput({ name: "x", cases: [{ query: "q", expectedSources: [] }] }),
    /expectedSources must have at least 1 item/,
  );
  assert.throws(
    () => parseDatasetInput({ name: "x", cases: [{ expectedSources: ["a"] }] }),
    /query is required/,
  );
});

test("运行参数缺省与夹取", () => {
  assert.deepEqual(parseRunOptions(undefined), { topK: 5 });
  assert.deepEqual(parseRunOptions({}), { topK: 5 });
  assert.deepEqual(parseRunOptions({ topK: 50 }), { topK: 20 });
  assert.deepEqual(parseRunOptions({ topK: 0 }), { topK: 1 });
  assert.deepEqual(parseRunOptions({ topK: 3.9 }), { topK: 3 });
  assert.throws(() => parseRunOptions([]), /run options must be an object/);
});

test("评测集读写删与运行记录落库", () => {
  const { store, cleanup } = setup();
  try {
    const created = store.createDataset({
      name: "回归集",
      description: "示例",
      cases: [{ id: "c1", query: "q", expectedSources: ["a.md"], expectedKeywords: [] }],
    });
    const summaries = store.listDatasets();
    const firstSummary = summaries[0];
    assert.ok(firstSummary);
    assert.equal(firstSummary.id, created.id);
    assert.equal(firstSummary.cases, 1);

    const updated = store.updateDataset(created.id, {
      name: "回归集v2",
      description: "",
      cases: [{ id: "c1", query: "q2", expectedSources: ["a.md"], expectedKeywords: [] }],
    });
    assert.ok(updated);
    assert.equal(updated.name, "回归集v2");
    assert.equal(updated.createdAt, created.createdAt);

    const results = [
      computeCaseResult(
        { id: "c1", query: "q2", expectedSources: ["a.md"], expectedKeywords: [] },
        [{ source: "a.md", content: "x" }],
      ),
    ];
    const run: EvalRun = {
      ...summarizeRun(
        {
          runId: "r1",
          datasetId: created.id,
          datasetName: "回归集v2",
          topK: 5,
          startedAt: "2026-07-31T12:00:00.000Z",
          finishedAt: "2026-07-31T12:00:01.000Z",
        },
        results,
      ),
      results,
    };
    store.saveRun(run);

    const runs = store.listRuns();
    const firstRun = runs[0];
    assert.ok(firstRun);
    assert.equal(firstRun.runId, "r1");
    assert.deepEqual(store.getRun("r1"), run);

    const overview = store.overview();
    assert.equal(overview.datasets, 1);
    assert.equal(overview.cases, 1);
    assert.equal(overview.latest?.runId, "r1");
    assert.equal(overview.history.length, 1);
    assert.equal(overview.misses.length, 0);

    assert.equal(store.deleteDataset(created.id), true);
    assert.equal(store.deleteDataset(created.id), false);
    assert.equal(store.getDataset(created.id), null);
    // 删集不影响历史运行，便于跨版本对比。
    assert.equal(store.listRuns().length, 1);
  } finally {
    cleanup();
  }
});

test("评估运行器逐条检索并汇总落库", async () => {
  const { store, cleanup } = setup();
  try {
    const dataset = store.createDataset({
      name: "回归集",
      description: "",
      cases: [
        { id: "c1", query: "部署", expectedSources: ["guide.md"], expectedKeywords: ["部署"] },
        { id: "c2", query: "报错", expectedSources: ["faq.md"], expectedKeywords: [] },
      ],
    });
    const runner = new EvalRunner({
      store,
      retrieve: async (query) => {
        if (query === "报错") throw new Error("检索超时");
        return [{ source: "guide.md", content: "部署流程说明" }];
      },
    });
    const run = await runner.run(dataset.id, { topK: 5 });
    assert.equal(run.cases, 2);
    assert.equal(run.hits, 1);
    assert.equal(run.errors, 1);
    const [first, second] = run.results;
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.hit, true);
    assert.equal(second.error, "检索超时");
    assert.equal(store.listRuns().length, 1);
    await assert.rejects(() => runner.run("missing", { topK: 5 }), /dataset not found/);
  } finally {
    cleanup();
  }
});

test("用例级来源过滤透传给检索器", async () => {
  const { store, cleanup } = setup();
  try {
    const seen: Array<{ topK: number; sources?: string[] }> = [];
    const runner = new EvalRunner({
      store,
      retrieve: async (_query, options) => {
        seen.push({ topK: options.topK, sources: options.sources });
        return [];
      },
    });
    const dataset = store.createDataset({
      name: "过滤集",
      description: "",
      cases: [
        {
          id: "c1",
          query: "q",
          expectedSources: ["a.md"],
          expectedKeywords: [],
          sources: ["a.md"],
        },
      ],
    });
    await runner.run(dataset.id, { topK: 3 });
    const first = seen[0];
    assert.ok(first);
    assert.equal(first.topK, 3);
    assert.deepEqual(first.sources, ["a.md"]);
  } finally {
    cleanup();
  }
});

test("看板列出最近一次运行的未命中用例", async () => {
  const { store, cleanup } = setup();
  try {
    const dataset = store.createDataset({
      name: "回归集",
      description: "",
      cases: [{ id: "c1", query: "缺", expectedSources: ["a.md"], expectedKeywords: [] }],
    });
    const runner = new EvalRunner({
      store,
      retrieve: retriever({}),
    });
    await runner.run(dataset.id, { topK: 5 });
    const overview = store.overview();
    assert.equal(overview.latest?.hitRate, 0);
    assert.equal(overview.misses.length, 1);
    assert.equal(overview.misses[0]?.caseId, "c1");
  } finally {
    cleanup();
  }
});

test("评估 API 覆盖 CRUD、运行与看板", async () => {
  const { store, cleanup } = setup();
  const runner = new EvalRunner({ store, retrieve: retriever({ 部署: [{ source: "guide.md", content: "部署" }] }) });
  const api = await startApi({ store, runner });
  try {
    const createResponse = await fetch(`${api.baseUrl}/api/eval/datasets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "回归集",
        cases: [{ query: "部署", expectedSources: ["guide.md"], expectedKeywords: ["部署"] }],
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { dataset: EvalDataset };
    const datasetId = created.dataset.id;
    assert.equal(created.dataset.cases.length, 1);

    const listResponse = await fetch(`${api.baseUrl}/api/eval/datasets`);
    const list = (await listResponse.json()) as { datasets: EvalDatasetSummary[] };
    assert.equal(list.datasets.length, 1);

    const runResponse = await fetch(`${api.baseUrl}/api/eval/datasets/${datasetId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topK: 4 }),
    });
    assert.equal(runResponse.status, 201);
    const run = (await runResponse.json()) as { run: EvalRun };
    assert.equal(run.run.hitRate, 1);
    assert.equal(run.run.topK, 4);

    const overviewResponse = await fetch(`${api.baseUrl}/api/eval/overview`);
    const overview = (await overviewResponse.json()) as EvalOverview;
    assert.equal(overview.datasets, 1);
    assert.equal(overview.cases, 1);
    assert.equal(overview.latest?.runId, run.run.runId);
    assert.equal(overview.misses.length, 0);

    const runsResponse = await fetch(`${api.baseUrl}/api/eval/runs`);
    const runs = (await runsResponse.json()) as { runs: EvalRunSummary[] };
    assert.equal(runs.runs.length, 1);

    const deleteResponse = await fetch(`${api.baseUrl}/api/eval/datasets/${datasetId}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);

    const missingResponse = await fetch(`${api.baseUrl}/api/eval/datasets/${datasetId}`);
    assert.equal(missingResponse.status, 404);

    const badResponse = await fetch(`${api.baseUrl}/api/eval/datasets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", cases: [] }),
    });
    assert.equal(badResponse.status, 400);
  } finally {
    await api.close();
    cleanup();
  }
});

test("对不存在的评测集触发运行返回 404", async () => {
  const { store, cleanup } = setup();
  const runner = new EvalRunner({ store, retrieve: retriever({}) });
  const api = await startApi({ store, runner });
  try {
    const response = await fetch(`${api.baseUrl}/api/eval/datasets/missing/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404);
  } finally {
    await api.close();
    cleanup();
  }
});
