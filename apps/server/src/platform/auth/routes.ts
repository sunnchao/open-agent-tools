import { Router, type Request, type Response } from "express";
import { enterpriseIdentityStatus, readEnterpriseIdentityConfig } from "./enterprise.js";
import { requireStudioAdmin, resolveStudioAuth, resolveDeploymentToken } from "./studio.js";

export const identityRouter: Router = Router();

/**
 * 只读接入状态。这里绝不读取或返回 OIDC client secret、LDAP bind 密码、
 * HMAC secret；密钥的配置与轮换由部署系统完成。
 */
identityRouter.get("/api/admin/identity/status", (req: Request, res: Response) => {
  if (!requireStudioAdmin(req, res)) return;
  try {
    const config = readEnterpriseIdentityConfig();
    // 与鉴权中间件共用同一份 token 解析，避免状态展示与拦截策略分叉。
    const deploymentTokenEnabled = Boolean(resolveDeploymentToken());
    res.setHeader("cache-control", "no-store");
    res.json({
      identity: {
        ...enterpriseIdentityStatus(config, deploymentTokenEnabled),
        configError: null,
      },
    });
  } catch (error) {
    const status = resolveStudioAuth({ token: "" });
    res.setHeader("cache-control", "no-store");
    res.json({
      identity: {
        ...status.status,
        provider: "none",
        mode: "open",
        issuer: null,
        audience: null,
        enabled: false,
        configError: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
