import {
  workflowGraphSchema,
  effectiveNodeConfig,
  isLegacyGraphNode,
  migrateLegacyGraphNode,
  migrateLegacyGraphNodes,
  type LegacyGraphNodeLike,
  type NodeKind,
} from "./graph.js";
import { isVisualCondition, conditionRouteIssues } from "./condition.js";
import { variableIssues, variableNodes } from "./variables.js";
export type { NodeKind } from "./graph.js";

/** Only the resource fields needed by editor validation; credentials stay on the server. */
export interface ResourceCatalog {
  mcp: { services: Array<{ serviceSlug: string; tools: Array<{ name: string }> }> };
  rag: { sources: Array<{ source: string }> };
  sql?: { sources: Array<{ id: string; isDefault: boolean }>; error?: string };
}
export type NodeRunStatus = "idle" | "running" | "success" | "error";
export type WorkflowConfigValue = unknown;

export type InputSource =
  | { type: "literal"; value: unknown }
  | { type: "run"; variable: string }
  | { type: "node"; nodeId: string; output: string };

export interface NodeInputBinding {
  name: string;
  source: InputSource;
  required?: boolean;
}

export interface NodeOutputBinding {
  name: string;
  selector: string;
}

export interface WorkflowNodeData extends Record<string, unknown> {
  /** 节点唯一 ID，与 React Flow 顶层 node.id 保持一致，保证节点数据自包含。 */
  id: string;
  label: string;
  description: string;
  kind: NodeKind;
  status: NodeRunStatus;
  config: Record<string, WorkflowConfigValue>;
}

export interface WorkflowGraphNode {
  id: string;
  data: Pick<WorkflowNodeData, "kind" | "label" | "config"> &
    Partial<Pick<WorkflowNodeData, "id" | "description" | "status">>;
}

export interface WorkflowGraphEdge {
  source: string;
  target: string;
  label?: unknown;
  branchId?: string;
}

export interface WorkflowValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  suggestions?: string[];
  reference?: string;
  field?: string;
}

export function defaultConfig(kind: NodeKind): Record<string, WorkflowConfigValue> {
  if (kind === "condition")
    return {
      mode: "visual",
      cases: [{ id: "if", logicalOperator: "and", rules: [] }],
      inputs: [],
      outputs: [],
    };
  return structuredClone(effectiveNodeConfig(kind, kind === "start" ? { runVariables: [] } : {}));
}

function validInputs(value: unknown): NodeInputBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NodeInputBinding => {
    if (!item || typeof item !== "object") return false;
    const input = item as Partial<NodeInputBinding>;
    return typeof input.name === "string" && Boolean(input.source);
  });
}

function validOutputs(value: unknown): NodeOutputBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NodeOutputBinding => {
    if (!item || typeof item !== "object") return false;
    const output = item as Partial<NodeOutputBinding>;
    return typeof output.name === "string" && typeof output.selector === "string";
  });
}

/**
 * 迁移入参：本地草稿 / 服务端历史快照里的 `kind` 可能已不是合法 NodeKind
 * （典型例子：已删除的 `"graph"`），因此这里放宽为 string，由迁移函数先归一化。
 */
export type MigratableNodeData = Omit<WorkflowNodeData, "kind"> & { kind: string };

