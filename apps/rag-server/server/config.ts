import { resolve } from "node:path";
import {
  DEFAULT_SEPARATORS,
  normalizeOcrDecision,
  type ElasticsearchStoreOptions,
  type HybridVectorStoreOptions,
  type PgVectorStoreOptions,
} from "@open-agent-tools/rag";
import {
  parseChunkStrategy,
  parseSemanticThreshold,
  parseSeparators,
  type ChunkSettings,
} from "./knowledge/chunk-settings.js";

export type StoreKind = "sqlite" | "pgvector" | "elasticsearch";
export type ServerConfig = ReturnType<typeof readServerConfig>;

/** 只解析配置，不加载 .env、不创建连接，便于测试及嵌入其他 HTTP 入口。 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env) {
  const requested = (env.RAG_STORE ?? "pgvector").trim().toLowerCase();
  const kind: StoreKind =
    requested === "pg" || requested === "postgres"
      ? "pgvector"
      : requested === "es"
        ? "elasticsearch"
        : (requested as StoreKind);
  if (!["sqlite", "pgvector", "elasticsearch"].includes(kind)) {
    throw new Error("RAG_STORE must be pgvector, elasticsearch or sqlite");
  }
  const pgUrl = env.RAG_PG_URL?.trim() || env.DATABASE_URL?.trim();
  const esNode = env.RAG_ES_NODE?.trim();
  if (kind === "pgvector" && !pgUrl) {
    throw new Error("RAG_STORE=pgvector requires RAG_PG_URL or DATABASE_URL");
  }
  if (kind === "elasticsearch" && !esNode) {
    throw new Error("RAG_STORE=elasticsearch requires RAG_ES_NODE");
  }
  const postgres: PgVectorStoreOptions | undefined =
    kind === "pgvector"
      ? {
          connectionString: pgUrl,
          tablePrefix: env.RAG_PG_TABLE_PREFIX?.trim() || "rag",
          dims: Number(env.RAG_PG_DIMS) || 1536,
          metric:
            env.RAG_PG_METRIC?.trim() === "l2"
              ? "l2"
              : env.RAG_PG_METRIC?.trim() === "inner_product"
                ? "inner_product"
                : "cosine",
        }
      : undefined;
  const elasticsearch: ElasticsearchStoreOptions | undefined =
    kind !== "sqlite" && esNode
      ? {
          node: esNode,
          indexPrefix: env.RAG_ES_INDEX_PREFIX?.trim() || "rag",
          dims: Number(env.RAG_ES_DIMS) || 1536,
          clientOptions: {
            requestTimeout: Number(env.RAG_ES_REQUEST_TIMEOUT_MS) || 3000,
            maxRetries: Number(env.RAG_ES_MAX_RETRIES) || 0,
          },
        }
      : undefined;
  const syncMode: HybridVectorStoreOptions["syncMode"] =
    env.RAG_ES_SYNC_MODE?.trim() === "strict" ? "strict" : "lenient";
  const keywordFailureMode: HybridVectorStoreOptions["keywordFailureMode"] =
    env.RAG_ES_QUERY_MODE?.trim() === "strict" ? "strict" : "degrade";
  const chunk: ChunkSettings = {
    chunkSize: Number(env.RAG_CHUNK_SIZE) || 500,
    chunkOverlap: Number(env.RAG_CHUNK_OVERLAP) || 50,
    chunkStrategy: parseChunkStrategy(env.RAG_CHUNK_STRATEGY, "fixed"),
    separators: parseSeparators(env.RAG_SEPARATORS, DEFAULT_SEPARATORS),
    semanticThreshold: parseSemanticThreshold(env.RAG_SEMANTIC_THRESHOLD, 0.75),
  };
  return {
    port: Number(env.RAG_API_PORT) || 4001,
    host: env.RAG_BIND_HOST?.trim() || (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
    corsOrigin: env.RAG_CORS_ORIGIN?.trim() || false,
    auth: { runtimeToken: env.RAG_RUNTIME_TOKEN ?? "", adminToken: env.RAG_ADMIN_TOKEN ?? "" },
    // 相对路径继续以 server/ 为基准，兼容既有部署配置。
    dbPath: resolve(import.meta.dirname, env.RAG_DB_PATH ?? "../rag.db"),
    graphDbPath: resolve(import.meta.dirname, env.RAG_GRAPH_DB_PATH ?? "../rag-graph.db"),
    retentionDays: Number(env.RAG_QUERY_RETENTION_DAYS) || 90,
    graphRetrieval: env.RAG_GRAPH_RETRIEVAL !== "false",
    autoExtract: env.RAG_AUTO_EXTRACT !== "false",
    // 抽取是 LLM 往返，串行会让大文档建图极慢；并发只作用于抽取调用，写库仍串行。
    // 单块抽取 30s+ / 4000+ 输出 token，并发过高会撞上游 QPM 限流（实测 429 达 48%）。
    graphExtractConcurrency: Number(env.RAG_GRAPH_EXTRACT_CONCURRENCY) || 2,
    // Gleaning 补充轮数（含首轮），1 表示关闭。提升召回但线性增加 token 成本。
    graphGleaningRounds: Number(env.RAG_GRAPH_GLEANING_ROUNDS) || 1,
    chunk,
    ocr: {
      decision: normalizeOcrDecision({
        enabled: env.RAG_OCR_ENABLED === "true",
        minCharsPerPage: Number(env.RAG_OCR_MIN_CHARS_PER_PAGE) || 50,
        maxPagesSync: Number(env.RAG_OCR_MAX_PAGES_SYNC) || 10,
      }),
      langs: env.RAG_OCR_LANGS?.trim() || "chi_sim+eng",
      modelPath: env.RAG_TESSERACT_MODEL_PATH?.trim() || undefined,
    },
    model: {
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_API_BASE_URL,
      embeddings: env.OPENAI_EMBEDDINGS_MODEL ?? "text-embedding-3-small",
      chat: env.OPENAI_API_MODEL ?? "gpt-4o-mini",
    },
    store: { kind, postgres, elasticsearch, syncMode, keywordFailureMode },
  };
}
