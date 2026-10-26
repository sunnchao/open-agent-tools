import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { webOrigin } from "./config.js";
import { resolveStudioAuth, type StudioAuthOptions } from "./studioAuth.js";
import { logTrace } from "./trace.js";
import { healthRouter } from "./routes/health.js";
import { resourcesRouter } from "./routes/resources.js";
import { sessionsRouter } from "./routes/sessions.js";
import { providersRouter } from "./routes/providers.js";
import { chatRouter } from "./routes/chat.js";
import { workflowRouter } from "./routes/workflow.js";
import { imRouter } from "./routes/im.js";
import { imChannelsRouter } from "./routes/imChannels.js";
import { imAccountsRouter } from "./routes/imAccounts.js";
import { aiQueryRouter } from "./routes/aiQuery.js";
import { oneapiDemoRouter } from "./routes/oneapiDemo.js";
import { observatoryRouter } from "./routes/observatory.js";
import { schemaSourcesRouter } from "./routes/schemaSources.js";
import { mcpGatewayRouter } from "./routes/mcpGateway.js";
import { workflowsRouter } from "./routes/workflows.js";
import { metricsRouter } from "./routes/metrics.js";
import { caliberRouter } from "./routes/caliber.js";
import { usageRouter } from "./routes/usage.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { publishedAppsRouter } from "./routes/publishedApps.js";
import { appChatRouter } from "./routes/appChat.js";
import { ragAdminRouter } from "./routes/ragAdmin.js";
import { connectorsRouter } from "./routes/connectors.js";
import { reportsRouter } from "./routes/reports.js";
import { brandingRouter } from "./routes/branding.js";
import { identityRouter } from "./routes/identity.js";
import { auditRouter } from "./routes/audit.js";
import { memoryRouter } from "./routes/memory.js";

export interface CreateAppOptions {
  studioAuth?: StudioAuthOptions;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app: express.Express = express();

  app.use(cors({ origin: webOrigin }));
  app.use("/v1", express.json({ limit: "2mb" }));
  // 身份断言绑定原始 body 字节；绝不能从解析后的 JSON 重新序列化计算摘要。
  app.use(
    express.json({
      limit: "100mb",
      verify: (req, _res, buffer) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );

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
  // OIDC 优先验证；未配置或验签失败时，显式回退到部署 token（若配置）。
  app.use(resolveStudioAuth(options.studioAuth).middleware);
  app.use(resourcesRouter);
  app.use(sessionsRouter);
  app.use(providersRouter);
  app.use(chatRouter);
  app.use(workflowRouter);
  app.use(workflowsRouter);
  app.use(imRouter);
  app.use(imChannelsRouter);
  app.use(imAccountsRouter);
  app.use(aiQueryRouter);
  app.use(schemaSourcesRouter);
  app.use(mcpGatewayRouter);
  app.use(observatoryRouter);
  app.use(oneapiDemoRouter);
  app.use(metricsRouter);
  app.use(caliberRouter);
  app.use(usageRouter);
  app.use(workspacesRouter);
  app.use(publishedAppsRouter);
  app.use(appChatRouter);
  app.use(ragAdminRouter);
  app.use(connectorsRouter);
  app.use(reportsRouter);
  app.use(brandingRouter);
  app.use(identityRouter);
  app.use(auditRouter);
  app.use(memoryRouter);

  return app;
}
