import { Router, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const oneapiDemoRouter: ReturnType<typeof Router> = Router();

const pagePath = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "./oneapi-demo.html");

oneapiDemoRouter.get("/oneapi-demo", (_req: Request, res: Response) => {
  res.sendFile(pagePath);
});
