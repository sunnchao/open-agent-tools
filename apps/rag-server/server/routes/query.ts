import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ChatOpenAI } from "@langchain/openai";
import type { ChannelHit, GraphAugmentation, Rag } from "@open-agent-tools/rag";
import type { CragController } from "@open-agent-tools/rag/crag";
import { runTraced, withTraceAttributes } from "@open-agent-tools/observability";
import { RagAnalyticsStore, type QueryEventInput, type RetrievalTrace } from "../analytics.js";
import type { StoreKind } from "../config.js";
import { clampInt, queryFeedback, retrievalScope, routeParam } from "../request-validation.js";
import { trackRagLlm } from "../usage.js";

const DEFAULT_GRAPH_HOPS = 2;
const MAX_GRAPH_HOPS = 4;
const MIN_GRAPH_HOPS = 1;
/** 审计里保存的图谱上下文上限：子图文本可能很长，但 trace 只用于排查。 */
const MAX_TRACE_GRAPH_CONTEXT = 8000;

type RetrieveResultLike = Awaited<ReturnType<Rag["retrieve"]>>;

export interface QueryRouterOptions {
  rag: Rag;
  analytics: RagAnalyticsStore;
  /** CRAG 控制器：固定装配 block + graph 双域，行为与改造前保持一致。 */
  crag: Pick<CragController, "retrieve">;
  /** 有 Key 时用于生成回答；缺省时 generate 请求返回 answer=null。 */
  llm?: ChatOpenAI;
  embeddingsEnabled: boolean;
  storeKind: StoreKind;
  /** 全局图谱开关（RAG_GRAPH_RETRIEVAL !== "false"）。请求可再单独关闭。 */
  graphRetrieval: boolean;
}

/** 图谱增强结果：未启用/未命中时也返回稳定结构，前端无需判空。 */
export type GraphPayload = GraphAugmentation;

/** 未启用时的稳定结构；每次返回新对象，避免调用方误改共享常量。 */
function emptyGraphPayload(): GraphPayload {
  return { enabled: false, seeds: [], entities: 0, relations: 0, chunkHits: 0, context: "" };
}

export function clampGraphHops(value: unknown): number {
  return clampInt(value, DEFAULT_GRAPH_HOPS, MIN_GRAPH_HOPS, MAX_GRAPH_HOPS);
}

/**
 * 回答用 system prompt：知识图谱文本作为「知识区块」的补充事实。
 * 无 graph 上下文时输出必须与改造前逐字节一致，避免无图谱环境的行为漂移。
 */
export function buildAnswerSystemPrompt(formatted: string, graphContext?: string | null): string {
  const base =
    "你是知识库问答助手。基于提供的资料回答用户问题；资料未覆盖的内容请如实说明，不要编造。引用请标注【来源】。\n\n";
  const graphText = graphContext?.trim();
  return graphText ? `${base}${formatted}\n\n【知识图谱】\n${graphText}` : `${base}${formatted}`;
}

export function graphPayload(result: RetrieveResultLike): GraphPayload {
  return result.graph ?? emptyGraphPayload();
}

export function toRetrievalPayload(
  result: RetrieveResultLike,
  context: { storeKind: string; embeddingsEnabled: boolean },
): Record<string, unknown> {
  const debug = result.debug;
  const timings = debug?.timingsMs ?? { vectorMs: null, keywordMs: 0, fusionMs: 0 };
  return {
    store: context.storeKind,
    embeddingsEnabled: debug?.embeddingsEnabled ?? context.embeddingsEnabled,
    candidates: debug?.candidates ?? 30,
    rrfK: debug?.rrfK ?? 60,
    // 仅「仅向量」模式显式写 false；默认两路/三路请求不写该键，保持旧响应形状。
    ...(debug?.keywordEnabled === false ? { keywordEnabled: false } : {}),
    graphEnabled: result.graph?.enabled ?? debug?.graphEnabled ?? false,
    timingsMs: { ...timings, graphMs: timings.graphMs ?? null },
    vectorHits: debug?.vectorHits ?? [],
    keywordHits: debug?.keywordHits ?? [],
    graphHits: debug?.graphHits ?? [],
  };
}

