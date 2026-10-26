import {
  normalizeOptionalToken,
  parseBearerToken,
  tokensEqual,
} from "@open-agent-tools/mcp-auth/primitives";
import type { NextFunction, Request, Response } from "express";
import type { JWTVerifyGetKey } from "jose";
import {
  createOidcVerifier,
  enterpriseIdentityStatus,
  logIdentityVerificationFailure,
  readEnterpriseIdentityConfig,
  type EnterpriseIdentityConfig,
  type IdentityStatus,
  type OidcVerifier,
  type StudioActor,
} from "./enterprise.js";
import { logTrace } from "../trace.js";

export type StudioAuthScope = "manage" | "run";
export type { StudioActor };

/**
 * 主服务部署级访问 Token（MVP）：
 * - 未配置时保持本地开发体验，不强制鉴权；
 * - 配置后，所有受保护接口必须携带 `Authorization: Bearer <token>`；
 * - 部署方可以按需把写/管理类接口划为 manage，其余默认只需 run。
 */
export interface StudioAuthResolution {
  enabled: boolean;
  oidcEnabled: boolean;
  status: IdentityStatus;
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  requiredScope: (path: string) => StudioAuthScope | null;
}

export interface StudioAuthOptions {
  token?: string;
  managePrefixes?: string[];
  runPrefixes?: string[];
  oidc?: EnterpriseIdentityConfig["oidc"];
  /** 测试可注入本地 JWKS resolver；生产按 OIDC_JWKS_URI 拉取。 */
  oidcKeySet?: JWTVerifyGetKey;
  /** 允许未配置 OIDC 时继续使用部署 token；默认 true。 */
  deploymentTokenFallback?: boolean;
  /** 测试/嵌入式部署可显式覆盖安全环境变量探测。 */
  requiresAdminAuth?: boolean;
  /** 测试注入：跳过真实 JWKS 网络请求。 */
  oidcVerifier?: OidcVerifier;
}

export interface StudioAuthContext {
  actor: StudioActor;
  scope: StudioAuthScope;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      studioAuth?: StudioAuthContext;
      studioAuthRequired?: boolean;
    }
  }
}

/**
 * 没有任何认证配置时中间件是放行的，管理接口仍不能匿名读取身份状态。
 * 路由通过该 helper 统一区分“未认证的开放部署”和 OIDC/部署 token 管理员。
 */
export function requireStudioAdmin(req: Request, res: Response): boolean {
  const auth = res.locals.studioAuth;
  const authRequired = res.locals.studioAuthRequired;

  // 鉴权中间件未执行（路由被单独挂载）时不能凭环境变量猜测是否开放：一律拒绝。
  if (authRequired === undefined) {
    logTrace(
      "studio.admin_forbidden",
      { method: req.method, path: req.path, reason: "auth middleware not applied" },
      "warn",
    );
    res.status(403).json({ error: "admin role is required" });
    return false;
  }
  // 未配置任何认证的本地部署：中间件已判定无需鉴权。
  if (!authRequired) return true;
  if (auth?.scope === "manage" && auth.actor.role === "admin") return true;

  logTrace("studio.admin_forbidden", { method: req.method, path: req.path }, "warn");
  res.status(403).json({ error: "admin role is required" });
  return false;
}

const DEFAULT_MANAGE_PREFIXES = [
  // 管理写接口：Provider 凭据、数据源连接串、IM 渠道、指标配置等。
  "/api/admin/",
  // 工作流编配：发布、回滚、API Key 签发属于高权限动作。
  "/api/workflows",
];

const DEFAULT_RUN_PREFIXES = ["/api/"];

function isPublicPath(path: string): boolean {
  // 健康检查、工作流对外 API、发布应用的终端用户入口走各自的鉴权通道，不受部署 token 约束。
  // `/api/apps/*` 只暴露 slug 级公开信息与按 slug 的对话，资源范围由发布配置决定，不接受请求方指定。
  // `/api/branding` 只回白标展示字段(无密钥),需要让员工入口与 Studio 启动都能读到。
  return (
    path === "/health" ||
    path === "/api/branding" ||
    path.startsWith("/v1/") ||
    path.startsWith("/api/apps/")
  );
}

/**
 * 部署 token 的唯一读取入口：`STUDIO_API_TOKEN` 优先，`SERVER_API_TOKEN` 为旧别名。
 * 鉴权中间件与身份状态接口都必须经由此处，否则两处会读到不同结果。
 */
export function resolveDeploymentToken(options?: { token?: string }): string {
  return (
    normalizeOptionalToken(options?.token) ??
    normalizeOptionalToken(process.env.STUDIO_API_TOKEN) ??
    normalizeOptionalToken(process.env.SERVER_API_TOKEN) ??
    ""
  );
}

