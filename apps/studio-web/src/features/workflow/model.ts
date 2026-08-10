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
  label: string;
  description: string;
  kind: NodeKind;
  status: NodeRunStatus;
  config: Record<string, WorkflowConfigValue>;
}

export function defaultConfig(kind: NodeKind): Record<string, WorkflowConfigValue> {
  if (kind === "rag") return { sources: [], topK: 5, query: "{{query}}", inputs: [], outputs: [] };
  if (kind === "graph")
    return { query: "{{query}}", inputs: [], outputs: [{ name: "formatted", selector: "$result.formatted" }] };
  if (kind === "llm")
    return {
      providerId: "default",
      model: "gpt-4o-mini",
      temperature: 0.2,
      prompt: "基于检索上下文回答用户问题。",
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

export function migrateNodeData(data: WorkflowNodeData): WorkflowNodeData {
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
  return { ...data, status: "idle", config };
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