export function buildRetrievalTrace(input: {
  storeKind: string;
  embeddingsEnabled: boolean;
  visibleSources: string[] | undefined;
  viewerGroups: string[] | undefined;
  result: RetrieveResultLike;
  formatted: string;
  answer: string | null;
}): RetrievalTrace {
  const debug = input.result.debug;
  let truncated = false;
  const traceHits = (hits: ChannelHit[] = []) =>
    hits.map((hit) => {
      const content = truncateContent(hit.content);
      truncated = truncated || content.truncated;
      return {
        id: hit.id,
        source: hit.source,
        chunkIndex: hit.chunkIndex,
        content: content.content,
        score: hit.score,
        rank: hit.rank,
      };
    });
  const rawGraphContext = input.result.graph?.context ?? "";
  const graphContextTruncated = rawGraphContext.length > MAX_TRACE_GRAPH_CONTEXT;
  truncated = truncated || graphContextTruncated;
  const graphContext = rawGraphContext
    ? graphContextTruncated
      ? `${rawGraphContext.slice(0, MAX_TRACE_GRAPH_CONTEXT)}…(truncated)`
      : rawGraphContext
    : null;
  const fused = input.result.chunks.map((c) => ({
    id: c.id,
    source: c.source,
    chunkIndex: c.chunkIndex,
    content: c.content,
    score: c.score,
    rank: -1,
    vectorScore: c.debug?.vectorScore ?? null,
    vectorRank: c.debug?.vectorRank ?? null,
    keywordScore: c.debug?.keywordScore ?? null,
    keywordRank: c.debug?.keywordRank ?? null,
    graphScore: c.debug?.graphScore ?? null,
    graphRank: c.debug?.graphRank ?? null,
    rrfScore: c.debug?.rrfScore ?? c.score,
    channels: c.debug?.channels ?? [],
  }));
  return {
    store: input.storeKind,
    embeddingsEnabled: input.embeddingsEnabled,
    candidates: debug?.candidates ?? 30,
    rrfK: debug?.rrfK ?? 60,
    timingsMs: {
      ...(debug?.timingsMs ?? { vectorMs: null, keywordMs: 0, fusionMs: 0 }),
      graphMs: debug?.timingsMs?.graphMs ?? null,
    },
    visibleSources: input.visibleSources,
    viewerGroups: input.viewerGroups,
    vectorHits: traceHits(debug?.vectorHits),
    keywordHits: traceHits(debug?.keywordHits),
    graphHits: traceHits(debug?.graphHits),
    ...(debug?.keywordEnabled === false ? { keywordEnabled: false } : {}),
    graphEnabled: input.result.graph?.enabled ?? debug?.graphEnabled ?? false,
    graphContext,
    fused,
    formatted:
      input.formatted.length > 20000
        ? `${input.formatted.slice(0, 20000)}…(truncated)`
        : input.formatted,
    answer: input.answer,
    truncated: truncated || input.formatted.length > 20000,
  };
}

