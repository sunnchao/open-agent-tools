import { Router, type Request, type Response } from "express";
import { loadBranding, normalizeBranding, resetBranding, saveBranding } from "./store.js";
import { requireStudioAdmin } from "../../platform/auth/studio.js";

export const brandingRouter: Router = Router();

/**
 * 公开品牌信息:Studio 启动与员工入口读取外观。配置里只有展示字段,没有密钥,
 * 因此无需部署 token;但仍带 `no-store`,避免 CDN 缓存住刚改的配色。
 */
brandingRouter.get("/api/branding", (_req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store");
  res.json({ ok: true, branding: loadBranding() });
});

brandingRouter.get("/api/admin/branding", (req: Request, res: Response) => {
  if (!requireStudioAdmin(req, res)) return;
  res.setHeader("cache-control", "no-store");
  res.json({ ok: true, branding: loadBranding() });
});

brandingRouter.put("/api/admin/branding", (req: Request, res: Response) => {
  if (!requireStudioAdmin(req, res)) return;
  const { branding, errors } = normalizeBranding(req.body);
  if (errors.length) {
    res.status(400).json({ error: errors[0], errors });
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.json({ ok: true, branding: saveBranding(branding) });
});

brandingRouter.delete("/api/admin/branding", (req: Request, res: Response) => {
  if (!requireStudioAdmin(req, res)) return;
  res.setHeader("cache-control", "no-store");
  res.json({ ok: true, branding: resetBranding() });
});
