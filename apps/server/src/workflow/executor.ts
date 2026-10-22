import {
  hasRunDeclarations,
  runVariables,
  prepareRunInputs,
  variableIssues,
  nodeKindSchema,
  nodeConfigSchemas,
  valuePath,
  interpolateTemplate as interpolate,
  interpolateTemplateValue as interpolateJsonValue,
  collectEndOutputs,
  isVisualCondition,
  conditionCases,
  conditionRouteIssues,
  selectedConditionEdges,
  conditionBranchLabel,
  type ConditionWarning,
  type HttpNodeConfig,
  type WorkflowResumeCheckpoint,
} from "@open-agent-tools/workflow-contracts";
import { callMcpTool, retrieveRag, retrieveRagGraph, type McpToolBinding } from "../resources.js";
import { getDefaultProvider, getProvider, type ProviderWithKey } from "../providers/store.js";
import { createLlmClient, type LlmMessage } from "../providers/clients/index.js";
import {
  runTraced,
  startObservation,
  withTraceAttributes,
  slimValue,
  type ObservationKind,
} from "@open-agent-tools/observability";
import { logDebugDuration, logTrace } from "../trace.js";
import { evaluateConditionExpression } from "./expression.js";
import { evaluateConditionCases } from "./condition-rules.js";
import { setTimeout as delay } from "node:timers/promises";
import { runHttp } from "./http.js";
import { workflowRedactor } from "./redaction.js";
import { runWorkflowSqlQuery, WorkflowSqlError } from "./sqlQuery.js";

export type WorkflowNodeKind = import("@open-agent-tools/workflow-contracts").NodeKind;

export interface WorkflowNodeInput {
  id: string;
  kind: WorkflowNodeKind;
  label?: string;
  config?: Record<string, unknown>;
}

export interface WorkflowEdgeInput {
  id?: string;
  source: string;
  target: string;
  label?: string;
  branchId?: string;
}

export interface WorkflowRunRequest {
  nodes: WorkflowNodeInput[];
  edges: WorkflowEdgeInput[];
  input: Record<string, unknown>;
}

export interface WorkflowTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface WorkflowLlmCompletion {
  content: string;
  tokenUsage?: Partial<WorkflowTokenUsage>;
}

export interface WorkflowNodeTestRequest {
  node: WorkflowNodeInput;
  inputs: Record<string, unknown>;
}

export interface WorkflowNodeTestResult {
  nodeId: string;
  status: "success" | "error";
  inputs: Record<string, unknown>;
  result: unknown;
  outputs: Record<string, unknown>;
  error?: string;
  metadata: {
    nodeKind: WorkflowNodeKind;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    tokenUsage: WorkflowTokenUsage;
    attempts?: number;
    selectedBranchId?: string;
    selectedBranchLabel?: string;
    warnings?: ConditionWarning[];
  };
}

export interface NodeInputBinding {
  name: string;
  source:
    | { type: "literal"; value: unknown }
    | { type: "run"; variable: string }
    | { type: "node"; nodeId: string; output: string };
  required?: boolean;
}

export interface NodeOutputBinding {
  name: string;
  selector: string;
}

/** 节点运行指标（随 node_result 事件回传，供前端运行轨迹日志展示）。 */
export interface WorkflowNodeResultMetadata {
  durationMs: number;
  tokenUsage: WorkflowTokenUsage;
  attempts?: number;
  cached?: boolean;
  incomingEdgeIds?: string[];
  selectedBranchId?: string;
  selectedBranchLabel?: string;
  warnings?: ConditionWarning[];
}

export interface WorkflowEvent {
  type: "node_start" | "node_result" | "node_cached" | "run_done" | "run_error";
  nodeId?: string;
  incomingEdgeIds?: string[];
  label?: string;
  kind?: string;
  status?: "success" | "error";
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  nodeOutputs?: Record<string, Record<string, unknown>>;
  result?: unknown;
  output?: unknown;
  /** LLM 节点插值后的最终请求内容（user 消息）。 */
  prompt?: string;
  /** LLM 节点插值后的系统提示词（system 消息）。 */
  systemPrompt?: string;
  error?: string;
  metadata?: WorkflowNodeResultMetadata;
}

export interface WorkflowDependencies {
  sqlQuery?: typeof runWorkflowSqlQuery;
  retrieveRag?: typeof retrieveRag;
  retrieveRagGraph?: typeof retrieveRagGraph;
  callMcpTool?: typeof callMcpTool;
  getProvider?: (id: string, options?: { requireEnabled?: boolean }) => ProviderWithKey | null;
  getDefaultProvider?: (options?: { requireEnabled?: boolean }) => ProviderWithKey | null;
  completeLlm?: (
    provider: ProviderWithKey,
    input: { model: string; systemPrompt?: string; prompt: string; temperature?: number },
  ) => Promise<string | WorkflowLlmCompletion>;
  timeoutMs?: Partial<Record<"rag" | "llm" | "mcp" | "graph" | "http" | "sql", number>>;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  resume?: WorkflowResumeCheckpoint;
}

