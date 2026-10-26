import { Router, type Request, type Response } from "express";

export const healthRouter: ReturnType<typeof Router> = Router();

healthRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});
