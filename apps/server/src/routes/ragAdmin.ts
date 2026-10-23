import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { Router, type Request, type Response } from "express";
import { logTrace, truncate } from "../trace.js";
import { resolveWorkspace } from "../workspace.js";
import { ragConfig } from "../ragConfig.js";

export const ragAdminRouter: ReturnType<typeof Router> = Router();

/**
 * Studio 的 RAG/Graph 管理 BFF。
 *
 * 浏览器只携带 Studio 部署 token；RAG_ADMIN_TOKEN 永远留在服务端。
 * 这里不做字段级白名单转译，保持上游错误码与内容类型不变，便于前端平滑迁移。
 */
ragAdminRouter.use("/api/admin/rag", async (req: Request, res: Response) => {
  if (req.path === "/" || req.path === "") {
    res.status(404).json({ error: "RAG admin route not found" });
    return;
  }
  const { baseUrl, token } = ragConfig();
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const target = `${baseUrl}${req.originalUrl.replace(/^\/api\/admin\/rag/, "")}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (["host", "authorization", "content-length", "connection"].includes(name)) continue;
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
  }
  if (token) headers.set("authorization", `Bearer ${token}`);
  headers.set("x-workspace-id", workspace.workspaceId);

  try {
    await proxyRequest(req, res, target, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTrace("rag_admin.proxy_error", { path: req.path, error: truncate(message, 300) }, "error");
    if (!res.headersSent) {
      res.status(502).json({ error: "RAG admin service unavailable" });
    } else {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
});

function proxyRequest(
  req: Request,
  res: Response,
  target: string,
  headers: Headers,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: req.method,
        headers: Object.fromEntries(headers.entries()),
      },
      (upstream) => {
        res.status(upstream.statusCode ?? 502);
        copyHeader(upstream, res, "content-type");
        copyHeader(upstream, res, "content-disposition");
        copyHeader(upstream, res, "cache-control");
        copyHeader(upstream, res, "retry-after");
        upstream.pipe(res);
        upstream.once("end", resolve);
        upstream.once("error", reject);
      },
    );

    request.once("error", reject);
    res.once("close", () => {
      if (!res.writableEnded) request.destroy();
    });

    const body = parsedJsonBody(req);
    if (body !== undefined) {
      request.end(body);
      return;
    }

    if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
      request.end();
      return;
    }

    // multipart/form-data and other unparsed bodies must be streamed byte-for-byte.
    // Re-serializing FormData here would lose the boundary and the uploaded files.
    req.pipe(request);
  });
}

function parsedJsonBody(req: Request): Buffer | undefined {
  if (req.readableEnded) {
    // express.json has already consumed JSON. The raw bytes are retained by the
    // body parser's verify hook so the upstream request remains byte-identical.
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (raw) return raw;
    if (req.is("application/json")) return Buffer.from(JSON.stringify(req.body ?? {}));
  }
  return undefined;
}

function copyHeader(upstream: IncomingMessage, response: Response, name: string): void {
  const value = upstream.headers[name];
  if (typeof value === "string") response.setHeader(name, value);
}
