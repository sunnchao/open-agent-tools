import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { webOrigin } from "./config.js";
import { logTrace } from "./trace.js";
import { healthRouter } from "./routes/health.js";
import { resourcesRouter } from "./routes/resources.js";
import { sessionsRouter } from "./routes/sessions.js";
import { providersRouter } from "./routes/providers.js";
import { chatRouter } from "./routes/chat.js";
import { workflowRouter } from "./routes/workflow.js";

export function createApp(): express.Express {
  const app: express.Express = express();

  app.use(cors({ origin: webOrigin }));
  app.use(express.json({ limit: "100mb" }));

  // 请求级 trace：所有端点进出、状态码与耗时（health 探活静默，避免刷屏）。
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const isHealth = req.path === "/health" && res.statusCode < 400;
      if (isHealth) return;
      logTrace(
        "http.request",
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        },
        res.statusCode >= 400 ? "warn" : "info",
      );
    });
    next();
  });

  app.use(healthRouter);
  app.use(resourcesRouter);
  app.use(sessionsRouter);
  app.use(providersRouter);
  app.use(chatRouter);
  app.use(workflowRouter);

  return app;
}
