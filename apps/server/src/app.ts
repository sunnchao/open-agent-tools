import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { webOrigin } from "./platform/config.js";
import { resolveStudioAuth, type StudioAuthOptions } from "./platform/auth/studio.js";
import { logTrace } from "./platform/trace.js";
import { healthRouter } from "./http/health.js";
import { resourcesRouter } from "./features/resources/routes.js";
import { sessionsRouter } from "./features/chat/sessions.js";
import { providersRouter } from "./features/providers/routes.js";
import { chatRouter } from "./features/chat/routes.js";
import { workflowRouter } from "./features/workflow/routes.js";
import { imRouter } from "./features/im/routes/status.js";
import { imChannelsRouter } from "./features/im/channels/routes.js";
import { imAccountsRouter } from "./features/im/accounts/routes.js";
import { aiQueryRouter } from "./features/query/dtms/routes.js";
import { oneapiDemoRouter } from "./features/query/text2sql/routes.js";
import { observatoryRouter } from "./features/query/audit/routes.js";
import { schemaSourcesRouter } from "./features/query/schema/routes.js";
import { mcpGatewayRouter } from "./features/mcpGateway/routes.js";
import { metricsRouter } from "./features/query/metrics/routes.js";
import { caliberRouter } from "./features/query/caliber/routes.js";
import { usageRouter } from "./platform/usage/routes.js";
import { workspacesRouter } from "./platform/workspace/routes.js";
import { publishedAppsRouter } from "./features/apps/routes.js";
import { appChatRouter } from "./features/apps/chat.js";
import { ragAdminRouter } from "./features/rag/routes.js";
import { connectorsRouter } from "./features/connectors/routes.js";
import { reportsRouter } from "./features/reports/routes.js";
import { brandingRouter } from "./features/branding/routes.js";
import { identityRouter } from "./platform/auth/routes.js";
import { auditRouter } from "./features/audit/routes.js";
import { memoryRouter } from "./features/memory/routes.js";

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
