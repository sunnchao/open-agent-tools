import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GatewayAccessError, type GatewayAccessService } from "./access.js";
import { createManagedMcpServer } from "./managed-server.js";
import type { ToolExecutor } from "./tool-executor.js";

export interface GatewayAppOptions {
  access: GatewayAccessService;
  executor?: ToolExecutor;
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
    const rawKey = bearerToken(request);
    if (!rawKey) {
      response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }

    try {
      const authorized = await options.access.authorize(
        rawKey,
        request.params.serviceSlug as string,
      );
      const server = createManagedMcpServer(authorized, { executor: options.executor });
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
