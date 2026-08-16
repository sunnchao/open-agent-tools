import { Router, type Request, type Response } from "express";
import { KnowledgeGraph, GraphVisualizer, type Entity } from "@open-agent-tools/rag/graph";
import {
  CragController,
  createBlockDomain,
  createGraphDomain,
  HeuristicRetrievalEvaluator,
} from "@open-agent-tools/rag/crag";
import type { Rag } from "@open-agent-tools/rag";
import type { GraphLifecycle } from "./lifecycle.js";

export interface GraphRouterOptions {
  rag: Rag;
  graph: KnowledgeGraph;
}

export interface GraphRouterDeps extends GraphRouterOptions {
  lifecycle: GraphLifecycle;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function decodeSource(raw: unknown): string {
  const s = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return decodeURIComponent(String(s));
}

export function graphRouter(opts: GraphRouterDeps): Router {
  const { rag, graph, lifecycle } = opts;
  const router: Router = Router();
  const visualizer = new GraphVisualizer(graph.store);

  /** 触发抽取：对指定 source（或全库）重建图谱。先清后建，可重复调用。 */
  router.post("/extract", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { source?: unknown };
    try {
      const sources = body.source ? [decodeSource(body.source)] : rag.listSources();
      if (sources.length === 0) {
        res.status(200).json({ sources: [], entities: 0, relations: 0, message: "no sources to extract" });
        return;
      }
      let entities = 0;
      let relations = 0;
      for (const source of sources) {
        const state = await lifecycle.rebuild(source);
        entities += state?.entities ?? 0;
        relations += state?.relations ?? 0;
      }
      res.status(201).json({ sources, entities, relations, stats: graph.getStats() });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /** 知识库与图谱库一致性快照（缺失 / 过期 / 孤儿 / 构建中）。 */
  router.get("/sync-status", (_req: Request, res: Response) => {
    res.json(lifecycle.status());
  });

  /** 各来源的建图状态明细。 */
  router.get("/sources", (_req: Request, res: Response) => {
    res.json({ sources: graph.listSources(), stats: graph.getStats() });
  });

  /** 一键对账：清理孤儿来源 + 重建缺失/过期来源。 */
  router.post("/reconcile", async (_req: Request, res: Response) => {
    try {
      const result = await lifecycle.reconcile();
      res.json({ ...result, status: lifecycle.status() });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /** 单独清理某来源的图谱数据（保留知识库文档，用于重建前的手动干预）。 */
  router.delete("/sources/:source", (req: Request, res: Response) => {
    const source = decodeSource(req.params.source);
    if (!source) {
      res.status(400).json({ error: "source is required" });
      return;
    }
    const removed = graph.clearSource(source);
    res.json({ ok: true, source, removed, stats: graph.getStats() });
  });

  /** 实体列表（分页 + 类型过滤 + 名称搜索）。 */
  router.get("/entities", (req: Request, res: Response) => {
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const entities = graph.listEntities({
      type,
      search,
      offset: clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: clampInt(req.query.limit, 50, 1, 500),
    });
    res.json({ entities, stats: graph.getStats() });
  });

  /** 单实体 1-2 跳邻居子图（面板展开）。 */
  router.get("/neighbors/:id", (req: Request, res: Response) => {
    const raw = req.params.id;
    const id = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
    const hops = clampInt(req.query.hops, 2, 1, 3);
    const sub = graph.neighbors(id, hops);
    res.json(visualizer.exportSubgraph(sub));
  });

  /** 子图检索：种子定位 + 多跳扩展，返回序列化文本与导出 JSON。 */
  router.post("/retrieve", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { query?: unknown; maxHops?: unknown; maxNodes?: unknown };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    try {
      const result = await graph.retrieve(query, {
        maxHops: clampInt(body.maxHops, 2, 1, 4),
        maxNodes: clampInt(body.maxNodes, 64, 4, 512),
      });
      res.json({
        query,
        seeds: result.seeds.map((s: Entity) => ({ id: s.id, name: s.name, type: s.type })),
        formatted: result.subgraph ? result.subgraph.formatted() : "",
        subgraph: result.subgraph ? visualizer.exportSubgraph(result.subgraph) : null,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /** 关系类型分布（图例）。 */
  router.get("/relations/types", (_req: Request, res: Response) => {
    res.json({ types: graph.store.countRelationsByType() });
  });

  return router;
}

/** 组装 CRAG 控制器（启发式评估，离线可用）。 */
export function buildCragController(opts: GraphRouterOptions): CragController {
  const { rag, graph } = opts;
  const block = createBlockDomain({
    retrieve: async (query, rOpts = {}) => {
      const result = await rag.retrieve(query, {
        topK: rOpts.topK ?? 5,
        sources: rOpts.sources,
      });
      return {
        chunks: result.chunks.map((c) => ({ source: c.source, chunkIndex: c.chunkIndex, content: c.content })),
      };
    },
  });
  const graphDomain = createGraphDomain({
    retrieve: async (query) => {
      const result = await graph.retrieve(query, { maxHops: 2 });
      return result;
    },
  });
  return new CragController({
    evaluator: new HeuristicRetrievalEvaluator(),
    domains: [block, graphDomain],
    maxRetries: 1,
  });
}
