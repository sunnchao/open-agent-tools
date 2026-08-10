import { callMcpTool, retrieveRag, retrieveRagGraph, type McpToolBinding } from "../resources.js";
import { getDefaultProvider, getProvider, type ProviderWithKey } from "../providers/store.js";
import { createLlmClient } from "../providers/clients/index.js";
import {
  runTraced,
  startObservation,
  withTraceAttributes,
  slimValue,
  type ObservationKind,
} from "../tracing.js";

export type WorkflowNodeKind =
  | "start"
  | "input"
  | "rag"
  | "graph"
  | "llm"
  | "mcp"
  | "condition"
  | "end";

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

export interface WorkflowEvent {
  type: "node_start" | "node_result" | "run_done" | "run_error";
  nodeId?: string;
  label?: string;
  status?: "success" | "error";
  outputs?: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

export interface WorkflowDependencies {
  retrieveRag?: typeof retrieveRag;
  retrieveRagGraph?: typeof retrieveRagGraph;
  callMcpTool?: typeof callMcpTool;
  getProvider?: (id: string, options?: { requireEnabled?: boolean }) => ProviderWithKey | null;
  getDefaultProvider?: (options?: { requireEnabled?: boolean }) => ProviderWithKey | null;
  completeLlm?: (
    provider: ProviderWithKey,
    input: { model: string; prompt: string; temperature?: number },
  ) => Promise<string | WorkflowLlmCompletion>;
  timeoutMs?: Partial<Record<"rag" | "llm" | "mcp" | "graph", number>>;
  signal?: AbortSignal;
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

const NODE_KINDS = new Set<WorkflowNodeKind>([
  "start",
  "input",
  "rag",
  "graph",
  "llm",
  "mcp",
  "condition",
  "end",
]);

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
): void {
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
      if (!/^\$(result|inputs)(\.[A-Za-z_$][\w$]*)*$/.test(output.selector)) {
        throw new WorkflowValidationError(
          `node ${node.id}: invalid output selector ${output.selector}`,
        );
      }
    }
  }
}

export function validateWorkflow(request: WorkflowRunRequest): WorkflowValidation {
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
  validateBindings(request.nodes, edges, outgoing);
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

function interpolate(
  value: unknown,
  inputs: Record<string, unknown>,
  mode: "text" | "expression",
): string {
  const text = String(value ?? "");
  return text.replace(/\{\{\s*([A-Za-z_$][\w$.-]*)\s*\}\}/g, (_match, name: string) => {
    const resolved = inputs[name];
    if (resolved === undefined) return mode === "expression" ? "undefined" : "";
    if (mode === "expression") return JSON.stringify(resolved);
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
}

function interpolateJsonValue(value: unknown, inputs: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => interpolateJsonValue(item, inputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateJsonValue(item, inputs)]),
    );
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{\s*([A-Za-z_$][\w$.-]*)\s*\}\}$/);
  if (exact) return inputs[exact[1]!];
  return interpolate(value, inputs, "text");
}

function selectValue(selector: string, result: unknown, inputs: Record<string, unknown>): unknown {
  const [root, ...path] = selector.split(".");
  let value: unknown = root === "$result" ? result : inputs;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
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
  tokenUsage?: Partial<WorkflowTokenUsage>;
}

const emptyTokenUsage = (): WorkflowTokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

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
    "retrieveRag" | "retrieveRagGraph" | "callMcpTool" | "getProvider" | "getDefaultProvider"
  >
> &
  WorkflowDependencies {
  return {
    retrieveRag,
    retrieveRagGraph,
    callMcpTool,
    getProvider,
    getDefaultProvider,
    ...dependencies,
  };
}

