import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { CallbackHandler } from "@langfuse/langchain";
import {
  ElasticsearchVectorStore,
  HybridVectorStore,
  PgVectorStore,
  Rag,
  TesseractOcrProvider,
} from "@open-agent-tools/rag";
import { KnowledgeGraph } from "@open-agent-tools/rag/graph";
import { RagAnalyticsStore } from "./analytics.js";
import type { ServerConfig } from "./config.js";
import { EvalRunner } from "./eval/runner.js";
import { EvalStore } from "./eval/store.js";
import { KnowledgeBase } from "./knowledge.js";
import { RagUsageStore, trackRagLlm } from "./usage.js";

export type RagRuntime = ReturnType<typeof createRuntime>;

/** 唯一依赖装配入口；不监听端口，HTTP 应用和测试复用同一组实例。 */
export function createRuntime(config: ServerConfig) {
  const { apiKey, baseURL } = config.model;
  const embeddings = apiKey
    ? new OpenAIEmbeddings({
        model: config.model.embeddings,
        configuration: { baseURL, apiKey },
      })
    : undefined;
  const llm = apiKey
    ? new ChatOpenAI({ model: config.model.chat, configuration: { baseURL, apiKey } })
    : undefined;
  if (llm) {
    llm.callbacks = [new CallbackHandler({ tags: ["rag-server"], version: "0.0.0" })];
  }

  const pg = config.store.postgres ? new PgVectorStore(config.store.postgres) : undefined;
  const es = config.store.elasticsearch
    ? new ElasticsearchVectorStore(config.store.elasticsearch)
    : undefined;
  const store =
    pg && es
      ? new HybridVectorStore({
          vectorStore: pg,
          keywordStore: es,
          syncMode: config.store.syncMode,
          keywordFailureMode: config.store.keywordFailureMode,
        })
      : (pg ?? es);
  const graph = new KnowledgeGraph({
    dbPath: config.graphDbPath,
    embeddings,
    extractConcurrency: config.graphExtractConcurrency,
    gleaningRounds: config.graphGleaningRounds,
    llmChat: llm
      ? async (system, user) => {
          const response = await trackRagLlm("rag_graph", llm.model, () =>
            llm.invoke([
              { role: "system", content: system },
              { role: "user", content: user },
            ]),
          );
          return typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content);
        }
      : undefined,
  });
  const rag = new Rag({
    embeddings,
    dbPath: config.dbPath,
    store,
    ...config.chunk,
    ocrDecision: config.ocr.decision,
    ocr: config.ocr.decision.enabled
      ? new TesseractOcrProvider({ langs: config.ocr.langs, modelPath: config.ocr.modelPath })
      : undefined,
    graph,
  });
  const knowledge = new KnowledgeBase({ rag, graph, autoExtract: config.autoExtract });
  const analytics = new RagAnalyticsStore(config.dbPath, config.retentionDays);
  const usage = new RagUsageStore(config.dbPath);
  const evalStore = new EvalStore(config.dbPath);
  const evalRunner = new EvalRunner({
    store: evalStore,
    retrieve: async (query, options) =>
      (await rag.retrieve(query, { ...options, graph: config.graphRetrieval })).chunks,
  });
  const capabilities = {
    storeKind: config.store.kind,
    keywordStore: pg && es ? ("elasticsearch" as const) : undefined,
    embeddingsEnabled: Boolean(embeddings),
    llmAvailable: Boolean(llm),
    ocrEnabled: config.ocr.decision.enabled,
    ocrMinCharsPerPage: config.ocr.decision.minCharsPerPage,
    ocrMaxPagesSync: config.ocr.decision.maxPagesSync,
    graphRetrieval: config.graphRetrieval,
  };
  return {
    knowledge,
    llm,
    analytics,
    usage,
    evalStore,
    evalRunner,
    capabilities,
    async close() {
      await knowledge.waitIdle();
      // 后台抽取完成后再关闭模型用量和数据库，避免尾部任务访问已关闭的句柄。
      await rag.close();
      graph.close();
      analytics.close();
      usage.close();
      evalStore.close();
    },
  };
}