export function resolveStudioAuth(options?: StudioAuthOptions): StudioAuthResolution {
  const token = resolveDeploymentToken(options);
  const managePrefixes = options?.managePrefixes ?? DEFAULT_MANAGE_PREFIXES;
  const runPrefixes = options?.runPrefixes ?? DEFAULT_RUN_PREFIXES;
  const openDevelopment = !token && !options?.oidc && !options?.oidcVerifier;
  let globalIdentityConfig: EnterpriseIdentityConfig;
  let configError: string | null = null;
  try {
    globalIdentityConfig = readEnterpriseIdentityConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTrace("studio.identity_config_invalid", { error: message }, "error");
    configError = message;
    globalIdentityConfig = { oidc: null, ldap: null, ldapConfigError: null };
  }
  if (configError) {
    return {
      enabled: true,
      oidcEnabled: false,
      status: {
        ...enterpriseIdentityStatus(globalIdentityConfig, false),
        provider: "none",
        mode: "open",
        enabled: false,
        configError,
      },
      requiredScope: (path) =>
        isPublicPath(path) ? null : path.startsWith("/api/") ? "manage" : null,
      middleware: (req, res, next) => {
        const scope = isPublicPath(req.path)
          ? null
          : req.path.startsWith("/api/")
            ? "manage"
            : null;
        if (!scope) {
          next();
          return Promise.resolve();
        }
        res.locals.studioAuthRequired = true;
        logTrace("studio.auth_rejected", { method: req.method, path: req.path, scope }, "error");
        res.status(503).json({ error: "enterprise identity configuration is invalid" });
        return Promise.resolve();
      },
    };
  }
  const identityConfig =
    options?.oidc !== undefined
      ? {
          oidc: options.oidc,
          ldap: globalIdentityConfig.ldap,
          ldapConfigError: globalIdentityConfig.ldapConfigError,
        }
      : globalIdentityConfig;
  const deploymentTokenFallback = options?.deploymentTokenFallback ?? true;
  const verifier = options?.oidcVerifier
    ? options.oidcVerifier
    : identityConfig.oidc
      ? createOidcVerifier({ config: identityConfig.oidc, keySet: options?.oidcKeySet })
      : null;
  const authConfigured = !openDevelopment && Boolean(verifier || token);
  const tokenFallbackEnabled = Boolean(token) && deploymentTokenFallback;
  const status = enterpriseIdentityStatus(identityConfig, tokenFallbackEnabled);
  const requiresAdminAuth = options?.requiresAdminAuth ?? Boolean(tokenFallbackEnabled || verifier);

  const requiredScope = (path: string): StudioAuthScope | null => {
    if (openDevelopment || isPublicPath(path)) return null;
    // Express 的 req.path 不含 query；前缀匹配时要求路径段边界，避免 /api/workflows-extra 这类误伤。
    const hasPrefix = (prefix: string) => {
      if (prefix.endsWith("/")) return path === prefix.slice(0, -1) || path.startsWith(prefix);
      return path === prefix || path.startsWith(`${prefix}/`);
    };
    if (managePrefixes.some(hasPrefix)) return "manage";
    if (authConfigured && runPrefixes.some(hasPrefix)) return "run";
    return null;
  };

  return {
    enabled: Boolean(verifier || tokenFallbackEnabled),
    oidcEnabled: Boolean(verifier),
    status,
    requiredScope,
    middleware: (req: Request, res: Response, next: NextFunction): Promise<void> => {
      res.locals.studioAuthRequired = requiresAdminAuth;
      const scope = requiredScope(req.path);
      if (!scope) {
        next();
        return Promise.resolve();
      }
      const presented = parseBearerToken(req.header("authorization"));
      if (!presented) {
        logTrace("studio.auth_rejected", { method: req.method, path: req.path, scope }, "warn");
        res.status(401).json({ error: "studio authentication is required" });
        return Promise.resolve();
      }

      return (async (): Promise<void> => {
        if (verifier) {
          try {
            const actor = await verifier.verify(presented);
            if (scope === "manage" && actor.role !== "admin") {
              logTrace(
                "studio.auth_forbidden",
                { method: req.method, path: req.path, scope, subject: actor.subject },
                "warn",
              );
              res.status(403).json({ error: "admin role is required" });
              return;
            }
            res.locals.studioAuth = { actor, scope };
            next();
            return;
          } catch (error) {
            if (!tokenFallbackEnabled || !tokensEqual(token as string, presented)) {
              logIdentityVerificationFailure(error);
              res.status(401).json({ error: "invalid or expired identity token" });
              return;
            }
          }
        }

        if (!tokenFallbackEnabled || !tokensEqual(token as string, presented)) {
          logTrace("studio.auth_rejected", { method: req.method, path: req.path, scope }, "warn");
          res.status(401).json({ error: "invalid studio credentials" });
          return;
        }
        res.locals.studioAuth = {
          actor: {
            source: "deployment-token",
            subject: "deployment-token",
            email: null,
            groups: [],
            roles: ["admin"],
            role: "admin",
          },
          scope,
        };
        next();
      })().catch((error: unknown) => {
        logIdentityVerificationFailure(error);
        if (!res.headersSent) res.status(500).json({ error: "identity verification failed" });
      });
    },
  };
}
