import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  EvalCase,
  EvalCaseResult,
  EvalDataset,
  EvalDatasetSummary,
  EvalOverview,
  EvalRun,
  EvalRunSummary,
} from "./types.js";
import type { DatasetInput } from "./validation.js";

const DEFAULT_HISTORY_LIMIT = 10;

interface DatasetRow {
  id: string;
  name: string;
  description: string;
  cases_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * 评测集与运行记录的持久化。
 *
 * 运行记录与评测集不做外键级联：删掉评测集后历史运行仍然保留，
 * 便于对比「同一评测集改造前后」的指标，而不是一起消失。
 */
export class EvalStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_eval_datasets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL,
        cases_json  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rag_eval_runs (
        id           TEXT PRIMARY KEY,
        dataset_id   TEXT NOT NULL,
        dataset_name TEXT NOT NULL,
        top_k        INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        results_json TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        finished_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rag_eval_runs_started_at
        ON rag_eval_runs(started_at DESC);
    `);
  }

  listDatasets(): EvalDatasetSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, cases_json, created_at, updated_at
         FROM rag_eval_datasets ORDER BY updated_at DESC, rowid DESC`,
      )
      .all() as unknown as DatasetRow[];
    return rows.map(toSummary);
  }

  getDataset(id: string): EvalDataset | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, cases_json, created_at, updated_at
         FROM rag_eval_datasets WHERE id = ?`,
      )
      .get(id) as unknown as DatasetRow | undefined;
    return row ? toDataset(row) : null;
  }

  createDataset(input: DatasetInput): EvalDataset {
    const now = new Date().toISOString();
    const dataset: EvalDataset = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      cases: input.cases,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO rag_eval_datasets (id, name, description, cases_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dataset.id,
        dataset.name,
        dataset.description,
        JSON.stringify(dataset.cases),
        now,
        now,
      );
    return dataset;
  }

  updateDataset(id: string, input: DatasetInput): EvalDataset | null {
    const existing = this.getDataset(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const dataset: EvalDataset = {
      id,
      name: input.name,
      description: input.description,
      cases: input.cases,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    this.db
      .prepare(
        `UPDATE rag_eval_datasets SET name = ?, description = ?, cases_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(dataset.name, dataset.description, JSON.stringify(dataset.cases), now, id);
    return dataset;
  }

  deleteDataset(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM rag_eval_datasets WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  saveRun(run: EvalRun): void {
    const { results, ...summary } = run;
    this.db
      .prepare(
        `INSERT INTO rag_eval_runs
           (id, dataset_id, dataset_name, top_k, summary_json, results_json, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.datasetId,
        run.datasetName,
        run.topK,
        JSON.stringify(summary),
        JSON.stringify(results),
        run.startedAt,
        run.finishedAt,
      );
  }

  listRuns(limit: number = DEFAULT_HISTORY_LIMIT): EvalRunSummary[] {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit) || DEFAULT_HISTORY_LIMIT));
    const rows = this.db
      .prepare(
        `SELECT summary_json FROM rag_eval_runs
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(bounded) as unknown as Array<{ summary_json: string }>;
    return rows.map((row) => JSON.parse(row.summary_json) as EvalRunSummary);
  }

  getRun(runId: string): EvalRun | null {
    const row = this.db
      .prepare(`SELECT summary_json, results_json FROM rag_eval_runs WHERE id = ?`)
      .get(runId) as unknown as { summary_json: string; results_json: string } | undefined;
    if (!row) return null;
    return {
      ...(JSON.parse(row.summary_json) as EvalRunSummary),
      results: JSON.parse(row.results_json) as EvalCaseResult[],
    };
  }

  /** 评估看板数据：评测集规模 + 最近一次运行 + 历史趋势 + 未命中用例。 */
  overview(historyLimit: number = DEFAULT_HISTORY_LIMIT): EvalOverview {
    const datasetRows = this.db
      .prepare(`SELECT cases_json FROM rag_eval_datasets`)
      .all() as unknown as Array<{ cases_json: string }>;
    const history = this.listRuns(historyLimit);
    const latest = history[0] ?? null;
    const latestRun = latest ? this.getRun(latest.runId) : null;
    return {
      datasets: datasetRows.length,
      cases: datasetRows.reduce(
        (total, row) => total + (JSON.parse(row.cases_json) as EvalCase[]).length,
        0,
      ),
      latest,
      history,
      misses: latestRun ? latestRun.results.filter((result) => !result.hit) : [],
    };
  }

  close(): void {
    this.db.close();
  }
}

function toSummary(row: DatasetRow): EvalDatasetSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cases: (JSON.parse(row.cases_json) as EvalCase[]).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDataset(row: DatasetRow): EvalDataset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cases: JSON.parse(row.cases_json) as EvalCase[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
