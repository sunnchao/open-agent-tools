import cors from "cors";
import express, { type Express } from "express";
import { resolveRagAuth } from "./http/auth.js";
import type { ServerConfig } from "./config.js";
import { evalRouter } from "./eval/router.js";
import { analyticsRouter } from "./routes/analytics.js";
import { documentsRouter } from "./routes/documents.js";
import { graphRouter } from "./routes/graph.js";
import { healthRouter } from "./http/health.js";
import { queryRouter } from "./routes/query.js";
import type { RagRuntime } from "./runtime.js";
import { ragUsageMiddleware } from "./http/usage.js";

/** 只组装 HTTP；导入或创建应用不会加载环境、连接外部服务或监听端口。 */
export function createApp(config: ServerConfig, runtime: RagRuntime): Express {
  const { knowledge, capabilities, analytics, usage } = runtime;
  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(resolveRagAuth(config.auth).middleware);
  app.use(express.json({ limit: "2mb" }));
  app.use(ragUsageMiddleware(usage));

  app.get("/api/usage/events", (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) {
      res.status(400).json({ error: "after must be a non-negative integer" });
      return;
    }
    res.json(usage.events(after));
  });
  app.use("/api", healthRouter(capabilities));
  app.use(
    "/api",
    documentsRouter({
      knowledge,
      defaults: config.chunk,
      ocrDecision: config.ocr.decision,
      capabilities,
    }),
  );
  app.use(
    "/api",
    queryRouter({
      rag: knowledge.rag,
      crag: knowledge.crag,
      analytics,
      llm: runtime.llm,
      ...capabilities,
    }),
  );
  app.use("/api/graph", graphRouter(knowledge));
  app.use("/api/analytics", analyticsRouter({ analytics }));
  app.use("/api/eval", evalRouter({ store: runtime.evalStore, runner: runtime.evalRunner }));
  return app;
}
