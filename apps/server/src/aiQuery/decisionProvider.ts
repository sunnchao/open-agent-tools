import { randomUUID } from "node:crypto";
import { isRecord } from "@open-agent-tools/api-contracts/values";
import { logDebugDuration, logTrace, truncate } from "../trace.js";

export type DecisionMode = "off" | "shadow" | "on";
export type DecisionGateId = "A" | "B" | "C" | "D";

export interface DecisionQuestion {
  id: string;
  type: "noul" | "choice" | "score";
  prompt: string;
  criteria?: string;
  options?: string[];
  scale?: { min: number; max: number };
}

export interface DecisionRequest {
  requestId: string;
  traceId: string;
  gateId: DecisionGateId;
  decisionCatalogVersion: string;
  semanticCatalogVersion?: string;
  state: Record<string, unknown>;
  questions: DecisionQuestion[];
  timeoutMs: number;
}

export interface NoulAnswer {
  id: string;
  type: "noul";
  value: boolean;
  probability: number;
}

export interface ChoiceAnswer {
  id: string;
  type: "choice";
  value: string;
  probability: number;
  distribution?: Record<string, number>;
}

export interface ScoreAnswer {
  id: string;
  type: "score";
  value: number;
  confidence?: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResponse {
  requestId: string;
  answers: DecisionAnswer[];
  latencyMs: number;
  provider: "local-decision" | "ollama-judge" | "noop";
  modelVersion: string;
  decisionCatalogVersion: string;
}

export interface DecisionProvider {
  evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse | null>;
}

export interface DecisionConfig {
  mode: DecisionMode;
  gateAMode: DecisionMode;
  baseUrl?: string;
  timeoutMs: number;
  catalogVersion?: string;
}

export type GateAResult =
  | { status: "skipped"; mode: "off" }
  | {
      status: "answered";
      mode: "shadow" | "on";
      latencyMs: number;
      intent?: "DATA_QUERY" | "UNKNOWN";
      confidence?: number;
    }
  | { status: "unavailable"; mode: "shadow" | "on"; latencyMs: number };

export interface IntentRouteResult {
  intent: "DATA_QUERY" | "UNKNOWN";
  via: "decision" | "llm";
  decisionMs?: number;
  confidence?: number;
  gates?: string[];
}

const MODES = new Set<DecisionMode>(["off", "shadow", "on"]);
const PROVIDERS = new Set<DecisionResponse["provider"]>(["local-decision", "ollama-judge", "noop"]);
const DEFAULT_TIMEOUT_MS = 400;

function mode(value: string | undefined, fallback: DecisionMode): DecisionMode {
  return value && MODES.has(value as DecisionMode) ? (value as DecisionMode) : fallback;
}

export function readDecisionConfig(env: NodeJS.ProcessEnv = process.env): DecisionConfig {
  const globalMode = mode(env.AI_QUERY_DECISION_MODE, "off");
  const gateAValue = env.AI_QUERY_DECISION_GATE_A_MODE?.trim().toLowerCase();
  const gateAMode = gateAValue === "inherit" || !gateAValue ? globalMode : mode(gateAValue, "off");
  const parsedTimeout = Number(env.AI_QUERY_DECISION_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 50 && parsedTimeout <= 5_000
      ? parsedTimeout
      : DEFAULT_TIMEOUT_MS;
  const baseUrl = env.AI_QUERY_DECISION_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
  const catalogVersion = env.AI_QUERY_DECISION_CATALOG_VERSION?.trim() || undefined;
  return { mode: globalMode, gateAMode, baseUrl, timeoutMs, catalogVersion };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`决策响应 ${field} 必须是非空字符串`);
  }
  return value;
}

function probability(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`决策响应 ${field} 必须在 [0,1]`);
  }
  return value;
}

function parseDistribution(
  raw: unknown,
  question: DecisionQuestion,
): Record<string, number> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`决策响应 ${question.id}.distribution 格式错误`);
  const allowed = new Set(question.options ?? []);
  const distribution: Record<string, number> = {};
  let total = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) throw new Error(`决策响应 ${question.id}.distribution 含非法选项`);
    const parsed = probability(value, `${question.id}.distribution.${key}`);
    distribution[key] = parsed;
    total += parsed;
  }
  if (Math.abs(total - 1) > 0.02) {
    throw new Error(`决策响应 ${question.id}.distribution 概率和不为 1`);
  }
  return distribution;
}