export function migrateNodeData(
  input: MigratableNodeData,
  nodeId?: string,
  options: { normalizeConfig?: boolean } = {},
): WorkflowNodeData {
  // 旧版独立「图谱检索」节点：先迁移为「知识检索」节点（保持 sources/query/outputs 绑定不裂），
  // 再走下方统一的配置归一化。迁移是幂等的，重复调用不会二次改写。
  const data = (isLegacyGraphNode(input)
    ? migrateLegacyGraphNode(input)
    : input) as unknown as WorkflowNodeData;
  const normalize = options.normalizeConfig !== false;
  const config = !normalize
    ? { ...effectiveNodeConfig(data.kind), ...(data.config ?? {}) }
    : data.kind === "condition"
      ? effectiveNodeConfig("condition", data.config ?? {})
      : { ...defaultConfig(data.kind), ...(data.config ?? {}) };
  if (normalize) {
    const legacyOutput = typeof data.config?.output === "string" ? data.config.output.trim() : "";
    if (data.kind === "start" && !Object.hasOwn(data.config ?? {}, "runVariables"))
      delete config.runVariables;
    config.inputs = validInputs(config.inputs);
    config.outputs = validOutputs(config.outputs);
    if (legacyOutput && (config.outputs as NodeOutputBinding[]).length === 0) {
      config.outputs = [{ name: legacyOutput, selector: "$result" }];
    }
    if (data.kind === "rag") {
      const legacySource =
        typeof config.knowledgeBase === "string" ? config.knowledgeBase.trim() : "";
      const savedSources = data.config?.sources;
      config.sources = Array.isArray(savedSources)
        ? savedSources.filter(
            (source): source is string => typeof source === "string" && Boolean(source),
          )
        : legacySource
          ? [legacySource]
          : [];
      delete config.knowledgeBase;
    }
    if (data.kind === "mcp") {
      config.serviceSlug =
        typeof config.serviceSlug === "string" && config.serviceSlug
          ? config.serviceSlug
          : typeof config.service === "string"
            ? config.service
            : "";
      config.toolName =
        typeof config.toolName === "string" && config.toolName
          ? config.toolName
          : typeof config.tool === "string"
            ? config.tool
            : "";
      delete config.service;
      delete config.tool;
    }
    if (data.kind === "llm") {
      // 旧版只有单个 prompt（UI 曾标为「系统提示词」），迁移为 systemPrompt；
      // prompt 留空则由执行器自动拼接输入变量为 user 消息，避免系统提示词覆盖入参数据。
      const hadSystemPrompt =
        Object.prototype.hasOwnProperty.call(data.config ?? {}, "systemPrompt") &&
        typeof config.systemPrompt === "string";
      const legacyPrompt = data.config?.prompt;
      if (!hadSystemPrompt) {
        if (typeof legacyPrompt === "string" && legacyPrompt) {
          config.systemPrompt = legacyPrompt;
          config.prompt = "";
        } else {
          // 旧节点既无 systemPrompt 也无有效 prompt：保留默认系统提示词，prompt 留空自动拼接输入。
          config.prompt = "";
        }
      }
      if (typeof config.prompt !== "string") config.prompt = "";
    }
    if (data.kind === "input" && !Array.isArray(data.config?.inputs)) {
      const variable =
        typeof config.variable === "string" && config.variable ? config.variable : "query";
      config.inputs = [
        { name: variable, source: { type: "run", variable }, required: config.required !== false },
      ];
      if ((config.outputs as NodeOutputBinding[]).length === 0) {
        config.outputs = [{ name: variable, selector: `$inputs.${variable}` }];
      }
    }
  } else if (data.kind === "mcp") {
    if (!config.serviceSlug && typeof data.config?.service === "string")
      config.serviceSlug = data.config.service;
    if (!config.toolName && typeof data.config?.tool === "string")
      config.toolName = data.config.tool;
    delete config.service;
    delete config.tool;
  }
  return {
    ...data,
    id: typeof data.id === "string" && data.id ? data.id : (nodeId ?? ""),
    status: "idle",
    config,
  };
}

export function nodeInputs(data: { config?: Record<string, unknown> }): NodeInputBinding[] {
  return validInputs(data.config?.inputs);
}

export function nodeOutputs(data: { config?: Record<string, unknown> }): NodeOutputBinding[] {
  return validOutputs(data.config?.outputs);
}

