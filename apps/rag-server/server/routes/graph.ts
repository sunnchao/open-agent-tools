import { Router, type Request, type Response } from "express";
import type { KnowledgeBase } from "../knowledge.js";
import { clampInt, retrievalScope, routeParam } from "../request-validation.js";

export function graphRouter(knowledge: KnowledgeBase): Router {
  const { rag, graph } = knowledge;
  const router: Router = Router();
  const { visualizer } = graph;

  /** 触发抽取：对指定 source（或全库）重建图谱。先清后建，可重复调用。 */
  router.post("/extract", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { source?: unknown };
    try {
      const sources = body.source ? [routeParam(body.source)] : await rag.listSources();
      if (sources.length === 0) {
        res
          .status(200)
          .json({ sources: [], entities: 0, relations: 0, message: "no sources to extract" });
        return;
      }
      let entities = 0;
      let relations = 0;
      for (const source of sources) {
        const state = await knowledge.rebuild(source);
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
    res.json(await knowledge.status());
  });

  /** 各来源的建图状态明细。 */
  router.get("/sources", (_req: Request, res: Response) => {
    res.json({ sources: graph.listSources(), stats: graph.getStats() });
  });

  /** 一键对账：清理孤儿来源 + 重建缺失/过期来源。 */
  router.post("/reconcile", async (_req: Request, res: Response) => {
    try {
      const result = await knowledge.reconcile();
      res.json({ ...result, status: await knowledge.status() });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /** 单独清理某来源的图谱数据（保留知识库文档，用于重建前的手动干预）。 */
  router.delete("/sources/:source", (req: Request, res: Response) => {
    const source = routeParam(req.params.source);
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
    const id = routeParam(req.params.id);
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
      ({ sources, viewerGroups } = retrievalScope(body, res.locals.ragScope));
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
        seeds: result.seeds.map((s) => ({ id: s.id, name: s.name, type: s.type })),
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

  /**
   * 图谱质量快照：共现边占比、度分布、重复实体、反向边等硬指标。
   * 用于判断「图有没有被建坏」，不依赖人工翻数据。
   */
  router.get("/quality", (_req: Request, res: Response) => {
    const quality = graph.quality();
    if (!quality) {
      res.status(501).json({ error: "graph store does not expose quality metrics" });
      return;
    }
    res.json({ quality, diagnostics: graph.diagnostics() });
  });

  /**
   * 同名多 type 实体消解。
   * `dryRun=true` 只统计不落库，便于先看清影响面再执行。
   */
  router.post("/resolve-duplicates", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { dryRun?: unknown };
    try {
      const result = graph.resolveDuplicateEntities({ dryRun: body.dryRun === true });
      res.json({ ...result, dryRun: body.dryRun === true, stats: graph.getStats() });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
