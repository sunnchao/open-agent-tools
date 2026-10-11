import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseGateAIntent,
  createDecisionProvider,
  createGateARequest,
  LocalHttpDecisionProvider,
  NoopDecisionProvider,
  parseDecisionResponse,
  readDecisionConfig,
  routeIntentWithGateA,
  type DecisionConfig,
  type DecisionRequest,
  type DecisionResponse,
} from "./decisionProvider.js";

const config: DecisionConfig = {
  mode: "on",
  gateAMode: "on",
  baseUrl: "http://decision.internal",
  timeoutMs: 400,
  catalogVersion: "decision-catalog@v1",
};

function request() {
  return createGateARequest({
    traceId: "trace-1",
    question: "上个月合同金额是多少",
    pageContext: "/contract-management/list",
    industry: "煤炭",
    hasSessionHistory: false,
    config,
  });
}

function responseFor(
  req: DecisionRequest,
  intent: "DATA_QUERY" | "UNKNOWN" = "DATA_QUERY",
): Record<string, unknown> {
  return {
    requestId: req.requestId,
    provider: "local-decision",
    modelVersion: "jev-local-1",
    decisionCatalogVersion: req.decisionCatalogVersion,
    latencyMs: 80,
    answers: [
      {
        id: "A1",
        type: "choice",
        value: intent,
        probability: 0.92,
        distribution: {
          DATA_QUERY: intent === "DATA_QUERY" ? 0.92 : 0.08,
          UNKNOWN: intent === "UNKNOWN" ? 0.92 : 0.08,
        },
      },
      {
        id: "A2",
        type: "noul",
        value: intent === "DATA_QUERY",
        probability: intent === "DATA_QUERY" ? 0.9 : 0.1,
      },
      { id: "A3", type: "noul", value: false, probability: 0.1 },
      { id: "A4", type: "score", value: 1.8, confidence: 0.9 },
    ],
  };
}

test("readDecisionConfig：默认关闭，Gate A 可继承或独立覆盖", () => {
  assert.deepEqual(readDecisionConfig({}), {
    mode: "off",
    gateAMode: "off",
    baseUrl: undefined,
    timeoutMs: 400,
    catalogVersion: undefined,
  });
  assert.equal(
    readDecisionConfig({
      AI_QUERY_DECISION_MODE: "shadow",
      AI_QUERY_DECISION_GATE_A_MODE: "inherit",
    }).gateAMode,
    "shadow",
  );
  assert.equal(
    readDecisionConfig({
      AI_QUERY_DECISION_MODE: "on",
      AI_QUERY_DECISION_GATE_A_MODE: "off",
    }).gateAMode,
    "off",
  );
});

function installDecisionFetch(intent: "DATA_QUERY" | "UNKNOWN" = "DATA_QUERY"): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(typeof init?.body, "string");
    const req = JSON.parse(init.body as string) as DecisionRequest;
    return new Response(JSON.stringify(responseFor(req, intent)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

const routeParams = {
  traceId: "trace-route",
  question: "合同金额呢",
  pageContext: "/contract-management/list",
  industry: "煤炭",
  hasSessionHistory: false,
};

test("routeIntentWithGateA：off 不调用决策服务，保持 LLM 路由", async () => {
  const previous = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("不应调用");
  }) as typeof fetch;
  try {
    const result = await routeIntentWithGateA(routeParams, async () => "UNKNOWN", {});
    assert.deepEqual(result, { intent: "UNKNOWN", via: "llm" });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("routeIntentWithGateA：on 高置信直接采用决策结果", async () => {
  const restore = installDecisionFetch("DATA_QUERY");
  try {
    const result = await routeIntentWithGateA(
      routeParams,
      async () => assert.fail("高置信决策不应调用 LLM fallback"),
      {
        AI_QUERY_DECISION_MODE: "on",
        AI_QUERY_DECISION_BASE_URL: "http://decision.internal",
        AI_QUERY_DECISION_CATALOG_VERSION: "decision-catalog@v1",
      },
    );
    assert.equal(result.intent, "DATA_QUERY");
    assert.equal(result.via, "decision");
    assert.equal(result.confidence, 0.92);
    assert.deepEqual(result.gates, ["A"]);
  } finally {
    restore();
  }
});

test("routeIntentWithGateA：shadow 只记录结果，最终仍采用 LLM", async () => {
  const restore = installDecisionFetch("DATA_QUERY");
  try {
    const result = await routeIntentWithGateA(routeParams, async () => "UNKNOWN", {
      AI_QUERY_DECISION_MODE: "shadow",
      AI_QUERY_DECISION_BASE_URL: "http://decision.internal",
      AI_QUERY_DECISION_CATALOG_VERSION: "decision-catalog@v1",
    });
    assert.equal(result.intent, "UNKNOWN");
    assert.equal(result.via, "llm");
    assert.deepEqual(result.gates, ["A"]);
    assert.equal(typeof result.decisionMs, "number");
  } finally {
    restore();
  }
});

test("readDecisionConfig：非法模式安全回退 off，超时限制在有效范围", () => {
  const parsed = readDecisionConfig({
    AI_QUERY_DECISION_MODE: "invalid",
    AI_QUERY_DECISION_GATE_A_MODE: "invalid",
    AI_QUERY_DECISION_TIMEOUT_MS: "99999",
  });
  assert.equal(parsed.mode, "off");
  assert.equal(parsed.gateAMode, "off");
  assert.equal(parsed.timeoutMs, 400);
});

test("createDecisionProvider：空地址使用 Noop，配置地址使用内网 HTTP 客户端", () => {
  assert.ok(
    createDecisionProvider({ ...config, baseUrl: undefined }) instanceof NoopDecisionProvider,
  );
  assert.ok(createDecisionProvider(config) instanceof LocalHttpDecisionProvider);
});

test("parseDecisionResponse：严格校验并按请求问题顺序返回", () => {
  const req = request();
  const raw = responseFor(req);
  const answers = raw.answers as unknown[];
  raw.answers = [answers[3], answers[1], answers[0], answers[2]];
  const parsed = parseDecisionResponse(raw, req);
  assert.deepEqual(
    parsed.answers.map((answer) => answer.id),
    ["A1", "A2", "A3", "A4"],
  );
  assert.deepEqual(chooseGateAIntent(parsed), { intent: "DATA_QUERY", confidence: 0.92 });
});

test("parseDecisionResponse：拒绝缺答案、协议外选项和目录版本不匹配", () => {
  const req = request();
  const missing = responseFor(req);
  (missing.answers as unknown[]).pop();
  assert.throws(() => parseDecisionResponse(missing, req), /answers 数量/);

  const invalidChoice = responseFor(req);
  (invalidChoice.answers as Array<Record<string, unknown>>)[0]!.value = "OPERATION";
  assert.throws(() => parseDecisionResponse(invalidChoice, req), /不在选项/);

  const wrongVersion = responseFor(req);
  wrongVersion.decisionCatalogVersion = "decision-catalog@v2";
  assert.throws(() => parseDecisionResponse(wrongVersion, req), /目录版本/);
});

test("chooseGateAIntent：边界置信度不短路到决策结果", () => {
  const req = request();
  const parsed = parseDecisionResponse(responseFor(req), req);
  const answers = parsed.answers.map((answer) => ({ ...answer }));
  const dataAnswer = answers.find((answer) => answer.id === "A2");
  assert.ok(dataAnswer?.type === "noul");
  dataAnswer.probability = 0.74;
  assert.deepEqual(chooseGateAIntent({ ...parsed, answers } as DecisionResponse), {});
});