export function validateNodeResources(
  data: { kind: NodeKind; config: Record<string, unknown>; label?: string },
  catalog: ResourceCatalog | null,
  strictRagSources = true,
): string | null {
  if (data.kind === "sql") {
    if (!String(data.config.query ?? "").trim()) return "请配置 SQL 问数问题";
    if (!catalog) return "资源目录尚未加载，无法校验 SQL 数据源";
    if (catalog.sql?.error) return `SQL 数据源加载失败：${catalog.sql.error}`;
    const sourceId = String(data.config.sourceId ?? "").trim();
    const source = sourceId
      ? catalog.sql?.sources.find((item) => item.id === sourceId)
      : catalog.sql?.sources.find((item) => item.isDefault);
    if (!source)
      return sourceId
        ? `SQL 数据源已失效或停用：${sourceId}`
        : "暂无默认 SQL 数据源，请选择数据源或在设置中配置";
  }
  if (data.kind === "rag") {
    const sources = Array.isArray(data.config.sources) ? data.config.sources : [];
    if (sources.length === 0) return "至少挂载一个 RAG 文档";
    if (!catalog) return "资源目录尚未加载，无法校验 RAG 文档";
    const available = new Set(catalog.rag.sources.map((source) => source.source));
    const missing = sources.find(
      (source) => (strictRagSources || typeof source === "string") && !available.has(source),
    );
    if (missing) return `RAG 文档已失效：${missing}`;
  }

  if (data.kind === "mcp") {
    const serviceSlug = String(data.config.serviceSlug ?? "");
    const toolName = String(data.config.toolName ?? "");
    if (!serviceSlug || !toolName) return "请选择 MCP 服务和 Tool";
    if (!catalog) return "资源目录尚未加载，无法校验 MCP Tool";
    const service = catalog.mcp.services.find((item) => item.serviceSlug === serviceSlug);
    if (!service?.tools.some((tool) => tool.name === toolName)) {
      return `MCP Tool 已失效：${serviceSlug}/${toolName}`;
    }
    try {
      const parsed = JSON.parse(String(data.config.arguments ?? "{}")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "MCP 参数映射必须是 JSON 对象";
      }
    } catch {
      return "MCP 参数映射不是合法 JSON";
    }
  }

  return null;
}

/**
 * 把快照里遗留的旧 `kind:"graph"` 节点迁移为知识检索节点。
 *
 * 为什么要单独抽一层：契约的迁移函数只认「节点形状」，而这里的节点还包着 React Flow 的
 * `data` 外壳与位置信息，不能直接丢给 `migrateLegacyGraphNodes`。
 * 返回新数组；未命中的节点保持原引用，不修改入参。
 */
export function migrateLegacyGraphNodesInGraph<
  T extends { id: string; data: Record<string, unknown> },
>(nodes: readonly T[]): T[] {
  const dataList = nodes.map((node) => node.data);
  const migratedData = migrateLegacyGraphNodes(dataList);
  return nodes.map((node, index) => {
    const next = migratedData[index]!;
    if (next === dataList[index]) return node;
    // 旧 graph 节点的 data 形状不满足 WorkflowNodeData（kind 已不是合法 NodeKind），
    // 迁移后再走一遍统一归一化，补齐 sources/graph/graphHops 等默认值。
    return {
      ...node,
      data: migrateNodeData(next as unknown as MigratableNodeData, node.id),
    };
  });
}

/**
 * 迁移「尚未通过 schema 校验」的 JSON 快照（导入文件 / 剪贴板）里的旧 graph 节点。
 *
 * 支持两种包装：工作流文件是 `{ graph: { nodes } }`，剪贴板内容是 `{ nodes }`。
 * 输入形状不可信：只有 nodes 为数组且每个节点 data 为对象时才处理，其余原样返回，
 * 让 schema 继续给出明确的格式错误，而不是在迁移阶段抛类型异常。
 */
