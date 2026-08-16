import type { ResourceCatalog } from "../resources/api.js";

export type NodeKind = "start" | "input" | "rag" | "graph" | "llm" | "mcp" | "condition" | "end";
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
  data: WorkflowNodeData;
}

export interface WorkflowGraphEdge {
  source: string;
  target: string;
  label?: unknown;
}

export interface WorkflowValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
}

export function defaultConfig(kind: NodeKind): Record<string, WorkflowConfigValue> {
  if (kind === "rag") return { sources: [], topK: 5, query: "{{query}}", inputs: [], outputs: [] };
  if (kind === "graph")
    return {
      query: "{{query}}",
      inputs: [],
      outputs: [{ name: "formatted", selector: "$result.formatted" }],
    };
  if (kind === "llm")
    return {
      providerId: "default",
      model: "gpt-4o-mini",
      temperature: 0.2,
      systemPrompt: "你是一个乐于助人的 AI 助手，请基于给定的上下文严谨、准确地回答用户问题。",
      prompt: "",
      inputs: [],
      outputs: [{ name: "answer", selector: "$result" }],
    };
  if (kind === "mcp")
    return { serviceSlug: "", toolName: "", arguments: "{}", inputs: [], outputs: [] };
  if (kind === "condition") return { expression: "true", inputs: [], outputs: [] };
  if (kind === "input") {
    return {
      variable: "query",
      required: true,
      inputs: [{ name: "query", source: { type: "run", variable: "query" }, required: true }],
      outputs: [{ name: "query", selector: "$inputs.query" }],
    };
  }
  if (kind === "end") return { inputs: [], outputs: [] };
  return { inputs: [], outputs: [] };
}

function validInputs(value: unknown): NodeInputBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NodeInputBinding => {
    if (!item || typeof item !== "object") return false;
    const input = item as Partial<NodeInputBinding>;
    return typeof input.name === "string" && Boolean(input.name.trim()) && Boolean(input.source);
  });
}

function validOutputs(value: unknown): NodeOutputBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NodeOutputBinding => {
    if (!item || typeof item !== "object") return false;
    const output = item as Partial<NodeOutputBinding>;
    return (
      typeof output.name === "string" &&
      Boolean(output.name.trim()) &&
      typeof output.selector === "string"
    );
  });
}

export function migrateNodeData(data: WorkflowNodeData, nodeId?: string): WorkflowNodeData {
  const config = { ...defaultConfig(data.kind), ...(data.config ?? {}) };
  const legacyOutput = typeof data.config?.output === "string" ? data.config.output.trim() : "";
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
  if (data.kind === "input" && (config.inputs as NodeInputBinding[]).length === 0) {
    const variable =
      typeof config.variable === "string" && config.variable ? config.variable : "query";
    config.inputs = [
      { name: variable, source: { type: "run", variable }, required: config.required !== false },
    ];
    if ((config.outputs as NodeOutputBinding[]).length === 0) {
      config.outputs = [{ name: variable, selector: `$inputs.${variable}` }];
    }
  }
  return {
    ...data,
    id: typeof data.id === "string" && data.id ? data.id : (nodeId ?? ""),
    status: "idle",
    config,
  };
}

export function nodeInputs(data: WorkflowNodeData): NodeInputBinding[] {
  return validInputs(data.config.inputs);
}

export function nodeOutputs(data: WorkflowNodeData): NodeOutputBinding[] {
  return validOutputs(data.config.outputs);
}

export function validateNodeResources(
  data: WorkflowNodeData,
  catalog: ResourceCatalog | null,
): string | null {
  if (data.kind === "rag") {
    const sources = Array.isArray(data.config.sources) ? data.config.sources : [];
    if (sources.length === 0) return "至少挂载一个 RAG 文档";
    if (!catalog) return "资源目录尚未加载，无法校验 RAG 文档";
    const available = new Set(catalog.rag.sources.map((source) => source.source));
    const missing = sources.find((source) => !available.has(source));
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

export function validateWorkflowGraph(
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraphEdge[],
  catalog: ResourceCatalog | null,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
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
      if (source?.type === "run" && !source.variable.trim()) {
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
    if (node.data.kind === "condition" && nodeOutgoing.length > 0) {
      const labels = new Set(nodeOutgoing.map((edge) => edge.label));
      if (!labels.has("true") || !labels.has("false")) {
        issues.push({
          code: "condition-routes",
          message: `${node.data.label} 需要 True 和 False 两个出口`,
          nodeId: node.id,
        });
      }
    }

    const resourceError = validateNodeResources(node.data, catalog);
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

  return issues;
}
