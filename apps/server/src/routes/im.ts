import { Router } from "express";
import { getImStatus } from "../im/index.js";

export const imRouter: Router = Router();

/** 诊断接口：机器人是否启用/连接、绑定的知识库 source。 */
imRouter.get("/api/im/status", (_req, res) => {
  res.json(getImStatus());
});