export function migrateLegacyGraphNodesInSnapshot<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const graph = record.graph;
  if (graph && typeof graph === "object") {
    const migratedGraph = migrateLegacyGraphNodesInSnapshot(graph);
    if (migratedGraph === graph) return value;
    return { ...record, graph: migratedGraph } as T;
  }
  const nodes = record.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return value;
  const dataList: LegacyGraphNodeLike[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") return value;
    const data = (node as { data?: unknown }).data;
    if (!data || typeof data !== "object") return value;
    dataList.push(data as LegacyGraphNodeLike);
  }
  const migratedData = migrateLegacyGraphNodes(dataList);
  if (migratedData.every((item, index) => item === dataList[index])) return value;
  return {
    ...record,
    nodes: nodes.map((node, index) => ({
      ...(node as Record<string, unknown>),
      data: migratedData[index],
    })),
  } as T;
}

export function validateWorkflowGraph(
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraphEdge[],
  catalog: ResourceCatalog | null,
  options: { strict?: boolean } = {},
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const strict = options.strict !== false;
  if (strict) {
    // 旧草稿/旧版本可能仍含 graph 节点，先迁移再交给 schema 校验；
    // 否则 schema 会以「未知 kind」直接拒绝整个工作流。
    const migratedNodes = migrateLegacyGraphNodesInGraph(nodes);
    const structural = workflowGraphSchema.safeParse({
      name: "validation",
      nodes: migratedNodes,
      edges,
    });
    if (!structural.success) {
      return structural.error.issues.map((issue) => ({
        code: "schema",
        message: `${issue.path.join(".")}: ${issue.message}`,
        ...(typeof issue.path[1] === "number" && issue.path[0] === "nodes"
          ? { nodeId: migratedNodes[issue.path[1]]?.id }
          : {}),
      }));
    }
    nodes = migratedNodes;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, [] as WorkflowGraphEdge[]]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as WorkflowGraphEdge[]]));
  const starts = nodes.filter((node) => node.data.kind === "start");
  const ends = nodes.filter((node) => node.data.kind === "end");

  if (nodes.length === 0) issues.push({ code: "empty", message: "工作流至少需要一个节点" });
  if (starts.length !== 1) {
    issues.push({
      code: "start-count",
      message: starts.length === 0 ? "工作流需要一个开始节点" : "工作流只能有一个开始节点",
      ...(starts[1] ? { nodeId: starts[1].id } : {}),
    });
  }
  if (ends.length === 0) issues.push({ code: "end-count", message: "工作流至少需要一个结束节点" });

  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      issues.push({ code: "unknown-edge-node", message: "连接引用了已不存在的节点" });
      continue;
    }
    outgoing.get(edge.source)?.push(edge);
    incoming.get(edge.target)?.push(edge);
  }

  for (const node of nodes) {
    const nodeIncoming = incoming.get(node.id) ?? [];
    const nodeOutgoing = outgoing.get(node.id) ?? [];
    if (node.data.kind === "start" && nodeIncoming.length > 0) {
      issues.push({ code: "start-incoming", message: "开始节点不能有上游连接", nodeId: node.id });
    }
    if (node.data.kind !== "start" && nodeIncoming.length === 0) {
      issues.push({
        code: "missing-incoming",
        message: `${node.data.label} 缺少上游连接`,
        nodeId: node.id,
      });
    }
    if (node.data.kind === "end" && nodeOutgoing.length > 0) {
      issues.push({ code: "end-outgoing", message: "结束节点不能连接下游节点", nodeId: node.id });
    }
    if (node.data.kind !== "end" && nodeOutgoing.length === 0) {
      issues.push({
        code: "missing-outgoing",
        message: `${node.data.label} 缺少下游连接`,
        nodeId: node.id,
      });
    }

    const rawInputs = Array.isArray(node.data.config.inputs)
      ? (node.data.config.inputs as NodeInputBinding[])
      : [];
    const rawOutputs = Array.isArray(node.data.config.outputs)
      ? (node.data.config.outputs as NodeOutputBinding[])
      : [];
    const inputNames = new Set<string>();
    const outputNames = new Set<string>();
    for (const input of rawInputs) {
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) {
        issues.push({
          code: "input-name",
          message: `${node.data.label} 存在未命名输入`,
          nodeId: node.id,
        });
        continue;
      }
      if (inputNames.has(name)) {
        issues.push({
          code: "input-duplicate",
          message: `${node.data.label} 的输入 ${name} 重复`,
          nodeId: node.id,
        });
      }
      inputNames.add(name);
      const source = input.source;
      if (strict && source?.type === "run" && !source.variable.trim()) {
        issues.push({
          code: "run-variable",
          message: `${node.data.label} 的运行输入变量不能为空`,
          nodeId: node.id,
        });
      }
      if (source?.type === "node") {
        const direct = nodeIncoming.some((edge) => edge.source === source.nodeId);
        const sourceNode = byId.get(source.nodeId);
        const declared =
          sourceNode &&
          nodeOutputs(sourceNode.data).some((output) => output.name === source.output);
        if (!direct || !declared) {
          issues.push({
            code: "node-output",
            message: `${node.data.label} 引用了无效输出 ${source.nodeId}.${source.output}`,
            nodeId: node.id,
          });
        }
      }
    }
    for (const output of rawOutputs) {
      const name = typeof output?.name === "string" ? output.name.trim() : "";
      const selector = typeof output?.selector === "string" ? output.selector.trim() : "";
      if (!name) {
        issues.push({
          code: "output-name",
          message: `${node.data.label} 存在未命名输出`,
          nodeId: node.id,
        });
        continue;
      }
      if (outputNames.has(name)) {
        issues.push({
          code: "output-duplicate",
          message: `${node.data.label} 的输出 ${name} 重复`,
          nodeId: node.id,
        });
      }
      outputNames.add(name);
      if (!/^\$(result|inputs)(\.[A-Za-z_$][\w$]*)*$/.test(selector)) {
        issues.push({
          code: "output-selector",
          message: `${node.data.label} 的输出选择器 ${selector || "为空"} 无效`,
          nodeId: node.id,
        });
      }
    }

    if (node.data.kind === "end" && rawOutputs.length === 0) {
      issues.push({
        code: "end-output",
        message: `${node.data.label} 尚未配置最终输出`,
        nodeId: node.id,
      });
    }
    if (
      node.data.kind === "llm" &&
      rawInputs.length === 0 &&
      !String(node.data.config.prompt ?? "").trim()
    ) {
      issues.push({
        code: "llm-prompt",
        message: `${node.data.label} 需要输入变量或用户提示词`,
        nodeId: node.id,
      });
    }
    if (node.data.kind === "condition" && isVisualCondition(node.data.config)) {
      issues.push(
        ...conditionRouteIssues(node.data.config, nodeOutgoing).map((issue) => ({
          ...issue,
          nodeId: node.id,
        })),
      );
    } else if (strict && node.data.kind === "condition" && nodeOutgoing.length > 0) {
      const labels = new Set(nodeOutgoing.map((edge) => edge.label));
      if (!labels.has("true") || !labels.has("false")) {
        issues.push({
          code: "condition-routes",
          message: `${node.data.label} 需要 True 和 False 两个出口`,
          nodeId: node.id,
        });
      }
    }

    const resourceError = validateNodeResources(node.data, catalog, strict);
    if (resourceError) {
      issues.push({ code: "resource", message: resourceError, nodeId: node.id });
    }
  }

  const degrees = new Map(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const queue = nodes.filter((node) => degrees.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    visited += 1;
    for (const edge of outgoing.get(queue[index]!) ?? []) {
      const next = (degrees.get(edge.target) ?? 1) - 1;
      degrees.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }
  if (visited !== nodes.length) issues.push({ code: "cycle", message: "工作流中存在循环连接" });

  issues.push(...variableIssues(variableNodes(nodes)));
  return issues;
}
