import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
// 必须在任何使用 @langfuse/* 的模块之前初始化 Langfuse（读取 LANGFUSE_* 环境变量）。
import { initLangfuse } from "@open-agent-tools/observability";
initLangfuse({ serviceName: "open-agent-server", envRoot: "../" });
import { createApp } from "./app.js";
import { port } from "./platform/config.js";
import { getDbPath, openDb } from "./platform/db.js";
import { initializeProviders } from "./features/providers/store.js";
import { initializeImAccounts } from "./features/im/accounts/store.js";
import { logTrace } from "./platform/trace.js";
import { startImIfConfigured } from "./features/im/index.js";
import { startReportScheduler } from "./features/reports/scheduler.js";

loadEnv({ path: resolve(import.meta.dirname, "../.env") });
loadEnv({ path: resolve(import.meta.dirname, "../.env.local"), override: true });

openDb();
initializeProviders();
initializeImAccounts();

const app = createApp();

export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`server listening on http://localhost:${port}`);
    console.log(`sqlite: ${getDbPath()}`);
    logTrace("server.started", {
      port,
      db: getDbPath(),
      env: process.env.NODE_ENV ?? "development",
    });
    void startImIfConfigured();
    // C6 定时报表:进程内分钟级 tick(REPORT_SCHEDULER=off 可关闭)。
    startReportScheduler();
  });
}