async function runNode(
  node: WorkflowNodeInput,
  inputs: Record<string, unknown>,
  deps: Required<
    Pick<
      WorkflowDependencies,
      "retrieveRag" | "retrieveRagGraph" | "callMcpTool" | "getProvider" | "getDefaultProvider"
    >
  > &
    WorkflowDependencies,
): Promise<NodeExecution> {
  const config = configOf(node);
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
        deps.timeoutMs?.rag ?? 15_000,
        deps.signal,
      );
      return { result };
    }
    case "graph": {
      const query = interpolate(config.query ?? inputs.query ?? "", inputs, "text");
      if (!query) throw new Error("graph node requires a query");
      const result = await withTimeout(
        deps.retrieveRagGraph({ query, signal: deps.signal }),
        deps.timeoutMs?.graph ?? 15_000,
        deps.signal,
      );
      return {
        result: {
          formatted: result.formatted,
          seeds: result.seeds,
        },
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
      const prompt = interpolate(config.prompt ?? "", inputs, "text");
      const temperature = typeof config.temperature === "number" ? config.temperature : undefined;
      const complete =
        deps.completeLlm ??
        (async (resolvedProvider, value) => {
          if (!resolvedProvider.apiKey)
            throw new Error(
              `Provider「${resolvedProvider.name}」未配置 API Key，请在「设置」中为该 Provider 填写 API Key`,
            );
          const completion = await createLlmClient(resolvedProvider).complete({
            model: value.model,
            messages: [{ role: "user", content: value.prompt }],
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
      const completion = await withTimeout(
        complete(provider, { model, prompt, temperature }),
        deps.timeoutMs?.llm ?? 30_000,
        deps.signal,
      );
      return typeof completion === "string"
        ? { result: completion }
        : { result: completion.content, tokenUsage: completion.tokenUsage };
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
        deps.callMcpTool(binding, args),
        deps.timeoutMs?.mcp ?? 30_000,
        deps.signal,
      );
      return { result };
    }
    case "condition": {
      const expression = interpolate(config.expression ?? "false", inputs, "expression");
      let result: unknown;
      try {
        result = Function(`"use strict"; return (${expression});`)();
      } catch (error) {
        throw new Error(
          `condition expression failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof result !== "boolean") throw new Error("condition expression must return boolean");
      return { result };
    }
    case "end":
      return { result: inputs };
  }
}

function resolveInputs(
  node: WorkflowNodeInput,
  request: WorkflowRunRequest,
  outputContext: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
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
  const deps = resolvedDependencies(dependencies);
  const activeNodes = new Set(
    validation.nodes
      .filter((node) => validation.incoming.get(node.id)!.length === 0)
      .map((node) => node.id),
  );
  const activeEdges = new Set<string>();
  const statuses = new Map<string, "success" | "error">();
  const outputContext = new Map<string, Record<string, unknown>>();

  return runTraced("workflow-run", async (span) => {
    span.update({
      input: slimValue(request.input),
      metadata: {
        nodeCount: String(validation.nodes.length),
        edgeCount: String(validation.edges.length),
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
          for (const nodeId of validation.order) {
            if (deps.signal?.aborted) throw new Error("workflow run cancelled");
            if (!activeNodes.has(nodeId)) continue;
            const node = validation.byId.get(nodeId)!;
            const incoming = validation.incoming
              .get(nodeId)!
              .filter((edge) => activeEdges.has(edge.id));
            if (incoming.some((edge) => statuses.get(edge.source) !== "success")) continue;
            if (nodeId && !request.input)
              throw new WorkflowNodeError(nodeId, "workflow input is required");
            emit({ type: "node_start", nodeId, label: node.label ?? node.kind });
            const nodeObservation = startObservation(
              node.label ?? node.kind,
              nodeObservationAttributes(node),
              { asType: nodeKindAsType(node.kind) },
            );
            try {
              const inputs = resolveInputs(node, request, outputContext);
              const execution = await runNode(node, inputs, deps);
              const result = execution.result;
              nodeObservation.update({
                input: slimValue(inputs),
                output: slimValue(result),
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
              emit({ type: "node_result", nodeId, status: "success", outputs: nodeOutputs });
              const outgoing = validation.outgoing.get(nodeId)!;
              if (node.kind === "condition") {
                const condition = result === true;
                const selected = outgoing.filter((edge) => edge.label === String(condition));
                const defaults = outgoing.filter((edge) => !edge.label);
                for (const edge of selected.length > 0 ? selected : defaults) {
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
              const message = error instanceof Error ? error.message : String(error);
              nodeObservation.update({ level: "ERROR", statusMessage: message });
              statuses.set(nodeId, "error");
              emit({ type: "node_result", nodeId, status: "error", error: message });
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
      span.update({ output: outputs });
      emit({ type: "run_done", outputs });
      return outputs;
    } catch (error) {
      span.update({
        level: "ERROR",
        statusMessage: error instanceof Error ? error.message : String(error),
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
        source: { type: "literal", value: request.inputs[binding.name] },
      })),
    },
  };
  validateWorkflow({ nodes: [validationNode], edges: [], input: {} });

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
  const finish = (
    value: Omit<WorkflowNodeTestResult, "nodeId" | "inputs" | "metadata"> & {
      tokenUsage?: Partial<WorkflowTokenUsage>;
    },
  ): WorkflowNodeTestResult => {
    const finishedAtMs = Date.now();
    const { tokenUsage, ...result } = value;
    return {
      nodeId: request.node.id,
      inputs,
      ...result,
      metadata: {
        nodeKind: request.node.kind,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        tokenUsage: normalizeTokenUsage(tokenUsage),
      },
    };
  };

  return runTraced("workflow-node-test", async (span) => {
    span.update({
      input: request.inputs,
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
      const execution = await runNode(request.node, inputs, resolvedDependencies(dependencies));
      const outputs: Record<string, unknown> = {};
      for (const output of outputsOf(request.node)) {
        outputs[output.name] = selectValue(output.selector, execution.result, inputs);
      }
      nodeObservation.update({
        output: slimValue(execution.result),
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
      });
      span.update({ output: result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      nodeObservation.update({ level: "ERROR", statusMessage: message });
      const result = finish({
        status: "error",
        result: null,
        outputs: {},
        error: message,
      });
      span.update({ level: "ERROR", output: result });
      return result;
    } finally {
      nodeObservation.end();
    }
  });
}
