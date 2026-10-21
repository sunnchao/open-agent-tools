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
import { querySources } from "./query-settings.js";
import { accessGroups } from "./request-validation.js";

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
      const sources = body.source ? [decodeSource(body.source)] : await rag.listSources();
      if (sources.length === 0) {
        res
          .status(200)
          .json({ sources: [], entities: 0, relations: 0, message: "no sources to extract" });
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
  router.get("/sync-status", async (_req: Request, res: Response) => {
    res.json(await lifecycle.status());
  });

  /** 各来源的建图状态明细。 */
  router.get("/sources", (_req: Request, res: Response) => {
    res.json({ sources: graph.listSources(), stats: graph.getStats() });
  });

  /** 一键对账：清理孤儿来源 + 重建缺失/过期来源。 */
  router.post("/reconcile", async (_req: Request, res: Response) => {
    try {
      const result = await lifecycle.reconcile();
      res.json({ ...result, status: await lifecycle.status() });
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

  router.get("/documents/:source", async (req: Request, res: Response) => {
    const source = req.params.source;
    if (typeof source !== "string" || !source.trim()) {
      res.status(400).json({ error: "source is required" });
      return;
    }
    const documents = await rag.listDocuments();
    if (!documents.some((document) => document.source === source)) {
      res.status(404).json({ error: "document not found" });
      return;
    }
    const subgraph = graph.store.graphForSource(source);
    res.json({ ...visualizer.exportSubgraph(subgraph), nodes: subgraph.entities });
  });

  /** 单实体 1-2 跳邻居子图（面板展开）。 */
  router.get("/neighbors/:id", (req: Request, res: Response) => {
    const raw = req.params.id;
    const id = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
    const hops = clampInt(req.query.hops, 2, 1, 3);
    const source = req.query.source;
    if (source !== undefined && (typeof source !== "string" || !source.trim())) {
      res.status(400).json({ error: "source must be a non-empty string" });
      return;
    }
    const sub = graph.store.neighbors(id, hops, {
      ...(typeof source === "string" ? { sources: [source] } : {}),
    });
    res.json(visualizer.exportSubgraph(sub));
  });

  /** 子图检索：种子定位 + 多跳扩展，返回序列化文本与导出 JSON。 */
  router.post("/retrieve", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      query?: unknown;
      maxHops?: unknown;
      maxNodes?: unknown;
      sources?: unknown;
      viewerGroups?: unknown;
    };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    let sources: string[] | undefined;
    let viewerGroups: string[] | undefined;
    try {
      sources = querySources(body.sources);
      if (res.locals.ragScope === "runtime") {
        // runtime 调用默认只查公开文档，即使直接访问 graph 端点也不能退化为管理全量。
        viewerGroups =
          body.viewerGroups === undefined ? [] : accessGroups(body.viewerGroups, "viewerGroups");
      } else if (body.viewerGroups !== undefined) {
        viewerGroups = accessGroups(body.viewerGroups, "viewerGroups");
      }
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const scopedSources = await rag.resolveVisibleSources(sources, viewerGroups);
      const result = await graph.retrieve(query, {
        maxHops: clampInt(body.maxHops, 2, 1, 4),
        maxNodes: clampInt(body.maxNodes, 64, 4, 512),
        ...(scopedSources !== undefined ? { sources: scopedSources } : {}),
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
        chunks: result.chunks.map((c) => ({
          source: c.source,
          chunkIndex: c.chunkIndex,
          content: c.content,
          ...(typeof c.score === "number" ? { score: c.score } : {}),
        })),
      };
    },
  });
  const graphDomain = createGraphDomain({
    retrieve: async (query, opts = {}) => {
      if (opts.sources?.length === 0) return { query, seeds: [], subgraph: null };
      const result = await graph.retrieve(query, {
        maxHops: 2,
        ...(opts.sources ? { sources: opts.sources } : {}),
      });
      return result;
    },
  });
  return new CragController({
    evaluator: new HeuristicRetrievalEvaluator(),
    domains: [block, graphDomain],
    maxRetries: 1,
  });
}