export interface WorkflowValidation {
  nodes: WorkflowNodeInput[];
  edges: Array<WorkflowEdgeInput & { id: string }>;
  byId: Map<string, WorkflowNodeInput>;
  incoming: Map<string, Array<WorkflowEdgeInput & { id: string }>>;
  outgoing: Map<string, Array<WorkflowEdgeInput & { id: string }>>;
  order: string[];
}

export class WorkflowValidationError extends Error {
  statusCode = 400;
}

export class WorkflowNodeError extends Error {
  constructor(
    public readonly nodeId: string,
    message: string,
  ) {
    super(message);
  }
}

const NODE_KINDS = new Set<WorkflowNodeKind>(nodeKindSchema.options);

function configOf(node: WorkflowNodeInput): Record<string, unknown> {
  return node.config && typeof node.config === "object" ? node.config : {};
}

function inputsOf(node: WorkflowNodeInput): NodeInputBinding[] {
  const value = configOf(node).inputs;
  return Array.isArray(value) ? (value as NodeInputBinding[]) : [];
}

function outputsOf(node: WorkflowNodeInput): NodeOutputBinding[] {
  const config = configOf(node);
  const value = config.outputs;
  if (Array.isArray(value)) return value as NodeOutputBinding[];
  const legacy = typeof config.output === "string" ? config.output.trim() : "";
  return legacy ? [{ name: legacy, selector: "$result" }] : [];
}

function assertString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new WorkflowValidationError(message);
}

function validateBindings(
  nodes: WorkflowNodeInput[],
  edges: Array<WorkflowEdgeInput & { id: string }>,
  outgoing: Map<string, Array<WorkflowEdgeInput & { id: string }>>,
  allowMissingHttpAuth = false,
): void {
  const issues = variableIssues(nodes).filter(
    (issue) => !allowMissingHttpAuth || issue.code !== "http-auth",
  );
  if (issues.length)
    throw new WorkflowValidationError(`node ${issues[0]!.nodeId}: ${issues[0]!.message}`);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const inputs = inputsOf(node);
    const outputs = outputsOf(node);
    const inputNames = new Set<string>();
    const outputNames = new Set<string>();
    for (const input of inputs) {
      const source = input?.source;
      assertString(input?.name, `node ${node.id}: input name is required`);
      if (inputNames.has(input.name))
        throw new WorkflowValidationError(`node ${node.id}: duplicate input ${input.name}`);
      inputNames.add(input.name);
      if (!source || !["literal", "run", "node"].includes(source.type)) {
        throw new WorkflowValidationError(`node ${node.id}: invalid input source`);
      }
      if (source.type === "run")
        assertString(source.variable, `node ${node.id}: run variable is required`);
      if (source.type === "node") {
        assertString(source.nodeId, `node ${node.id}: source nodeId is required`);
        assertString(source.output, `node ${node.id}: source output is required`);
        const direct = (outgoing.get(source.nodeId) ?? []).some((edge) => edge.target === node.id);
        if (!direct)
          throw new WorkflowValidationError(
            `node ${node.id}: ${source.nodeId} is not a direct predecessor`,
          );
        const sourceNode = byId.get(source.nodeId);
        if (!sourceNode || !outputsOf(sourceNode).some((output) => output.name === source.output)) {
          throw new WorkflowValidationError(
            `node ${node.id}: output ${source.nodeId}.${source.output} is not declared`,
          );
        }
      }
    }
    for (const output of outputs) {
      assertString(output?.name, `node ${node.id}: output name is required`);
      assertString(output?.selector, `node ${node.id}: output selector is required`);
      if (outputNames.has(output.name))
        throw new WorkflowValidationError(`node ${node.id}: duplicate output ${output.name}`);
      outputNames.add(output.name);
      if (
        !valuePath(output.selector) ||
        !["$result", "$inputs"].includes(valuePath(output.selector)![0]!)
      ) {
        throw new WorkflowValidationError(
          `node ${node.id}: invalid output selector ${output.selector}`,
        );
      }
    }
  }
}