/** 混合检索（+ 可选 LLM 生成回答 / CRAG 纠正评估）。 */
export function queryRouter(options: QueryRouterOptions): Router {
  const { rag, analytics, crag, llm, graphRetrieval } = options;
  const router: Router = Router();
  const payloadContext = {
    storeKind: options.storeKind,
    embeddingsEnabled: options.embeddingsEnabled,
  };

  /** 统计写入失败不应拖垮在线问答，错误保留在服务日志中。 */
  function recordAnalytics(input: QueryEventInput): void {
    try {
      analytics.recordQuery(input);
    } catch (error) {
      console.error(`[rag-analytics] failed to record query ${input.id}: ${String(error)}`);
    }
  }

  router.post("/query", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      query?: unknown;
      topK?: unknown;
      generate?: unknown;
      sources?: unknown;
      viewerGroups?: unknown;
      crag?: unknown;
      graph?: unknown;
      graphHops?: unknown;
      /** 关键词通道开关；false 时只保留向量召回（「仅向量」模式）。 */
      keyword?: unknown;
    };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const topK = clampTopK(body.topK);
    const generate = Boolean(body.generate);
    const useCrag = Boolean(body.crag);
    // 全局开关优先：部署侧可用 RAG_GRAPH_RETRIEVAL=false 一键回退到两路检索；
    // 请求体只能在此基础上关闭，不能推翻部署配置强行开启。
    const useGraph = graphRetrieval && body.graph !== false;
    const graphHops = clampGraphHops(body.graphHops);
    // 关键词通道默认开启；只有显式传 keyword:false 才退化为「仅向量」模式。
    const useKeyword = body.keyword !== false;
    const queryId = randomUUID();
    const queryStartedAt = Date.now();
    let analyticsRecorded = false;
    let sources: string[] | undefined;
    let viewerGroups: string[] | undefined;
    let visibleSources: string[] | undefined;
    let sourceCount = 0;
    try {
      ({ sources, viewerGroups } = retrievalScope(body, res.locals.ragScope));
      visibleSources = await rag.resolveVisibleSources(sources, viewerGroups);
      sourceCount = visibleSources?.length ?? (await rag.listSources()).length;
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      await runTraced("rag-query", async (span) => {
        span.update({
          input: {
            query,
            topK,
            sources,
            generate,
            crag: useCrag,
            graph: useGraph,
            graphHops: useGraph ? graphHops : null,
            keyword: useKeyword,
          },
          metadata: {
            sources: (sources ?? []).join(","),
            topK: String(topK),
            graph: String(useGraph),
          },
        });
        await withTraceAttributes(
          {
            tags: ["rag"],
            metadata: { source: "query", generate: String(generate), crag: String(useCrag) },
          },
          async () => {
            try {
              // CRAG 模式：评估 + 纠正 + 条带精炼
              if (useCrag) {
                // CRAG 控制器内部直接合并 block/graph 证据；此处先按文档 ACL 收窄来源。
                const result = await crag.retrieve(query, {
                  ...(visibleSources !== undefined ? { sources: visibleSources } : {}),
                });
                let answer: string | null = null;
                if (generate && llm && result.formatted) {
                  const resp = await trackRagLlm("rag_query", llm.model, () =>
                    llm.invoke([
                      {
                        role: "system",
                        content:
                          "你是知识库问答助手。基于提供的资料回答用户问题；资料未覆盖的内容请如实说明，不要编造。引用请标注【来源】。\n\n" +
                          result.formatted,
                      },
                      { role: "user", content: query },
                    ]),
                  );
                  answer =
                    typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
                }
                span.update({
                  output: {
                    assessment: result.assessment,
                    confidence: result.confidence,
                    actions: result.actions.join(","),
                    citations: result.citations.length,
                    answer: summarize(answer),
                  },
                });
                recordAnalytics({
                  id: queryId,
                  query,
                  sources,
                  sourceCount,
                  topK,
                  generate,
                  crag: true,
                  hits: result.citations,
                  answerGenerated: Boolean(answer),
                  answer,
                  assessment: result.assessment,
                  actions: result.actions,
                  latencyMs: Date.now() - queryStartedAt,
                });
                analyticsRecorded = true;
                res.json({
                  queryId,
                  query,
                  crag: {
                    assessment: result.assessment,
                    confidence: result.confidence,
                    actions: result.actions,
                  },
                  formatted: result.formatted,
                  citations: result.citations,
                  answer,
                  generate,
                  llmAvailable: Boolean(llm),
                });
                return;
              }

              // graph: false 关闭图谱第三路；keyword: false 关闭关键词通道。
              // 两者都关闭时即为「仅向量」检索模式。
              const result = await rag.retrieve(query, {
                topK,
                sources: visibleSources,
                ...(useGraph ? { graphHops } : { graph: false }),
                ...(useKeyword ? {} : { keyword: false }),
              });
              let answer: string | null = null;
              if (generate && llm && result.chunks.length > 0) {
                const resp = await trackRagLlm("rag_query", llm.model, () =>
                  llm.invoke([
                    {
                      role: "system",
                      content: buildAnswerSystemPrompt(result.formatted(), result.graph?.context),
                    },
                    { role: "user", content: query },
                  ]),
                );
                answer =
                  typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
              }
              span.update({
                output: {
                  chunks: result.chunks.length,
                  vectorHits: result.debug?.vectorHits.length ?? 0,
                  keywordHits: result.debug?.keywordHits.length ?? 0,
                  graphHits: result.debug?.graphHits?.length ?? 0,
                  answer: summarize(answer),
                },
              });
              const trace = buildRetrievalTrace({
                storeKind: options.storeKind,
                embeddingsEnabled: options.embeddingsEnabled,
                visibleSources,
                viewerGroups,
                result,
                formatted: result.formatted(),
                answer,
              });
              recordAnalytics({
                id: queryId,
                query,
                sources,
                sourceCount,
                topK,
                generate,
                crag: false,
                hits: result.chunks,
                answerGenerated: Boolean(answer),
                answer,
                latencyMs: Date.now() - queryStartedAt,
                trace,
              });
              analyticsRecorded = true;
              res.json({
                queryId,
                query,
                chunks: result.chunks,
                retrieval: toRetrievalPayload(result, payloadContext),
                graph: graphPayload(result),
                answer,
                generate,
                llmAvailable: Boolean(llm),
              });
            } catch (error) {
              span.update({
                level: "ERROR",
                statusMessage: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          },
        );
      });
    } catch (e) {
      if (!analyticsRecorded) {
        recordAnalytics({
          id: queryId,
          query,
          sources,
          sourceCount,
          topK,
          generate,
          crag: useCrag,
          hits: [],
          answerGenerated: false,
          latencyMs: Date.now() - queryStartedAt,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      res.status(500).json({ error: String(e), queryId });
    }
  });

  router.get("/query/:queryId", (req: Request, res: Response) => {
    const queryId = routeParam(req.params.queryId);
    const detail = analytics.getQueryDetail(queryId);
    if (!detail) {
      res.status(404).json({ error: "query not found" });
      return;
    }
    res.json({ detail });
  });

  router.put("/query/:queryId/feedback", (req: Request, res: Response) => {
    try {
      const feedback = queryFeedback(req.body);
      const saved = analytics.saveFeedback(
        routeParam(req.params.queryId),
        feedback.rating,
        feedback.comment,
      );
      if (!saved) {
        res.status(404).json({ error: "query not found" });
        return;
      }
      res.json({ feedback: saved });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

function clampTopK(value: unknown): number {
  return clampInt(value, 5, 1, 20);
}

/** 候选 content 截断存 trace（防单次查询 trace 膨胀）；融合块存全量。 */
function truncateContent(content: string, max = 300): { content: string; truncated: boolean } {
  if (content.length <= max) return { content, truncated: false };
  return { content: `${content.slice(0, max)}…(+${content.length - max} chars)`, truncated: true };
}

/** 截断长回答，仅用于 trace output，不影响响应内容。 */
function summarize(value: string | null): string | null {
  if (!value) return value;
  return value.length > 500 ? `${value.slice(0, 500)}…(+${value.length - 500} chars)` : value;
}
