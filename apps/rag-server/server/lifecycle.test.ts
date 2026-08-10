import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rag } from "@open-agent-tools/rag";
import { KnowledgeGraph } from "@open-agent-tools/rag-graph";
import { GraphLifecycle } from "./lifecycle.js";

const silent = { log: () => {}, error: () => {} };

function setup(): {
  rag: Rag;
  graph: KnowledgeGraph;
  lifecycle: GraphLifecycle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  const rag = new Rag({ dbPath: join(dir, "rag.db"), chunkSize: 200, chunkOverlap: 0 });
  const graph = new KnowledgeGraph({ dbPath: join(dir, "graph.db") });
  const lifecycle = new GraphLifecycle({ rag, graph, logger: silent });
  return {
    rag,
    graph,
    lifecycle,
    cleanup: () => {
      rag.close();
      graph.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function file(name: string, text: string) {
  return { name, data: new TextEncoder().encode(text) };
}

// 规则抽取器按标点切块取 2-6 字候选，测试文本需带分隔标点（无标点长句抽不出实体）
const DOC_A = "腾讯云，微信支付，小程序生态。腾讯云，云服务器，对象存储。";
const DOC_B = "阿里云，支付宝，电商平台。阿里云，弹性计算，负载均衡。";

test("上传后自动建图并登记来源状态", async () => {
  const { rag, lifecycle, cleanup } = setup();
  const result = await rag.ingestBuffers([file("a.md", DOC_A)]);
  assert.deepEqual(result.sources, ["a.md"], "只返回本次上传的来源");

  lifecycle.onDocumentsIngested(result.sources);
  await lifecycle.waitIdle();

  const status = lifecycle.status();
  assert.equal(status.inSync, true);
  assert.deepEqual(status.missing, []);
  assert.equal(status.sources.length, 1);
  assert.equal(status.sources[0]?.status, "ready");
  assert.ok(status.stats.entities > 0, "应抽取出实体");
  cleanup();
});

test("删除文档级联清空对应图谱数据", async () => {
  const { rag, lifecycle, cleanup } = setup();
  await rag.ingestBuffers([file("a.md", DOC_A), file("b.md", DOC_B)]);
  lifecycle.onDocumentsIngested(["a.md", "b.md"]);
  await lifecycle.waitIdle();
  const before = lifecycle.status();
  assert.equal(before.stats.entities > 0, true);

  rag.clearSource("a.md");
  const removed = lifecycle.onDocumentRemoved("a.md");
  assert.ok(removed.entities > 0, "应回收 a.md 独有的实体");

  const after = lifecycle.status();
  assert.equal(after.inSync, true, "删除后两库应保持一致");
  assert.deepEqual(after.orphan, [], "不应残留孤儿来源");
  assert.deepEqual(
    after.sources.map((s) => s.source),
    ["b.md"],
  );
  assert.ok(after.stats.entities > 0, "b.md 的实体应保留");
  cleanup();
});

test("全部删除后图谱清空不留残留", async () => {
  const { rag, lifecycle, cleanup } = setup();
  await rag.ingestBuffers([file("a.md", DOC_A), file("b.md", DOC_B)]);
  lifecycle.onDocumentsIngested(["a.md", "b.md"]);
  await lifecycle.waitIdle();

  for (const source of ["a.md", "b.md"]) {
    rag.clearSource(source);
    lifecycle.onDocumentRemoved(source);
  }
  const status = lifecycle.status();
  assert.deepEqual(status.stats, { entities: 0, relations: 0 });
  assert.deepEqual(status.sources, []);
  assert.equal(status.inSync, true);
  cleanup();
});

test("绕过编排直接入库会被对账识别为 missing 并可修复", async () => {
  const { rag, lifecycle, cleanup } = setup();
  // 模拟历史数据 / 手工导入：只进了知识库，没触发建图
  await rag.ingestBuffers([file("a.md", DOC_A)]);

  const before = lifecycle.status();
  assert.equal(before.inSync, false);
  assert.deepEqual(before.missing, ["a.md"]);

  const result = await lifecycle.reconcile();
  assert.deepEqual(result.rebuilt, ["a.md"]);
  assert.equal(lifecycle.status().inSync, true);
  cleanup();
});

test("知识库已删但图谱残留时被识别为 orphan 并清理", async () => {
  const { rag, graph, lifecycle, cleanup } = setup();
  await rag.ingestBuffers([file("a.md", DOC_A)]);
  lifecycle.onDocumentsIngested(["a.md"]);
  await lifecycle.waitIdle();

  // 绕过编排器直接删知识库，制造不一致
  rag.clearSource("a.md");
  const before = lifecycle.status();
  assert.deepEqual(before.orphan, ["a.md"]);
  assert.equal(before.inSync, false);

  const result = await lifecycle.reconcile();
  assert.deepEqual(result.removed, ["a.md"]);
  assert.deepEqual(graph.getStats(), { entities: 0, relations: 0 });
  assert.equal(lifecycle.status().inSync, true);
  cleanup();
});

test("文档重传后分块数变化被识别为 stale", async () => {
  const { rag, lifecycle, cleanup } = setup();
  await rag.ingestBuffers([file("a.md", DOC_A)]);
  lifecycle.onDocumentsIngested(["a.md"]);
  await lifecycle.waitIdle();
  assert.equal(lifecycle.status().inSync, true);

  // 同名文档换更长的内容重传，切分数变化；绕过编排器模拟外部写入
  await rag.ingestBuffers([file("a.md", `${DOC_A}${DOC_B}`.repeat(4))], { chunkSize: 100 });
  const stale = lifecycle.status();
  assert.deepEqual(stale.stale, ["a.md"]);
  assert.equal(stale.inSync, false);

  await lifecycle.reconcile();
  assert.equal(lifecycle.status().inSync, true);
  cleanup();
});

test("重建为先清后建，改动文档不残留旧实体", async () => {
  const { rag, graph, lifecycle, cleanup } = setup();
  await rag.ingestBuffers([file("a.md", "诺基亚，塞班系统，深度绑定。")]);
  lifecycle.onDocumentsIngested(["a.md"]);
  await lifecycle.waitIdle();
  assert.ok(
    graph.listEntities({ search: "诺基亚" }).length > 0,
    "首次建图应含原始实体",
  );

  await rag.ingestBuffers([file("a.md", "安卓，谷歌框架，深度绑定。")]);
  await lifecycle.rebuild("a.md");

  assert.equal(
    graph.listEntities({ search: "诺基亚" }).length,
    0,
    "旧内容的实体必须随重建消失，否则图谱会无限累积失效数据",
  );
  assert.ok(graph.listEntities({ search: "安卓" }).length > 0, "新实体应写入");
  cleanup();
});

test("autoExtract 关闭时只登记 pending 不自动抽取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  const rag = new Rag({ dbPath: join(dir, "rag.db") });
  const graph = new KnowledgeGraph({ dbPath: join(dir, "graph.db") });
  const lifecycle = new GraphLifecycle({ rag, graph, autoExtract: false, logger: silent });

  await rag.ingestBuffers([file("a.md", DOC_A)]);
  lifecycle.onDocumentsIngested(["a.md"]);
  await lifecycle.waitIdle();

  const status = lifecycle.status();
  assert.equal(status.sources[0]?.status, "pending");
  assert.deepEqual(status.missing, ["a.md"], "pending 应计入待建图");
  assert.deepEqual(graph.getStats(), { entities: 0, relations: 0 });

  rag.close();
  graph.close();
  rmSync(dir, { recursive: true, force: true });
});
