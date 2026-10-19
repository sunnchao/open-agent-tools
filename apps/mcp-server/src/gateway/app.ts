import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import {
  captureAuditResponse,
  redactAuditPayload,
  type AuditEvent,
} from "@open-agent-tools/observability/audit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GatewayAccessError, type GatewayAccessService } from "./access.js";
import { createManagedMcpServer } from "./managed-server.js";
import type { GatewayQuotaService } from "./quota.js";
import type { ToolExecutor } from "./tool-executor.js";
import type { AuthorizedService } from "./access.js";
import type { GatewayAuditSink } from "./audit.js";

export interface GatewayAppOptions {
  access: GatewayAccessService;
  executor?: ToolExecutor;
  audit?: GatewayAuditSink;
  quota?: GatewayQuotaService;
}

function bearerToken(request: Request): string | null {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function methodNotAllowed(response: Response): void {
  response
    .status(405)
    .type("application/json")
    .json({
      jsonrpc: "2.0",
      error: { code: -32_000, message: "Method not allowed" },
      id: null,
    });
}

export function createGatewayApp(options: GatewayAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/mcp/services", async (request, response) => {
    const rawKey = bearerToken(request);
    if (!rawKey) {
      response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }

    try {
      const services = await options.access.listAuthorizedServices(rawKey);
      response.json({ services });
    } catch (error) {
      console.error("MCP gateway request failed", error);
      if (error instanceof GatewayAccessError) {
        const status = error.code === "UNAUTHORIZED" ? 401 : 503;
        response.status(status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (!response.headersSent) {
        response
          .status(500)
          .json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
      }
    }
  });

  app.get("/mcp/services/:serviceSlug", (_request, response) => methodNotAllowed(response));
  app.delete("/mcp/services/:serviceSlug", (_request, response) => methodNotAllowed(response));

  app.post("/mcp/services/:serviceSlug", async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    let authorized: AuthorizedService | undefined;
    let reserved = false;
    response.setHeader("x-request-id", requestId);
    if (options.audit) {
      const output = captureAuditResponse(response);
      response.once("finish", () => {
        const result = output();
        const body = result as { error?: unknown; result?: { isError?: boolean } } | null;
        const method = typeof request.body?.method === "string" ? request.body.method : "unknown";
        const event: AuditEvent = {
          id: randomUUID(),
          actorId: authorized?.clientId ?? "unauthenticated",
          actorRole: "client",
          source: "gateway",
          action: `MCP ${method}`.slice(0, 180),
          target: request.originalUrl.split("?", 1)[0]!.slice(0, 2000),
          requestId,
          outcome:
            response.statusCode >= 400 || body?.error || body?.result?.isError === true
              ? "FAILED"
              : "SUCCEEDED",
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
          createdAt: new Date().toISOString(),
          input: redactAuditPayload(request.body),
          output: redactAuditPayload(result),
          context: redactAuditPayload({
            serviceSlug: request.params.serviceSlug,
            serviceId: authorized?.snapshot.serviceId,
            versionId: authorized?.snapshot.versionId,
            imageDigest: authorized?.snapshot.imageDigest,
            limits: authorized?.snapshot.limits,
            clientId: authorized?.clientId,
            rpcRequestId: request.body?.id,
            clientRequestId: request.header("x-request-id"),
          }),
        };
        void Promise.resolve()
          .then(() => options.audit!.record(event))
          .catch(() => {
            console.error("Failed to report MCP audit event");
          });
      });
    }
    const rawKey = bearerToken(request);
    if (!rawKey) {
      response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }

    try {
      authorized = await options.access.authorize(rawKey, request.params.serviceSlug as string);
      const method = typeof request.body?.method === "string" ? request.body.method : null;
      if (method === "tools/call" && options.quota) {
        const toolName =
          typeof request.body?.params?.name === "string" ? request.body.params.name : "";
        const reservation = await options.quota.reserve({
          requestId,
          clientId: authorized.clientId,
          serviceId: authorized.snapshot.serviceId,
          versionId: authorized.snapshot.versionId,
          toolName,
        });
        if (!reservation.reserved) {
          response.setHeader("retry-after", String(reservation.retryAfterSeconds));
          response.status(429).json({
            error: {
              code: "RATE_LIMITED",
              message: "MCP client quota exceeded",
              retryAfterSeconds: reservation.retryAfterSeconds,
            },
          });
          return;
        }
        reserved = true;
      }
      const server = createManagedMcpServer(authorized, {
        executor: options.executor,
        createRequestId: () => requestId,
        quota: options.quota,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (reserved && options.quota) {
        reserved = false;
        await options.quota.settle({
          requestId,
          status: "FAILED",
          durationMs: Date.now() - startedAt,
        });
      }
      if (error instanceof GatewayAccessError) {
        const status =
          error.code === "UNAUTHORIZED"
            ? 401
            : error.code === "FORBIDDEN"
              ? 403
              : error.code === "NOT_FOUND"
                ? 404
                : 503;
        response.status(status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (!response.headersSent) {
        response
          .status(500)
          .json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
      }
    }
  });

  return app;
}