function parseAnswer(raw: unknown, question: DecisionQuestion): DecisionAnswer {
  if (!isRecord(raw) || raw.id !== question.id || raw.type !== question.type) {
    throw new Error(`决策响应 ${question.id} 的 id/type 不匹配`);
  }
  if (question.type === "noul") {
    if (typeof raw.value !== "boolean") {
      throw new Error(`决策响应 ${question.id}.value 必须是 boolean`);
    }
    return {
      id: question.id,
      type: "noul",
      value: raw.value,
      probability: probability(raw.probability, `${question.id}.probability`),
    };
  }
  if (question.type === "choice") {
    if (typeof raw.value !== "string" || !(question.options ?? []).includes(raw.value)) {
      throw new Error(`决策响应 ${question.id}.value 不在选项中`);
    }
    const distribution = parseDistribution(raw.distribution, question);
    return {
      id: question.id,
      type: "choice",
      value: raw.value,
      probability: probability(raw.probability, `${question.id}.probability`),
      ...(distribution ? { distribution } : {}),
    };
  }
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
    throw new Error(`决策响应 ${question.id}.value 必须是 number`);
  }
  const min = question.scale?.min;
  const max = question.scale?.max;
  if (min === undefined || max === undefined || raw.value < min || raw.value > max) {
    throw new Error(`决策响应 ${question.id}.value 超出量表范围`);
  }
  return {
    id: question.id,
    type: "score",
    value: raw.value,
    ...(raw.confidence === undefined
      ? {}
      : { confidence: probability(raw.confidence, `${question.id}.confidence`) }),
  };
}

export function parseDecisionResponse(raw: unknown, request: DecisionRequest): DecisionResponse {
  if (!isRecord(raw)) throw new Error("决策响应必须是对象");
  if (raw.requestId !== request.requestId) throw new Error("决策响应 requestId 不匹配");
  if (raw.decisionCatalogVersion !== request.decisionCatalogVersion) {
    throw new Error("决策响应目录版本不匹配");
  }
  if (!Array.isArray(raw.answers) || raw.answers.length !== request.questions.length) {
    throw new Error("决策响应 answers 数量不匹配");
  }
  const byId = new Map<string, unknown>();
  for (const answer of raw.answers) {
    if (!isRecord(answer) || typeof answer.id !== "string" || byId.has(answer.id)) {
      throw new Error("决策响应 answer id 缺失或重复");
    }
    byId.set(answer.id, answer);
  }
  const provider = raw.provider;
  if (typeof provider !== "string" || !PROVIDERS.has(provider as DecisionResponse["provider"])) {
    throw new Error("决策响应 provider 非法");
  }
  if (typeof raw.latencyMs !== "number" || !Number.isFinite(raw.latencyMs) || raw.latencyMs < 0) {
    throw new Error("决策响应 latencyMs 非法");
  }
  return {
    requestId: request.requestId,
    answers: request.questions.map((question) => parseAnswer(byId.get(question.id), question)),
    latencyMs: raw.latencyMs,
    provider: provider as DecisionResponse["provider"],
    modelVersion: requiredString(raw.modelVersion, "modelVersion"),
    decisionCatalogVersion: request.decisionCatalogVersion,
  };
}

export class NoopDecisionProvider implements DecisionProvider {
  async evaluate(): Promise<null> {
    return null;
  }
}

export class LocalHttpDecisionProvider implements DecisionProvider {
  constructor(private readonly baseUrl: string) {}

  async evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`决策服务超时（${request.timeoutMs}ms）`)),
      request.timeoutMs,
    );
    timer.unref();
    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/v1/decisions/evaluate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": request.requestId,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      // 单独记录 HTTP 往返耗时(不含 JSON 解析/校验),便于区分网络延迟与决策服务自身耗时。
      logDebugDuration("ai_query.decision.http", startedAt, {
        traceId: request.traceId,
        gate: request.gateId,
        status: response.status,
      });
      if (!response.ok) throw new Error(`决策服务 HTTP ${response.status}`);
      return parseDecisionResponse(await response.json(), request);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export function createDecisionProvider(config: DecisionConfig): DecisionProvider {
  return config.baseUrl
    ? new LocalHttpDecisionProvider(config.baseUrl)
    : new NoopDecisionProvider();
}

function gateAQuestions(): DecisionQuestion[] {
  return [
    {
      id: "A1",
      type: "choice",
      prompt: "用户本轮意图",
      options: ["DATA_QUERY", "UNKNOWN"],
    },
    {
      id: "A2",
      type: "noul",
      prompt: "是否在查询 DTMS 业务数据",
      criteria: "涉及合同、付款、发票、收款、库存、清算等平台数据，而非闲聊或其它任务",
    },
    {
      id: "A3",
      type: "noul",
      prompt: "是否依赖上一轮上下文",
      criteria: "包含那、也、换成、同比等指代且本句缺主体或时间",
    },
    {
      id: "A4",
      type: "score",
      prompt: "意图把握程度",
      scale: { min: 0, max: 2 },
    },
  ];
}

