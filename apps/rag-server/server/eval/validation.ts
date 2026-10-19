import { randomUUID } from "node:crypto";
import type { EvalCase } from "./types.js";

/** 评测集的写入入参（create / update 共用，PUT 为全量替换）。 */
export interface DatasetInput {
  name: string;
  description: string;
  cases: EvalCase[];
}

export const MAX_EVAL_CASES = 200;
export const DEFAULT_EVAL_TOP_K = 5;

/** 校验并归一化评测集入参：名称必填、用例至少一条、期望来源至少一个。 */
export function parseDatasetInput(value: unknown): DatasetInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dataset must be an object");
  }
  const body = value as Record<string, unknown>;
  const name = requiredString(body.name, "name", 120);
  const description = optionalString(body.description, "description", 500);
  if (!Array.isArray(body.cases) || body.cases.length === 0) {
    throw new Error("cases must be a non-empty array");
  }
  if (body.cases.length > MAX_EVAL_CASES) {
    throw new Error(`cases must have at most ${MAX_EVAL_CASES} items`);
  }
  const cases = body.cases.map((raw, index) => parseCase(raw, index));
  return { name, description, cases };
}

/** 运行参数：topK 缺省或非法时回落到默认值，并夹取到 1-20。 */
export function parseRunOptions(value: unknown): { topK: number } {
  if (value === undefined || value === null) return { topK: DEFAULT_EVAL_TOP_K };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("run options must be an object");
  }
  const body = value as Record<string, unknown>;
  const requested = Number(body.topK);
  if (body.topK === undefined || !Number.isFinite(requested)) {
    return { topK: DEFAULT_EVAL_TOP_K };
  }
  return { topK: Math.max(1, Math.min(20, Math.floor(requested))) };
}

function parseCase(value: unknown, index: number): EvalCase {
  const label = `case ${index + 1}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const body = value as Record<string, unknown>;
  const query = requiredString(body.query, `${label} query`, 500);
  const expectedSources = stringList(body.expectedSources, `${label} expectedSources`, {
    max: 20,
    maxLength: 200,
    required: true,
  });
  const expectedKeywords = stringList(body.expectedKeywords, `${label} expectedKeywords`, {
    max: 20,
    maxLength: 100,
  });
  const sources = stringList(body.sources, `${label} sources`, { max: 50, maxLength: 200 });
  const id = optionalString(body.id, `${label} id`, 120) || randomUUID();
  return {
    id,
    query,
    expectedSources,
    expectedKeywords,
    ...(sources.length > 0 ? { sources } : {}),
  };
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return text;
}

function optionalString(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return text;
}

function stringList(
  value: unknown,
  field: string,
  options: { max: number; maxLength: number; required?: boolean },
): string[] {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${field} is required`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > options.max) throw new Error(`${field} must have at most ${options.max} items`);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${field} items must be non-empty strings`);
    }
    const text = item.trim();
    if (text.length > options.maxLength) {
      throw new Error(`${field} items must be at most ${options.maxLength} characters`);
    }
    if (!items.includes(text)) items.push(text);
  }
  if (options.required && items.length === 0) {
    throw new Error(`${field} must have at least 1 item`);
  }
  return items;
}