export function validateWorkflow(
  request: WorkflowRunRequest,
  options: { allowMissingHttpAuth?: boolean; nodeTest?: boolean } = {},
): WorkflowValidation {
  if (!request || !Array.isArray(request.nodes) || request.nodes.length === 0) {
    throw new WorkflowValidationError("nodes must be a non-empty array");
  }
  if (
    !Array.isArray(request.edges) ||
    !request.input ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  ) {
    throw new WorkflowValidationError("edges and input are required");
  }
  const byId = new Map<string, WorkflowNodeInput>();
  for (const node of request.nodes) {
    assertString(node?.id, "node id is required");
    if (byId.has(node.id)) throw new WorkflowValidationError(`duplicate node id ${node.id}`);
    if (!NODE_KINDS.has(node.kind))
      throw new WorkflowValidationError(`invalid node kind ${node.kind}`);
    const config = nodeConfigSchemas[node.kind].safeParse(node.config ?? {});
    if (!config.success)
      throw new WorkflowValidationError(
        `node ${node.id}: ${config.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    if (node.kind === "graph") {
      const sources = (config.data as { sources?: string[] }).sources;
      if (!sources?.length) {
        throw new WorkflowValidationError(`node ${node.id}: 图谱检索至少选择一个文档`);
      }
    }
    byId.set(node.id, node);
  }
  const edges: Array<WorkflowEdgeInput & { id: string }> = [];
  const edgeIds = new Set<string>();
  const incoming = new Map<string, Array<WorkflowEdgeInput & { id: string }>>();
  const outgoing = new Map<string, Array<WorkflowEdgeInput & { id: string }>>();
  for (const [index, edge] of request.edges.entries()) {
    assertString(edge?.source, "edge source is required");
    assertString(edge?.target, "edge target is required");
    if (edge.source === edge.target) throw new WorkflowValidationError("self-loop is not allowed");
    if (!byId.has(edge.source) || !byId.has(edge.target))
      throw new WorkflowValidationError("edge references an unknown node");
    if (edge.label && !["true", "false"].includes(edge.label))
      throw new WorkflowValidationError("edge label must be true or false");
    const id = edge.id?.trim() || `${edge.source}-${edge.target}-${index}`;
    if (edgeIds.has(id)) throw new WorkflowValidationError(`duplicate edge id ${id}`);
    edgeIds.add(id);
    const normalized = { ...edge, id };
    edges.push(normalized);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), normalized]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), normalized]);
  }
  for (const node of request.nodes) {
    incoming.set(node.id, incoming.get(node.id) ?? []);
    outgoing.set(node.id, outgoing.get(node.id) ?? []);
  }
  for (const edge of edges) {
    if (edge.branchId !== undefined && byId.get(edge.source)?.kind !== "condition")
      throw new WorkflowValidationError("only condition nodes may have branch connections");
  }
  for (const node of request.nodes) {
    if (node.kind !== "condition") continue;
    const nodeEdges = outgoing.get(node.id) ?? [];
    if (options.nodeTest && nodeEdges.length === 0) continue;
    const issues = conditionRouteIssues(configOf(node), nodeEdges);
    if (issues.length) throw new WorkflowValidationError(`node ${node.id}: ${issues[0]!.message}`);
  }
  validateBindings(request.nodes, edges, outgoing, options.allowMissingHttpAuth);
  const degrees = new Map(request.nodes.map((node) => [node.id, incoming.get(node.id)!.length]));
  const queue = request.nodes.filter((node) => degrees.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    order.push(id);
    for (const edge of outgoing.get(id)!) {
      const next = (degrees.get(edge.target) ?? 1) - 1;
      degrees.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }
  if (order.length !== request.nodes.length)
    throw new WorkflowValidationError("workflow contains a cycle");
  return { nodes: request.nodes, edges, byId, incoming, outgoing, order };
}

/** 将 LLM 节点解析后的输入变量拼接为 user 消息文本（当未配置 prompt 模板时自动生成）。 */
function formatInputsAsUserMessage(inputs: Record<string, unknown>): string {
  const entries = Object.entries(inputs);
  if (entries.length === 0) return "";
  return entries
    .map(([name, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return `${name}:\n${text}`;
    })
    .join("\n\n");
}

function selectValue(selector: string, result: unknown, inputs: Record<string, unknown>): unknown {
  const [root, ...path] = valuePath(selector)!;
  let value: unknown = root === "$result" ? result : inputs;
  for (const key of path) {
    // An explicitly bound optional input can be absent. Unknown result paths are errors.
    if (value === undefined && root === "$inputs") return undefined;
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error(`输出路径 ${selector} 不存在（字段 ${key}）`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error("workflow run cancelled"));
  if (!Number.isFinite(timeout) || timeout <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`workflow node timed out after ${timeout}ms`)),
      timeout,
    );
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("workflow run cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

interface NodeExecution {
  result: unknown;
  attempts?: number;
  tokenUsage?: Partial<WorkflowTokenUsage>;
  /** LLM 节点插值后的最终 user 请求内容，随事件回传用于日志调试。 */
  prompt?: string;
  /** LLM 节点插值后的系统提示词（system 消息）。 */
  systemPrompt?: string;
  selectedBranchId?: string;
  selectedBranchLabel?: string;
  warnings?: ConditionWarning[];
}
const emptyTokenUsage = (): WorkflowTokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

/** SSE 事件载荷上限：保留完整信息用于调试，仅对极端超长值做截断保护。 */
const EVENT_SLIM_MAX_STRING = 20_000;
const EVENT_SLIM_MAX_ITEMS = 200;

function normalizeTokenUsage(usage?: Partial<WorkflowTokenUsage>): WorkflowTokenUsage {
  const inputTokens = Number(usage?.inputTokens) || 0;
  const outputTokens = Number(usage?.outputTokens) || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage?.totalTokens) || inputTokens + outputTokens,
  };
}

function resolvedDependencies(
  dependencies: WorkflowDependencies,
): Required<
  Pick<
    WorkflowDependencies,
    | "retrieveRag"
    | "retrieveRagGraph"
    | "callMcpTool"
    | "getProvider"
    | "getDefaultProvider"
    | "sqlQuery"
  >
> &
  WorkflowDependencies {
  return {
    retrieveRag,
    retrieveRagGraph,
    callMcpTool,
    getProvider,
    getDefaultProvider,
    sqlQuery: runWorkflowSqlQuery,
    ...dependencies,
  };
}

async function runNode(
  node: WorkflowNodeInput,
  inputs: Record<string, unknown>,
  deps: ReturnType<typeof resolvedDependencies> & { redactor: ReturnType<typeof workflowRedactor> },
): Promise<NodeExecution> {
  const config = configOf(node);
  const configuredTimeout = typeof config.timeoutMs === "number" ? config.timeoutMs : undefined;
  logTrace(
    "workflow.node.start",
    deps.redactor.redact({
      node,
      inputs,
    }),
  );
  switch (node.kind) {
    case "start":
      return { result: null };
    case "input":
      return { result: inputs };
    case "rag": {
      const sources = Array.isArray(config.sources)
        ? config.sources.filter((value): value is string => typeof value === "string")
        : [];
      const query = interpolate(config.query ?? inputs.query ?? "", inputs, "text");
      const result = await withTimeout(
        deps.retrieveRag({
          query,
          sources,
          topK: Math.max(1, Math.min(20, Number(config.topK) || 5)),
          signal: deps.signal,
        }),
        configuredTimeout ?? deps.timeoutMs?.rag ?? 15_000,
        deps.signal,
      );
      return { result };
    }
    case "graph": {
      const sources = config.sources as string[];
      const query = interpolate(config.query ?? inputs.query ?? "", inputs, "text");
      if (!query) throw new Error("graph node requires a query");
      const result = await withTimeout(
        deps.retrieveRagGraph({ query, sources, signal: deps.signal }),
        configuredTimeout ?? deps.timeoutMs?.graph ?? 15_000,
        deps.signal,
      );
      // 零命中必须显式失败：rag-server 对「没匹配到实体」返回 200 + formatted:""。
      // 若原样当成 success，下游（常见是结束节点）只会拿到空字符串，
      // 用户看不到任何「没检索到」的信号，最终输出为空却显示运行成功。
      if (!result.formatted && result.seeds.length === 0)
        throw new Error(
          `图谱检索未命中任何实体：在所选文档中匹配不到「${query}」，请检查查询内容或所选图谱文档`,
        );
      return {
        result: {
          formatted: result.formatted,
          seeds: result.seeds,
        },
      };
    }
    case "sql": {
      const query = interpolate(config.query ?? inputs.query ?? "", inputs, "text").trim();
      if (!query) throw new Error("SQL 问数节点需要配置问题或绑定 query 输入变量");
      const sourceId = typeof config.sourceId === "string" ? config.sourceId.trim() : "";
      return {
        result: await withTimeout(
          deps.sqlQuery({
            sourceId: sourceId || undefined,
            query,
            maxRows: typeof config.maxRows === "number" ? config.maxRows : 100,
            signal: deps.signal,
          }),
          configuredTimeout ?? deps.timeoutMs?.sql ?? 60_000,
          deps.signal,
        ),
      };
    }
    case "llm": {
      const providerId = typeof config.providerId === "string" ? config.providerId : "";
      const provider = providerId
        ? deps.getProvider(providerId, { requireEnabled: true })
        : deps.getDefaultProvider({ requireEnabled: true });
      if (!provider)
        throw new Error(
          providerId
            ? `Provider ${providerId} not found or disabled`
            : "Default provider not found or disabled",
        );
      const model =
        typeof config.model === "string" && config.model ? config.model : provider.models[0];
      if (!model) throw new Error(`Provider ${provider.id} has no models`);
      // 系统提示词与用户消息分离：systemPrompt → system 消息；prompt 模板 → user 消息。
      // prompt 未配置（或插值后为空）时，自动将解析后的输入变量拼接为 user 消息，避免入参数据被覆盖丢失。
      const systemPrompt =
        typeof config.systemPrompt === "string" && config.systemPrompt
          ? interpolate(config.systemPrompt, inputs, "text")
          : "";
      const promptTemplate =
        typeof config.prompt === "string" && config.prompt
          ? interpolate(config.prompt, inputs, "text")
          : "";
      const prompt = promptTemplate || formatInputsAsUserMessage(inputs);
      if (!prompt)
        throw new Error(
          "LLM 节点未配置用户提示词（prompt），且没有输入变量可自动拼接，请检查节点配置",
        );
      const temperature = typeof config.temperature === "number" ? config.temperature : undefined;
      const complete =
        deps.completeLlm ??
        (async (resolvedProvider, value) => {
          if (!resolvedProvider.apiKey)
            throw new Error(
              `Provider「${resolvedProvider.name}」未配置 API Key，请在「设置」中为该 Provider 填写 API Key`,
            );
          const messages: LlmMessage[] = [
            ...(value.systemPrompt
              ? [{ role: "system" as const, content: value.systemPrompt }]
              : []),
            { role: "user" as const, content: value.prompt },
          ];
          const completion = await createLlmClient(resolvedProvider).complete({
            model: value.model,
            messages,
            ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
            signal: deps.signal,
          });
          const { inputTokens = 0, outputTokens = 0 } = completion.tokenUsage ?? {};
          return {
            content: completion.content,
            tokenUsage: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            },
          };
        });
      let completion: string | WorkflowLlmCompletion;
      try {
        completion = await withTimeout(
          complete(provider, {
            model,
            systemPrompt: systemPrompt || undefined,
            prompt,
            temperature,
          }),
          configuredTimeout ?? deps.timeoutMs?.llm ?? 30_000,
          deps.signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const wrapped = new Error(message);
        (wrapped as { prompt?: string }).prompt = prompt;
        if (systemPrompt) (wrapped as { systemPrompt?: string }).systemPrompt = systemPrompt;
        throw wrapped;
      }
      return typeof completion === "string"
        ? { result: completion, prompt, systemPrompt: systemPrompt || undefined }
        : {
            result: completion.content,
            tokenUsage: completion.tokenUsage,
            prompt,
            systemPrompt: systemPrompt || undefined,
          };
    }
    case "mcp": {
      const serviceSlug = String(config.serviceSlug ?? "");
      const toolName = String(config.toolName ?? "");
      if (!serviceSlug || !toolName) throw new Error("MCP serviceSlug and toolName are required");
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(String(config.arguments ?? "{}")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("arguments must be an object");
        args = interpolateJsonValue(parsed, inputs) as Record<string, unknown>;
      } catch (error) {
        throw new Error(
          `MCP arguments must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const binding: McpToolBinding = { serviceSlug, toolName };
      const result = await withTimeout(
        deps.callMcpTool(binding, args, { signal: deps.signal }),
        configuredTimeout ?? deps.timeoutMs?.mcp ?? 30_000,
        deps.signal,
      );
      return { result };
    }
    case "http":
      return {
        result: await withTimeout(
          runHttp(config as HttpNodeConfig, inputs, deps.signal, deps.fetchFn),
          configuredTimeout ?? deps.timeoutMs?.http ?? 30_000,
          deps.signal,
        ),
      };
    case "condition": {
      if (isVisualCondition(config)) {
        const execution = evaluateConditionCases(conditionCases(config), inputs);
        for (const warning of execution.warnings)
          logTrace("condition.type-mismatch", { nodeId: node.id, ...warning }, "warn");
        return {
          ...execution,
          selectedBranchId: execution.result,
          selectedBranchLabel: conditionBranchLabel(config, execution.result),
        };
      }
      const expression = interpolate(config.expression ?? "false", inputs, "expression");
      try {
        return { result: evaluateConditionExpression(expression) };
      } catch (error) {
        throw new Error(
          `condition expression failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    case "end":
      return { result: inputs };
  }
}

function transientFailure(error: unknown): boolean {
  const failure = error as {
    message?: string;
    code?: string | number;
    cause?: { code?: string };
    status?: number;
    statusCode?: number;
  };
  const status =
    failure?.status ??
    failure?.statusCode ??
    (typeof failure?.code === "number" ? failure.code : undefined);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  const code = failure?.code ?? failure?.cause?.code;
  if (
    typeof code === "string" &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  )
    return true;
  return /fetch failed|network (error|failure)|(?:failed|error) \((?:408|429|5\d\d)\)/i.test(
    failure?.message ?? "",
  );
}

async function runNodeWithPolicy(
  node: WorkflowNodeInput,
  inputs: Record<string, unknown>,
  deps: Parameters<typeof runNode>[2],
): Promise<NodeExecution> {
  const policy = configOf(node).retry as { maxRetries?: number; delayMs?: number } | undefined;
  const retries = ["rag", "graph", "mcp", "http"].includes(node.kind)
    ? (policy?.maxRetries ?? 0)
    : 0;
  for (let attempt = 1; ; attempt++) {
    if (deps.signal?.aborted) throw new Error("workflow run cancelled");
    const controller = new AbortController();
    const abort = () => controller.abort();
    deps.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await runNode(node, inputs, { ...deps, signal: controller.signal });
      return { ...result, attempts: attempt };
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      Object.assign(error, { attempts: attempt });
      if (deps.signal?.aborted || attempt > retries || !transientFailure(reason)) throw error;
    } finally {
      controller.abort();
      deps.signal?.removeEventListener("abort", abort);
    }
    await delay(Math.min(10000, (policy?.delayMs ?? 500) * 2 ** (attempt - 1)), undefined, {
      signal: deps.signal,
    });
  }
}

function resolveInputs(
  node: WorkflowNodeInput,
  request: WorkflowRunRequest,
  outputContext: Map<string, Record<string, unknown>>,
  redact: ReturnType<typeof workflowRedactor>["redact"],
): Record<string, unknown> {
  logTrace(
    "resolveInputs",
    redact({
      node,
      request,
      outputContext,
    }),
    "info",
  );
  const values: Record<string, unknown> = {};
  for (const binding of inputsOf(node)) {
    const source = binding.source;
    let value: unknown;
    if (source.type === "literal") value = source.value;
    if (source.type === "run") value = request.input[source.variable];
    if (source.type === "node") value = outputContext.get(source.nodeId)?.[source.output];
    if (value === undefined && binding.required !== false)
      throw new WorkflowNodeError(node.id, `required input ${binding.name} is missing`);
    values[binding.name] = value;
  }
  return values;
}

/** 节点 kind → Langfuse observation 类型（LLM=generation、RAG=retriever、MCP=tool）。 */
function nodeKindAsType(kind: WorkflowNodeKind): ObservationKind {
  switch (kind) {
    case "llm":
      return "generation";
    case "rag":
    case "graph":
      return "retriever";
    case "mcp":
    case "http":
    case "sql":
      return "tool";
    default:
      return "span";
  }
}

/** 节点 observation 的初始化属性：generation 需要 model/providerId 属性以支持成本分析。 */
function nodeObservationAttributes(node: WorkflowNodeInput): Record<string, unknown> {
  const config = configOf(node);
  const metadata: Record<string, unknown> = { nodeId: node.id, kind: node.kind };
  const attributes: Record<string, unknown> = { metadata };
  if (node.kind === "llm") {
    if (typeof config.model === "string" && config.model) attributes.model = config.model;
    if (typeof config.providerId === "string" && config.providerId) {
      metadata.providerId = config.providerId;
    }
  }
  return attributes;
}

export async function executeWorkflow(
  request: WorkflowRunRequest,
  emit: (event: WorkflowEvent) => void,
  dependencies: WorkflowDependencies = {},
): Promise<Record<string, Record<string, unknown>>> {
  const validation = validateWorkflow(request);
  if (hasRunDeclarations(request.nodes)) {
    const prepared = prepareRunInputs(runVariables(request.nodes), request.input);
    if (prepared.errors.length) throw new WorkflowValidationError(prepared.errors.join("; "));
    request = { ...request, input: prepared.input };
  }
  const redactor = workflowRedactor(request.nodes, request.input);
  const deps = { ...resolvedDependencies(dependencies), redactor };
  const safeEmit = (event: WorkflowEvent) =>
    emit({
      ...event,
      inputs: redactor.redact(event.inputs),
      outputs: redactor.redact(event.outputs),
      result: redactor.redact(event.result),
      error: redactor.redact(event.error),
      prompt: redactor.redact(event.prompt),
      systemPrompt: redactor.redact(event.systemPrompt),
      ...(event.nodeOutputs
        ? {
            nodeOutputs: Object.fromEntries(
              Object.entries(event.nodeOutputs).map(([id, values]) => [
                id,
                redactor.redact(values),
              ]),
            ),
          }
        : {}),
    });
  const activeNodes = new Set(
    validation.nodes
      .filter((node) => validation.incoming.get(node.id)!.length === 0)
      .map((node) => node.id),
  );
  const activeEdges = new Set<string>();
  const statuses = new Map<string, "success" | "error">();
  const outputContext = new Map<string, Record<string, unknown>>();
  const executeIds = deps.resume ? new Set(deps.resume.executeNodeIds) : null;
  if (deps.resume) {
    activeNodes.clear();
    activeNodes.add(deps.resume.fromNodeId);
    for (const id of deps.resume.activeEdgeIds) {
      const edge = validation.edges.find((edge) => edge.id === id);
      if (!edge) throw new WorkflowValidationError("resume edge is no longer available");
      activeEdges.add(id);
      if (executeIds?.has(edge.target)) activeNodes.add(edge.target);
    }
    for (const [id, cached] of Object.entries(deps.resume.cachedNodes)) {
      outputContext.set(id, cached.outputs);
      statuses.set(id, "success");
    }
  }

  return runTraced("workflow-run", async (span) => {
    span.update({
      input: redactor.redact(slimValue(request.input)),
      metadata: {
        nodeCount: String(validation.nodes.length),
        edgeCount: String(validation.edges.length),
        ...(deps.resume ? { resumeFromNodeId: deps.resume.fromNodeId } : {}),
      },
    });
    try {
      await withTraceAttributes(
        {
          tags: ["workflow"],
          metadata: {
            nodeKinds: validation.nodes.map((node) => node.kind).join(","),
          },
        },
        async () => {
          if (deps.signal?.aborted) throw new Error("workflow run cancelled");
          for (const [id, cached] of Object.entries(deps.resume?.cachedNodes ?? {})) {
            const node = validation.byId.get(id)!;
            const incomingEdgeIds = validation.incoming
              .get(id)!
              .filter((edge) => deps.resume?.activeEdgeIds.includes(edge.id))
              .map((edge) => edge.id);
            safeEmit({
              type: "node_cached",
              nodeId: id,
              kind: node.kind,
              label: node.label,
              status: "success",
              inputs: cached.inputs,
              outputs: cached.outputs,
              result: cached.result,
              incomingEdgeIds,
              metadata: {
                durationMs: 0,
                tokenUsage: emptyTokenUsage(),
                attempts: 0,
                cached: true,
                incomingEdgeIds,
                ...(node.kind === "condition" &&
                isVisualCondition(configOf(node)) &&
                typeof cached.result === "string"
                  ? {
                      selectedBranchId: cached.result,
                      selectedBranchLabel: conditionBranchLabel(configOf(node), cached.result),
                    }
                  : {}),
              },
            });
          }
          for (const nodeId of validation.order) {
            if (deps.signal?.aborted) throw new Error("workflow run cancelled");
            if (executeIds && !executeIds.has(nodeId)) continue;
            if (!activeNodes.has(nodeId)) continue;
            const node = validation.byId.get(nodeId)!;
            const incoming = validation.incoming
              .get(nodeId)!
              .filter((edge) => activeEdges.has(edge.id));
            if (incoming.some((edge) => statuses.get(edge.source) !== "success")) continue;
            if (nodeId && !request.input)
              throw new WorkflowNodeError(nodeId, "workflow input is required");
            safeEmit({
              type: "node_start",
              nodeId,
              incomingEdgeIds: incoming.map((edge) => edge.id),
              label: node.label ?? node.kind,
              kind: node.kind,
            });
            const nodeObservation = startObservation(
              node.label ?? node.kind,
              nodeObservationAttributes(node),
              { asType: nodeKindAsType(node.kind) },
            );
            const startedAtMs = Date.now();
            let resolvedInputs: Record<string, unknown> | undefined;
            try {
              const inputs = resolveInputs(node, request, outputContext, redactor.redact);
              resolvedInputs = inputs;
              redactor.add(node, inputs);
              const execution = await runNodeWithPolicy(node, inputs, deps);
              logDebugDuration("workflow.node.done", startedAtMs, {
                nodeId,
                kind: node.kind,
                status: "success",
              });
              const result = execution.result;
              nodeObservation.update({
                input: redactor.redact(slimValue(inputs)),
                output: redactor.redact(slimValue(result)),
                ...(execution.tokenUsage
                  ? {
                      usageDetails: {
                        input: execution.tokenUsage.inputTokens,
                        output: execution.tokenUsage.outputTokens,
                      },
                    }
                  : {}),
              });
              const nodeOutputs: Record<string, unknown> = {};
              for (const output of outputsOf(node))
                nodeOutputs[output.name] = selectValue(output.selector, result, inputs);
              outputContext.set(nodeId, nodeOutputs);
              statuses.set(nodeId, "success");
              safeEmit({
                type: "node_result",
                nodeId,
                status: "success",
                inputs: slimValue(inputs, EVENT_SLIM_MAX_STRING, EVENT_SLIM_MAX_ITEMS) as Record<
                  string,
                  unknown
                >,
                outputs: nodeOutputs,
                result: slimValue(result, EVENT_SLIM_MAX_STRING, EVENT_SLIM_MAX_ITEMS),
                ...(execution.prompt !== undefined
                  ? {
                      prompt: slimValue(
                        execution.prompt,
                        EVENT_SLIM_MAX_STRING,
                        EVENT_SLIM_MAX_ITEMS,
                      ) as string,
                    }
                  : {}),
                ...(execution.systemPrompt !== undefined
                  ? {
                      systemPrompt: slimValue(
                        execution.systemPrompt,
                        EVENT_SLIM_MAX_STRING,
                        EVENT_SLIM_MAX_ITEMS,
                      ) as string,
                    }
                  : {}),
                metadata: {
                  durationMs: Date.now() - startedAtMs,
                  tokenUsage: normalizeTokenUsage(execution.tokenUsage),
                  attempts: execution.attempts,
                  selectedBranchId: execution.selectedBranchId,
                  selectedBranchLabel: execution.selectedBranchLabel,
                  warnings: execution.warnings,
                },
              });
              const outgoing = validation.outgoing.get(nodeId)!;
              if (node.kind === "condition") {
                for (const edge of selectedConditionEdges(configOf(node), result, outgoing)) {
                  activeEdges.add(edge.id);
                  activeNodes.add(edge.target);
                }
              } else {
                for (const edge of outgoing) {
                  activeEdges.add(edge.id);
                  activeNodes.add(edge.target);
                }
              }
            } catch (error) {
              const message = redactor.redact(
                error instanceof Error ? error.message : String(error),
              );
              logDebugDuration("workflow.node.done", startedAtMs, {
                nodeId,
                kind: node.kind,
                status: "error",
                error: message,
              });
              nodeObservation.update({ level: "ERROR", statusMessage: message });
              statuses.set(nodeId, "error");
              const failedPrompt = (error as { prompt?: unknown })?.prompt;
              const failedSystemPrompt = (error as { systemPrompt?: unknown })?.systemPrompt;
              safeEmit({
                type: "node_result",
                nodeId,
                status: "error",
                ...(error instanceof WorkflowSqlError
                  ? {
                      result: slimValue(error.result, EVENT_SLIM_MAX_STRING, EVENT_SLIM_MAX_ITEMS),
                    }
                  : {}),
                inputs: resolvedInputs
                  ? (slimValue(
                      resolvedInputs,
                      EVENT_SLIM_MAX_STRING,
                      EVENT_SLIM_MAX_ITEMS,
                    ) as Record<string, unknown>)
                  : undefined,
                ...(typeof failedPrompt === "string"
                  ? {
                      prompt: slimValue(
                        failedPrompt,
                        EVENT_SLIM_MAX_STRING,
                        EVENT_SLIM_MAX_ITEMS,
                      ) as string,
                    }
                  : {}),
                ...(typeof failedSystemPrompt === "string"
                  ? {
                      systemPrompt: slimValue(
                        failedSystemPrompt,
                        EVENT_SLIM_MAX_STRING,
                        EVENT_SLIM_MAX_ITEMS,
                      ) as string,
                    }
                  : {}),
                error: message,
                metadata: {
                  durationMs: Date.now() - startedAtMs,
                  tokenUsage: emptyTokenUsage(),
                  attempts: (error as { attempts?: number })?.attempts ?? 1,
                },
              });
              throw new WorkflowNodeError(nodeId, message);
            } finally {
              nodeObservation.end();
            }
          }
        },
      );
      const outputs = Object.fromEntries(
        [...outputContext.entries()].map(([nodeId, values]) => [nodeId, values]),
      );
      const finalOutputs = collectEndOutputs(validation.nodes, outputs, validation.order);
      span.update({ output: redactor.redact(finalOutputs) });
      safeEmit({ type: "run_done", outputs: finalOutputs, nodeOutputs: outputs });
      return outputs;
    } catch (error) {
      span.update({
        level: "ERROR",
        statusMessage: redactor.redact(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  });
}

export async function executeWorkflowNodeTest(
  request: WorkflowNodeTestRequest,
  dependencies: WorkflowDependencies = {},
): Promise<WorkflowNodeTestResult> {
  if (
    !request?.node ||
    !request.inputs ||
    typeof request.inputs !== "object" ||
    Array.isArray(request.inputs)
  ) {
    throw new WorkflowValidationError("node and inputs are required");
  }

  const bindings = inputsOf(request.node);
  const validationNode: WorkflowNodeInput = {
    ...request.node,
    config: {
      ...configOf(request.node),
      inputs: bindings.map((binding) => ({
        ...binding,
        // Isolated condition samples have runtime types; the evaluator reports mismatches.
        source: {
          type: "literal",
          value: request.node.kind === "condition" ? undefined : request.inputs[binding.name],
        },
      })),
    },
  };
  validateWorkflow({ nodes: [validationNode], edges: [], input: {} }, { nodeTest: true });

  const inputs: Record<string, unknown> = {};
  for (const binding of bindings) {
    const supplied = Object.prototype.hasOwnProperty.call(request.inputs, binding.name);
    const value = supplied
      ? request.inputs[binding.name]
      : binding.source.type === "literal"
        ? binding.source.value
        : undefined;
    inputs[binding.name] = value;
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const redactor = workflowRedactor([request.node], {});
  redactor.add(request.node, inputs);
  const finish = (
    value: Omit<WorkflowNodeTestResult, "nodeId" | "inputs" | "metadata"> & {
      tokenUsage?: Partial<WorkflowTokenUsage>;
      attempts?: number;
      selectedBranchId?: string;
      selectedBranchLabel?: string;
      warnings?: ConditionWarning[];
    },
  ): WorkflowNodeTestResult => {
    const finishedAtMs = Date.now();
    const { tokenUsage, attempts, selectedBranchId, selectedBranchLabel, warnings, ...result } =
      value;
    return {
      nodeId: request.node.id,
      inputs: redactor.redact(inputs),
      ...result,
      result: redactor.redact(result.result),
      outputs: redactor.redact(result.outputs),
      ...(result.error ? { error: redactor.redact(result.error) } : {}),
      metadata: {
        nodeKind: request.node.kind,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        tokenUsage: normalizeTokenUsage(tokenUsage),
        attempts,
        selectedBranchId,
        selectedBranchLabel,
        warnings,
      },
    };
  };

  return runTraced("workflow-node-test", async (span) => {
    span.update({
      input: redactor.redact(request.inputs),
      metadata: { nodeId: request.node.id, kind: request.node.kind },
    });
    const nodeObservation = startObservation(
      request.node.label ?? request.node.kind,
      nodeObservationAttributes(request.node),
      { asType: nodeKindAsType(request.node.kind) },
    );
    try {
      for (const binding of bindings) {
        if (inputs[binding.name] === undefined && binding.required !== false) {
          throw new WorkflowNodeError(request.node.id, `required input ${binding.name} is missing`);
        }
      }
      const execution = await runNodeWithPolicy(request.node, inputs, {
        ...resolvedDependencies(dependencies),
        redactor,
      });
      const outputs: Record<string, unknown> = {};
      for (const output of outputsOf(request.node)) {
        outputs[output.name] = selectValue(output.selector, execution.result, inputs);
      }
      nodeObservation.update({
        output: redactor.redact(slimValue(execution.result)),
        ...(execution.tokenUsage
          ? {
              usageDetails: {
                input: execution.tokenUsage.inputTokens,
                output: execution.tokenUsage.outputTokens,
              },
            }
          : {}),
      });
      const result = finish({
        status: "success",
        result: execution.result,
        outputs,
        tokenUsage: execution.tokenUsage ?? emptyTokenUsage(),
        attempts: execution.attempts,
        selectedBranchId: execution.selectedBranchId,
        selectedBranchLabel: execution.selectedBranchLabel,
        warnings: execution.warnings,
      });
      span.update({ output: result });
      return result;
    } catch (error) {
      const message = redactor.redact(error instanceof Error ? error.message : String(error));
      nodeObservation.update({ level: "ERROR", statusMessage: message });
      const result = finish({
        status: "error",
        result: error instanceof WorkflowSqlError ? error.result : null,
        outputs: {},
        error: message,
        attempts: (error as { attempts?: number })?.attempts ?? 1,
      });
      span.update({ level: "ERROR", output: result });
      return result;
    } finally {
      nodeObservation.end();
    }
  });
}
