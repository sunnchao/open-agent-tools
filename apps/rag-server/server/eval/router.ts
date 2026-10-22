import { Router, type Request, type Response } from "express";
import { routeParam } from "../request-validation.js";
import type { EvalRunner } from "./runner.js";
import type { EvalStore } from "./store.js";
import { parseDatasetInput, parseRunOptions } from "./validation.js";

export interface EvalRouterOptions {
  store: EvalStore;
  runner: EvalRunner;
}

function positiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 检索评估 API：评测集 CRUD + 触发运行 + 运行历史 + 看板。 */
export function evalRouter(options: EvalRouterOptions): Router {
  const { store, runner } = options;
  const router: Router = Router();

  router.get("/datasets", (_req: Request, res: Response) => {
    res.json({ datasets: store.listDatasets() });
  });

  router.post("/datasets", (req: Request, res: Response) => {
    try {
      const dataset = store.createDataset(parseDatasetInput(req.body));
      res.status(201).json({ dataset });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/datasets/:id", (req: Request, res: Response) => {
    const dataset = store.getDataset(routeParam(req.params.id));
    if (!dataset) {
      res.status(404).json({ error: "dataset not found" });
      return;
    }
    res.json({ dataset });
  });

  router.put("/datasets/:id", (req: Request, res: Response) => {
    const id = routeParam(req.params.id);
    let input;
    try {
      input = parseDatasetInput(req.body);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const dataset = store.updateDataset(id, input);
    if (!dataset) {
      res.status(404).json({ error: "dataset not found" });
      return;
    }
    res.json({ dataset });
  });

  router.delete("/datasets/:id", (req: Request, res: Response) => {
    if (!store.deleteDataset(routeParam(req.params.id))) {
      res.status(404).json({ error: "dataset not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/datasets/:id/run", async (req: Request, res: Response) => {
    const id = routeParam(req.params.id);
    let runOptions;
    try {
      runOptions = parseRunOptions(req.body);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const run = await runner.run(id, runOptions);
      res.status(201).json({ run });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === "dataset not found" ? 404 : 500).json({ error: message });
    }
  });

  router.get("/runs", (req: Request, res: Response) => {
    res.json({ runs: store.listRuns(positiveInt(req.query.limit) ?? 10) });
  });

  router.get("/overview", (req: Request, res: Response) => {
    res.json(store.overview(positiveInt(req.query.history) ?? 10));
  });

  return router;
}
