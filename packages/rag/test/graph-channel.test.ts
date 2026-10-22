import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rag, type GraphChannelSource } from "../src/index.js";
import { reciprocalRankFusionWithDebug, fuseChannelHits } from "../src/retriever.js";
import type { ScoredChunk } from "../src/types.js";
import { sha1 } from "../src/utils.js";

const enc = (text: string) => new TextEncoder().encode(text);
const chunkId = (source: string, index: number) => sha1(`${source}:${index}`);

function tmpDir(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rag-graph-channel-"));
  return {
    dbPath: join(dir, "rag.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("图谱通道命中真实分块并与关键词路按 id 合并", async () => {
  const { dbPath, cleanup } = tmpDir();
  const seen: { query?: string; opts?: { maxHops?: number; sources?: readonly string[] } } = {};
  // 图谱通道与 Rag 相互引用：先用 late-bind 持有器打破初始化顺序。
  const ref: { rag?: Rag } = {};
  const channel: GraphChannelSource = {
    retrieve: async (query, opts = {}) => {
      seen.query = query;
      seen.opts = opts;
      return {
        seeds: [{ id: "e-openai", name: "OpenAI", type: "org" }],
        subgraph: {
          entities: [
            { id: "e-openai", name: "OpenAI", type: "org" },
            { id: "e-gpt", name: "GPT", type: "product" },
          ],
          relations: [
            { sourceChunk: chunkId("guide.txt", 0), weight: 4, srcId: "e-openai", dstId: "e-gpt" },
          ],
          formatted: () => "相关实体与关系:\n- (OpenAI) --supplies--> (GPT)",
        },
      };
    },
    getChunksByIds: (ids, sources) => ref.rag!.getChunksByIds(ids, sources),
  };
  const rag = new Rag({ dbPath, graph: channel, graphHops: 3 });
  ref.rag = rag;
  try {
    await rag.ingestBuffers([
      { name: "guide.txt", data: enc("OpenAI 提供 GPT 模型与 API 服务") },
      { name: "other.txt", data: enc("完全无关的运维手册") },
    ]);
    const result = await rag.retrieve("OpenAI", { topK: 5 });
    assert.equal(seen.query, "OpenAI", "图谱通道应收到原始查询");
    assert.equal(seen.opts?.maxHops, 3, "graphHops 应透传为 maxHops");

    const hit = result.chunks.find((chunk) => chunk.id === chunkId("guide.txt", 0));
    assert.ok(hit, "关键词命中的分块应同时出现在结果中");
    assert.ok(hit.debug?.channels.includes("keyword"));
    assert.ok(hit.debug?.channels.includes("graph"), "同 id 分块应合并图谱通道");
    assert.equal(hit.debug?.graphRank, 0);
    assert.equal(hit.debug?.graphScore, 1, "唯一候选的权重应归一化为 1");
    assert.deepEqual(
      result.debug?.graphHits?.map((graphHit) => graphHit.id),
      [chunkId("guide.txt", 0)],
    );
    assert.deepEqual(result.debug?.graphHits?.[0]?.seeds, ["OpenAI"]);
    assert.equal(result.debug?.graphEnabled, true);
  } finally {
    await rag.close();
    cleanup();
  }
});

test("未注入 graph 时保持两路 debug 形状且 channels 不含 graph", async () => {
  const { dbPath, cleanup } = tmpDir();
  const rag = new Rag({ dbPath });
  try {
    await rag.ingestBuffers([{ name: "a.txt", data: enc("向量数据库 余弦相似度 混合检索") }]);
    const result = await rag.retrieve("向量检索", { topK: 5 });
    assert.equal(result.graph, undefined, "未启用图谱时不应返回 graph 字段");
    assert.deepEqual(Object.keys(result.debug ?? {}), [
      "embeddingsEnabled",
      "candidates",
      "rrfK",
      "timingsMs",
      "vectorHits",
      "keywordHits",
    ]);
    assert.deepEqual(Object.keys(result.debug?.timingsMs ?? {}), [
      "vectorMs",
      "keywordMs",
      "fusionMs",
    ]);
    assert.equal(result.debug?.graphHits, undefined);
    assert.equal(result.debug?.graphEnabled, undefined);
    for (const chunk of result.chunks) {
      assert.ok(!chunk.debug?.channels.includes("graph"));
      assert.deepEqual(Object.keys(chunk.debug ?? {}), [
        "vectorScore",
        "vectorRank",
        "keywordScore",
        "keywordRank",
        "rrfScore",
        "channels",
      ]);
    }
  } finally {
    await rag.close();
    cleanup();
  }
});

test("注入 graph 后可用 graph:false 显式关闭，且与未注入实例结果一致", async () => {
  const { dbPath, cleanup } = tmpDir();
  const ref: { rag?: Rag } = {};
  const channel: GraphChannelSource = {
    retrieve: async () => ({
      seeds: [{ id: "e-openai", name: "OpenAI", type: "org" }],
      subgraph: {
        entities: [{ id: "e-openai", name: "OpenAI", type: "org" }],
        relations: [
          { sourceChunk: chunkId("a.txt", 0), weight: 1, srcId: "e-openai", dstId: "e-openai" },
        ],
        formatted: () => "相关实体与关系:\n- (OpenAI) --related_to--> (OpenAI)",
      },
    }),
    getChunksByIds: (ids, sources) => ref.rag!.getChunksByIds(ids, sources),
  };
  const rag = new Rag({ dbPath, graph: channel });
  ref.rag = rag;
  // 同一 SQLite 文件的另一连接：不注入 graph，作为「两路基线」对照。
  const plain = new Rag({ dbPath });
  try {
    await rag.ingestBuffers([{ name: "a.txt", data: enc("OpenAI 的模型与接口说明") }]);
    const on = await rag.retrieve("OpenAI", { topK: 5 });
    assert.ok(on.graph?.enabled, "构造注入 graph 后默认启用");
    assert.ok(on.chunks.some((chunk) => chunk.debug?.channels.includes("graph")));

    const off = await rag.retrieve("OpenAI", { topK: 5, graph: false });
    assert.equal(off.graph, undefined, "显式关闭时不应返回 graph 字段");
    assert.equal(off.debug?.graphEnabled, undefined);
    assert.equal(off.debug?.graphHits, undefined);
    assert.ok(off.chunks.every((chunk) => !chunk.debug?.channels.includes("graph")));

    const baseline = await plain.retrieve("OpenAI", { topK: 5 });
    assert.deepEqual(
      off.chunks.map((chunk) => [chunk.id, chunk.score]),
      baseline.chunks.map((chunk) => [chunk.id, chunk.score]),
      "graph:false 应逐值等同未注入图谱的两路结果",
    );
  } finally {
    await rag.close();
    await plain.close();
    cleanup();
  }
});

test("sources 空白名单时图谱通道也不得穿透", async () => {
  const { dbPath, cleanup } = tmpDir();
  let called = false;
  const channel: GraphChannelSource = {
    retrieve: async () => {
      called = true;
      return { seeds: [], subgraph: null };
    },
    getChunksByIds: async () => [],
  };
  const rag = new Rag({ dbPath, graph: channel });
  try {
    await rag.ingestBuffers([{ name: "a.txt", data: enc("OpenAI 的模型与接口说明") }]);
    const result = await rag.retrieve("OpenAI", { sources: [] });
    assert.deepEqual(result.chunks, []);
    assert.equal(called, false, "空来源白名单必须在调用图谱前短路");
    assert.deepEqual(result.graph, {
      enabled: true,
      seeds: [],
      context: "",
      entities: 0,
      relations: 0,
      chunkHits: 0,
    });
  } finally {
    await rag.close();
    cleanup();
  }
});

test("sources 白名单下图谱不得泄漏其他文档的分块", async () => {
  const { dbPath, cleanup } = tmpDir();
  let receivedSources: readonly string[] | undefined;
  const channel: GraphChannelSource = {
    retrieve: async (_query, opts = {}) => {
      receivedSources = opts.sources;
      return {
        seeds: [
          { id: "e-a", name: "Alpha", type: "concept" },
          { id: "e-b", name: "Beta", type: "concept" },
        ],
        subgraph: {
          entities: [
            { id: "e-a", name: "Alpha", type: "concept" },
            { id: "e-b", name: "Beta", type: "concept" },
          ],
          relations: [
            { sourceChunk: chunkId("a.txt", 0), weight: 2, srcId: "e-a", dstId: "e-b" },
            { sourceChunk: chunkId("b.txt", 0), weight: 9, srcId: "e-a", dstId: "e-b" },
          ],
          formatted: () => "相关实体与关系:\n- (Alpha) --related_to--> (Beta)",
        },
      };
    },
    // 故意无视 sources 返回全部分块：检索器必须再拦一次，不能只信数据源。
    getChunksByIds: async (ids) => {
      const all: ScoredChunk[] = [];
      for (const id of ids) {
        if (id === chunkId("a.txt", 0)) {
          all.push({ id, source: "a.txt", chunkIndex: 0, content: "Alpha 与 Beta", score: 0 });
        }
        if (id === chunkId("b.txt", 0)) {
          all.push({ id, source: "b.txt", chunkIndex: 0, content: "秘密文档", score: 0 });
        }
      }
      return all;
    },
  };
  const rag = new Rag({ dbPath, graph: channel });
  try {
    await rag.ingestBuffers([
      { name: "a.txt", data: enc("Alpha 与 Beta 的关系说明") },
      { name: "b.txt", data: enc("秘密文档 机密信息") },
    ]);
    // 存储层本身也必须遵守白名单
    assert.deepEqual(await rag.getChunksByIds([chunkId("b.txt", 0)], ["a.txt"]), []);

    const result = await rag.retrieve("Alpha", { topK: 10, sources: ["a.txt"] });
    assert.deepEqual(receivedSources, ["a.txt"], "图谱通道应收到来源白名单");
    assert.ok(result.chunks.length > 0);
    assert.ok(
      result.chunks.every((chunk) => chunk.source === "a.txt"),
      "结果分块只能来自白名单来源",
    );
    assert.ok(
      (result.debug?.graphHits ?? []).every((hit) => hit.source === "a.txt"),
      "图谱候选不得泄漏 b.txt",
    );
    assert.equal(result.graph?.chunkHits, 1);
    assert.deepEqual(
      result.debug?.graphHits?.map((hit) => hit.id),
      [chunkId("a.txt", 0)],
    );
  } finally {
    await rag.close();
    cleanup();
  }
});

test("图谱 retrieve 抛错时降级为空候选，整体检索仍成功", async () => {
  const { dbPath, cleanup } = tmpDir();
  // 图谱通道与 Rag 相互引用：先用 late-bind 持有器打破初始化顺序。
  const ref: { rag?: Rag } = {};
  const channel: GraphChannelSource = {
    retrieve: async () => {
      throw new Error("graph db is down");
    },
    getChunksByIds: (ids, sources) => ref.rag!.getChunksByIds(ids, sources),
  };
  const rag = new Rag({ dbPath, graph: channel });
  ref.rag = rag;
  try {
    await rag.ingestBuffers([{ name: "a.txt", data: enc("网关启动失败时检查数据库连接配置") }]);
    const result = await rag.retrieve("网关启动失败", { topK: 5 });
    assert.ok(result.chunks.length > 0, "关键词路结果不应被图谱故障吞掉");
    assert.deepEqual(result.graph, {
      enabled: true,
      seeds: [],
      context: "",
      entities: 0,
      relations: 0,
      chunkHits: 0,
    });
    assert.deepEqual(result.debug?.graphHits, []);
    assert.equal(result.debug?.graphEnabled, true);
    assert.equal(typeof result.debug?.timingsMs.graphMs, "number");
    assert.ok(
      result.chunks.every((chunk) => !chunk.debug?.channels.includes("graph")),
      "降级后不应有图谱通道标记",
    );
  } finally {
    await rag.close();
    cleanup();
  }
});

test("分块回取失败时保留子图上下文，仅图谱候选降级为空", async () => {
  const { dbPath, cleanup } = tmpDir();
  const channel: GraphChannelSource = {
    retrieve: async () => ({
      seeds: [{ id: "e-openai", name: "OpenAI", type: "org" }],
      subgraph: {
        entities: [{ id: "e-openai", name: "OpenAI", type: "org" }],
        relations: [
          { sourceChunk: chunkId("a.txt", 0), weight: 2, srcId: "e-openai", dstId: "e-openai" },
        ],
        formatted: () => "相关实体与关系:\n- (OpenAI) --related_to--> (OpenAI)",
      },
    }),
    getChunksByIds: async () => {
      throw new Error("chunk store unavailable");
    },
  };
  const rag = new Rag({ dbPath, graph: channel });
  try {
    await rag.ingestBuffers([{ name: "a.txt", data: enc("OpenAI 的模型与接口说明") }]);
    const result = await rag.retrieve("OpenAI", { topK: 5 });
    assert.ok(result.chunks.length > 0);
    assert.equal(result.graph?.enabled, true);
    assert.match(result.graph?.context ?? "", /OpenAI.*related_to.*OpenAI/);
    assert.equal(result.graph?.entities, 1);
    assert.equal(result.graph?.relations, 1);
    assert.equal(result.graph?.chunkHits, 0);
    assert.deepEqual(result.debug?.graphHits, []);
  } finally {
    await rag.close();
    cleanup();
  }
});

test("result.graph.context 含三元组，chunkHits 与 debug.graphHits 数量一致", async () => {
  const { dbPath, cleanup } = tmpDir();
  // 图谱通道与 Rag 相互引用：先用 late-bind 持有器打破初始化顺序。
  const ref: { rag?: Rag } = {};
  const channel: GraphChannelSource = {
    retrieve: async () => ({
      seeds: [{ id: "e-openai", name: "OpenAI", type: "org" }],
      subgraph: {
        entities: [
          { id: "e-openai", name: "OpenAI", type: "org" },
          { id: "e-azure", name: "Azure", type: "product" },
          { id: "e-gpt", name: "GPT", type: "product" },
        ],
        relations: [
          // OpenAI 的直邻边（hop=1），权重低
          { sourceChunk: chunkId("a.txt", 0), weight: 1, srcId: "e-openai", dstId: "e-azure" },
          // 二跳边（hop=2），权重高但应排在 hop=1 之后
          { sourceChunk: chunkId("b.txt", 0), weight: 5, srcId: "e-azure", dstId: "e-gpt" },
        ],
        formatted: () =>
          "相关实体与关系:\n- (OpenAI) --supplies--> (Azure)\n- (Azure) --related_to--> (GPT)",
      },
    }),
    getChunksByIds: (ids, sources) => ref.rag!.getChunksByIds(ids, sources),
  };
  const rag = new Rag({ dbPath, graph: channel });
  ref.rag = rag;
  try {
    await rag.ingestBuffers([
      { name: "a.txt", data: enc("OpenAI 与 Azure 的供应商关系说明。") },
      { name: "b.txt", data: enc("GPT 由 Azure 承载的部署说明。") },
    ]);
    const result = await rag.retrieve("OpenAI", { topK: 5 });
    assert.ok(result.graph, "应返回图谱增强结果");
    assert.equal(result.graph?.enabled, true);
    assert.match(result.graph?.context ?? "", /\(OpenAI\) --supplies--> \(Azure\)/);
    assert.equal(result.graph?.entities, 3);
    assert.equal(result.graph?.relations, 2);
    assert.equal(result.graph?.chunkHits, result.debug?.graphHits?.length);
    assert.equal(result.graph?.chunkHits, 2);
    // hop 升序优先于权重降序：直邻分块排在二跳分块之前
    assert.deepEqual(
      result.debug?.graphHits?.map((hit) => hit.id),
      [chunkId("a.txt", 0), chunkId("b.txt", 0)],
    );
    // 排名由 hop 决定，score 只反映关系权重：二跳边权重更高，归一化分也更高
    const [first, second] = result.debug?.graphHits ?? [];
    assert.equal(first?.score, 0.2);
    assert.equal(second?.score, 1);
  } finally {
    await rag.close();
    cleanup();
  }
});

test("Rag.getChunksByIds 在 store 未实现时返回 []", async () => {
  const rag = new Rag({
    store: {
      insert: () => {},
      replaceSource: () => {},
      vectorSearch: () => [],
      keywordSearch: () => [],
      removeBySource: () => {},
      listSources: () => [],
      listDocuments: () => [],
      updateDocument: () => null,
      countChunks: () => 0,
    },
  });
  assert.deepEqual(await rag.getChunksByIds(["missing"]), []);
  assert.deepEqual(await rag.getChunksByIds([], undefined), []);
});

test("fuseChannelHits 两路结果与 reciprocalRankFusionWithDebug 完全一致", () => {
  const hit = (id: string, score: number): ScoredChunk => ({
    id,
    source: "a.txt",
    chunkIndex: 0,
    content: id,
    score,
  });
  const vector = [hit("d1", 0.9), hit("d2", 0.8), hit("d3", 0.7)];
  const keyword = [hit("d3", 5), hit("d1", 3)];
  assert.deepEqual(
    fuseChannelHits([
      { channel: "vector", hits: vector },
      { channel: "keyword", hits: keyword },
    ]),
    reciprocalRankFusionWithDebug(vector, keyword),
  );
});

test("keyword:false 只保留向量通道（仅向量召回）", async () => {
  const { dbPath, cleanup } = tmpDir();
  const rag = new Rag({ dbPath });
  try {
    await rag.ingestBuffers([
      { name: "a.txt", data: enc("OpenAI 提供 GPT 模型与 API 服务") },
      { name: "b.txt", data: enc("完全无关的运维手册") },
    ]);
    const result = await rag.retrieve("OpenAI", { topK: 5, keyword: false });
    assert.equal(result.debug?.keywordEnabled, false, "应标记关键词通道已关闭");
    assert.deepEqual(result.debug?.keywordHits, [], "关键词通道关闭后不应执行 BM25");
    assert.ok(
      result.chunks.every((chunk) => !chunk.debug?.channels.includes("keyword")),
      "仅向量模式下 channels 不得出现 keyword",
    );
    // 无 embeddings 时向量路为空：这正是「仅向量」模式的边界——不能悄悄回落到关键词。
    assert.deepEqual(result.chunks, []);
  } finally {
    await rag.close();
    cleanup();
  }
});

test("keyword:false + graph 开启时仍是向量与图谱两路", async () => {
  const { dbPath, cleanup } = tmpDir();
  const ref: { rag?: Rag } = {};
  const channel: GraphChannelSource = {
    retrieve: async () => ({
      seeds: [{ id: "e-openai", name: "OpenAI", type: "org" }],
      subgraph: {
        entities: [{ id: "e-openai", name: "OpenAI", type: "org" }],
        relations: [
          { sourceChunk: chunkId("a.txt", 0), weight: 1, srcId: "e-openai", dstId: "e-openai" },
        ],
        formatted: () => "相关实体与关系:\n- (OpenAI) --related_to--> (OpenAI)",
      },
    }),
    getChunksByIds: (ids, sources) => ref.rag!.getChunksByIds(ids, sources),
  };
  const rag = new Rag({ dbPath, graph: channel });
  ref.rag = rag;
  try {
    await rag.ingestBuffers([{ name: "a.txt", data: enc("OpenAI 的模型与接口说明") }]);
    const result = await rag.retrieve("OpenAI", { topK: 5, keyword: false });
    assert.equal(result.debug?.keywordEnabled, false);
    assert.equal(result.graph?.enabled, true, "关键词关闭不应影响图谱通道");
    assert.ok(result.chunks.some((chunk) => chunk.debug?.channels.includes("graph")));
    assert.ok(result.chunks.every((chunk) => !chunk.debug?.channels.includes("keyword")));
  } finally {
    await rag.close();
    cleanup();
  }
});