export function createGateARequest(params: {
  traceId: string;
  question: string;
  pageContext?: string;
  industry?: string;
  hasSessionHistory: boolean;
  config: DecisionConfig;
}): DecisionRequest {
  if (!params.config.catalogVersion) throw new Error("未配置决策目录版本");
  return {
    requestId: randomUUID(),
    traceId: params.traceId,
    gateId: "A",
    decisionCatalogVersion: params.config.catalogVersion,
    state: {
      question: params.question,
      pageContext: params.pageContext ?? null,
      industry: params.industry ?? null,
      hasSessionHistory: params.hasSessionHistory,
    },
    questions: gateAQuestions(),
    timeoutMs: params.config.timeoutMs,
  };
}

export function chooseGateAIntent(response: DecisionResponse): {
  intent?: "DATA_QUERY" | "UNKNOWN";
  confidence?: number;
} {
  const choice = response.answers.find((answer) => answer.id === "A1");
  const dataQuery = response.answers.find((answer) => answer.id === "A2");
  const certainty = response.answers.find((answer) => answer.id === "A4");
  if (choice?.type !== "choice" || dataQuery?.type !== "noul" || certainty?.type !== "score") {
    return {};
  }
  if (choice.value === "DATA_QUERY" && dataQuery.probability >= 0.75 && certainty.value >= 1.2) {
    return { intent: "DATA_QUERY", confidence: choice.probability };
  }
  if (choice.value === "UNKNOWN" && dataQuery.probability < 0.4 && certainty.value >= 1.2) {
    return { intent: "UNKNOWN", confidence: choice.probability };
  }
  return {};
}

export async function evaluateGateA(
  params: {
    traceId: string;
    question: string;
    pageContext?: string;
    industry?: string;
    hasSessionHistory: boolean;
    signal?: AbortSignal;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<GateAResult> {
  const config = readDecisionConfig(env);
  if (config.gateAMode === "off") return { status: "skipped", mode: "off" };
  const startedAt = Date.now();
  try {
    if (!config.catalogVersion) throw new Error("决策目录版本未配置");
    const request = createGateARequest({ ...params, config });
    const provider = createDecisionProvider(config);
    const response = await provider.evaluate(request, params.signal);
    if (!response) throw new Error("决策服务未返回结果");
    const selected = chooseGateAIntent(response);
    const latencyMs = Date.now() - startedAt;
    logTrace("ai_query.decision", {
      traceId: params.traceId,
      gate: "A",
      mode: config.gateAMode,
      outcome: selected.intent ? "confident" : "fallback",
      modelVersion: response.modelVersion,
      catalogVersion: response.decisionCatalogVersion,
      latencyMs,
      providerLatencyMs: response.latencyMs,
    });
    return {
      status: "answered",
      mode: config.gateAMode,
      latencyMs,
      ...selected,
    };
  } catch (error) {
    if (params.signal?.aborted) throw error;
    const latencyMs = Date.now() - startedAt;
    logTrace(
      "ai_query.decision_error",
      {
        traceId: params.traceId,
        gate: "A",
        mode: config.gateAMode,
        error: truncate(error instanceof Error ? error.message : String(error), 200),
        latencyMs,
      },
      "warn",
    );
    return { status: "unavailable", mode: config.gateAMode, latencyMs };
  }
}

export async function routeIntentWithGateA(
  params: {
    traceId: string;
    question: string;
    pageContext?: string;
    industry?: string;
    hasSessionHistory: boolean;
    signal?: AbortSignal;
  },
  llmFallback: () => Promise<"DATA_QUERY" | "UNKNOWN">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IntentRouteResult> {
  const config = readDecisionConfig(env);
  if (config.gateAMode === "off") {
    return { intent: await llmFallback(), via: "llm" };
  }
  if (config.gateAMode === "shadow") {
    const [decision, intent] = await Promise.all([evaluateGateA(params, env), llmFallback()]);
    return {
      intent,
      via: "llm",
      ...(decision.status === "answered" ? { decisionMs: decision.latencyMs, gates: ["A"] } : {}),
    };
  }
  const decision = await evaluateGateA(params, env);
  if (decision.status === "answered" && decision.intent) {
    return {
      intent: decision.intent,
      via: "decision",
      decisionMs: decision.latencyMs,
      confidence: decision.confidence,
      gates: ["A"],
    };
  }
  return {
    intent: await llmFallback(),
    via: "llm",
    ...(decision.status === "answered" ? { decisionMs: decision.latencyMs, gates: ["A"] } : {}),
  };
}
