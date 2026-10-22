import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { initLangfuse } from "@open-agent-tools/observability";
import { createApp } from "./app.js";
import { assertRagAuthConfigured } from "./auth.js";
import { readServerConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

// 可观测性先于模型初始化；环境加载与监听端口只发生在启动入口。
initLangfuse({ serviceName: "open-agent-rag-server", envRoot: "../" });
loadEnv({ path: resolve(import.meta.dirname, "../.env") });
loadEnv({ path: resolve(import.meta.dirname, "../.env.local"), override: true });
assertRagAuthConfigured();

const config = readServerConfig();
const runtime = createRuntime(config);
const server = createApp(config, runtime).listen(config.port, config.host, () => {
  const capabilities = runtime.capabilities;
  console.log(`[rag-server] api listening on http://${config.host}:${config.port}`);
  console.log(
    `[rag-server] store=${capabilities.storeKind} keywordStore=${capabilities.keywordStore ?? capabilities.storeKind}`,
  );
  console.log(`[rag-server] operations=${config.dbPath} graph=${config.graphDbPath}`);
  console.log(
    `[rag-server] embeddings=${capabilities.embeddingsEnabled} llm=${capabilities.llmAvailable} graphRetrieval=${capabilities.graphRetrieval}`,
  );
});

function shutdown() {
  server.close(() => {
    void runtime.close().catch((error) => {
      console.error("[rag-server] shutdown failed", error);
      process.exitCode = 1;
    });
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
