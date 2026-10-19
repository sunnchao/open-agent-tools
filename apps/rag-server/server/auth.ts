import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type RagAccessScope = "runtime" | "admin";

export interface RagAuthOptions {
  runtimeToken?: string;
  adminToken?: string;
}

export interface RagAuth {
  enabled: boolean;
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  requiredScope: (method: string, path: string) => RagAccessScope | null;
}

function normalizeToken(value: string | undefined): string | null {
  const token = value?.trim();
  return token ? token : null;
}

function bearerToken(req: Request): string | null {
  const match = (req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function tokensEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

/**
 * rag-server 的服务间鉴权。
 *
 * 只有在线检索与图谱检索是 runtime 能力；文档、图谱管理和评测全部是 admin。
 * 未配置 token 时保持本地开发体验，但生产启动入口会拒绝裸奔。
 */
export function resolveRagAuth(options: RagAuthOptions = {}): RagAuth {
  const runtimeToken = normalizeToken(options.runtimeToken ?? process.env.RAG_RUNTIME_TOKEN);
  const adminToken = normalizeToken(options.adminToken ?? process.env.RAG_ADMIN_TOKEN);
  const enabled = Boolean(runtimeToken || adminToken);

  const requiredScope = (method: string, path: string): RagAccessScope | null => {
    if (method === "OPTIONS" || path === "/api/health") return null;
    if (!path.startsWith("/api/")) return null;
    if (method === "POST" && (path === "/api/query" || path === "/api/graph/retrieve")) {
      return "runtime";
    }
    if (method === "PUT" && /^\/api\/query\/[^/]+\/feedback$/.test(path)) return "runtime";
    return "admin";
  };

  const allows = (scope: RagAccessScope, presented: string): boolean => {
    if (adminToken && tokensEqual(adminToken, presented)) return true;
    return scope === "runtime" && Boolean(runtimeToken && tokensEqual(runtimeToken, presented));
  };

  return {
    enabled,
    requiredScope,
    middleware: (req: Request, res: Response, next: NextFunction) => {
      const scope = requiredScope(req.method, req.path);
      if (!scope || !enabled) {
        next();
        return;
      }
      const presented = bearerToken(req);
      if (!presented || !allows(scope, presented)) {
        res.status(401).json({ error: "RAG service token is required" });
        return;
      }
      // 下游据此区分管理侧全量语义与 runtime 的公开默认语义。
      res.locals.ragScope = scope;
      next();
    },
  };
}

/** 生产环境没有服务 token 时必须在启动阶段失败，而不是静默开放。 */
export function assertRagAuthConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (!normalizeToken(env.RAG_RUNTIME_TOKEN) || !normalizeToken(env.RAG_ADMIN_TOKEN)) {
    throw new Error("RAG_RUNTIME_TOKEN and RAG_ADMIN_TOKEN are required in production");
  }
}
