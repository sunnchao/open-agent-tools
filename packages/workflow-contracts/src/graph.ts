import { z } from "zod";
import { conditionFields } from "./condition.js";

/**
 * 节点类型。
 *
 * 图谱能力已并入知识库：不再有独立的 "graph" 节点，知识检索节点用 `graph` 开关控制
 * 是否启用图谱第三路增强。历史上的 graph 节点由各端在读取旧草稿/旧版本时迁移为 rag 节点。
 */
export const nodeKindSchema = z.enum([
  "start",
  "input",
  "rag",
  "sql",
  "llm",
  "mcp",
  "http",
  "condition",
  "end",
]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const inputBindingSchema = z.object({
  name: z.string(),
  required: z.boolean().optional(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("literal"), value: z.unknown().optional() }),
    z.object({ type: z.literal("run"), variable: z.string() }),
    z.object({ type: z.literal("node"), nodeId: z.string(), output: z.string() }),
  ]),
});
export const outputBindingSchema = z.object({ name: z.string(), selector: z.string() });
export const runVariableSchema = z.object({
  name: z.string(),
  type: z.enum(["any", "string", "number", "boolean", "object", "array"]),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
});
const bindings = {
  inputs: z.array(inputBindingSchema).optional(),
  outputs: z.array(outputBindingSchema).optional(),
  output: z.string().optional(),
};
const execution = {
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  retry: z
    .object({
      maxRetries: z.number().int().min(0).max(3),
      delayMs: z.number().int().min(100).max(10000).optional(),
    })
    .optional(),
};
export const nodeConfigSchemas = {
  start: z
    .object({ ...bindings, runVariables: z.array(runVariableSchema).optional() })
    .passthrough(),
  input: z
    .object({ ...bindings, variable: z.string().optional(), required: z.boolean().optional() })
    .passthrough(),
  rag: z
    .object({
      ...bindings,
      ...execution,
      sources: z.array(z.string()).optional(),
      knowledgeBase: z.string().optional(),
      topK: z.number().int().min(1).max(20).optional(),
      query: z.string().optional(),
      /** 是否启用图谱第三路增强（实体关系回溯分块参与 RRF）。缺省视为开启。 */
      graph: z.boolean().optional(),
      /** 图谱子图扩展跳数，1-4；仅 graph 开启时生效。 */
      graphHops: z.number().int().min(1).max(4).optional(),
    })
    .passthrough(),
  sql: z
    .object({
      ...bindings,
      ...execution,
      sourceId: z.string().optional(),
      query: z.string().optional(),
      maxRows: z.number().int().min(1).max(100).optional(),
    })
    .passthrough(),
  llm: z
    .object({
      ...bindings,
      ...execution,
      providerId: z.string().optional(),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      systemPrompt: z.string().optional(),
      prompt: z.string().optional(),
    })
    .passthrough(),
  mcp: z
    .object({
      ...bindings,
      ...execution,
      serviceSlug: z.string().optional(),
      toolName: z.string().optional(),
      service: z.string().optional(),
      tool: z.string().optional(),
      arguments: z.string().optional(),
    })
    .passthrough(),
  http: z
    .object({
      ...bindings,
      ...execution,
      method: z.enum(["get", "head", "post", "put", "patch", "delete"]).optional(),
      url: z.string().optional(),
      params: z.string().optional(),
      headers: z.string().optional(),
      body: z
        .object({
          type: z.enum(["none", "json", "form-data", "raw"]).optional(),
          data: z
            .union([
              z.string(),
              z.array(
                z.object({
                  key: z.string(),
                  type: z.literal("text").optional(),
                  value: z.string(),
                }),
              ),
            ])
            .optional(),
        })
        .optional(),
      authorization: z
        .object({
          type: z.enum(["no-auth", "basic", "bearer", "custom"]).optional(),
          config: z
            .object({
              username: z.string().optional(),
              password: z.string().optional(),
              token: z.string().optional(),
              header: z.string().optional(),
              value: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      sslVerify: z.boolean().optional(),
    })
    .passthrough(),
  condition: z.object({ ...bindings, ...conditionFields }).passthrough(),
  end: z.object(bindings).passthrough(),
} satisfies Record<NodeKind, z.ZodType>;

const defaultSystemPrompt =
  "你是一个乐于助人的 AI 助手，请基于给定的上下文严谨、准确地回答用户问题。";
const defaultNodeConfig: Record<NodeKind, Record<string, unknown>> = {
  start: { inputs: [], outputs: [], runVariables: [] },
  input: {
    variable: "query",
    required: true,
    inputs: [{ name: "query", source: { type: "run", variable: "query" }, required: true }],
    outputs: [{ name: "query", selector: "$inputs.query" }],
  },
  rag: {
    sources: [],
    topK: 5,
    query: "{{query}}",
    graph: true,
    graphHops: 2,
    inputs: [],
    outputs: [{ name: "formatted", selector: "$result.formatted" }],
  },
  sql: {
    sourceId: "",
    query: "{{query}}",
    maxRows: 100,
    inputs: [],
    outputs: [
      { name: "rows", selector: "$result.rows" },
      { name: "sql", selector: "$result.sql" },
      { name: "rowCount", selector: "$result.rowCount" },
      { name: "auditId", selector: "$result.auditId" },
    ],
  },
  llm: {
    providerId: "default",
    model: "gpt-4o-mini",
    temperature: 0.2,
    systemPrompt: defaultSystemPrompt,
    prompt: "",
    inputs: [],
    outputs: [{ name: "answer", selector: "$result" }],
  },
  mcp: { serviceSlug: "", toolName: "", arguments: "{}", inputs: [], outputs: [] },
  http: {
    method: "get",
    url: "",
    params: "",
    headers: "",
    body: { type: "none", data: "" },
    authorization: { type: "no-auth", config: {} },
    sslVerify: true,
    inputs: [],
    outputs: [
      { name: "body", selector: "$result.body" },
      { name: "status_code", selector: "$result.status_code" },
      { name: "headers", selector: "$result.headers" },
      { name: "size", selector: "$result.size" },
    ],
  },
  condition: { expression: "true", inputs: [], outputs: [] },
  end: { inputs: [], outputs: [] },
};
export type HttpNodeConfig = z.infer<typeof nodeConfigSchemas.http>;

/** 旧版独立图谱节点的节点类型。只用于迁移遗留草稿/版本，不再是合法 kind。 */
export const LEGACY_GRAPH_KIND = "graph";

/** 旧版图谱节点的输出契约；迁移为知识检索节点时需保留同名输出，避免下游绑定断裂。 */
const LEGACY_GRAPH_OUTPUTS = [{ name: "formatted", selector: "$result.formatted" }];

export interface LegacyGraphNodeLike {
  id?: string;
  kind?: string;
  label?: string;
  description?: string;
  config?: Record<string, unknown>;
}

/**
 * 判断一个节点是否是旧版独立图谱节点。
 *
 * 独立「图谱检索」节点已并入知识检索节点（`rag` + `config.graph`）。历史草稿、已发布版本、
 * 导入文件里仍可能出现 `kind: "graph"`，读取时必须迁移而不是报错，否则用户升级后工作流直接打不开。
 */
export function isLegacyGraphNode(node: { kind?: unknown } | null | undefined): boolean {
  return node?.kind === LEGACY_GRAPH_KIND;
}

/**
 * 把旧版图谱节点迁移为知识检索节点（纯函数，幂等）。
 *
 * 迁移语义：
 * - kind `graph` → `rag`，`graph: true` 让图谱第三路保持启用（旧节点本来只做图谱检索；
 *   迁移后同时获得向量/关键词召回，是对旧行为的增强而非削弱）；
 * - `sources`/`query`/`inputs`/`outputs` 原样保留，保证下游 `$result.formatted` 绑定不断裂；
 * - 标签统一改为「知识检索」：节点库已没有「图谱检索」类型，若继续显示旧名会让用户
 *   以为还存在两种节点；旧名在描述里标注一次，说明它是由图谱节点迁移而来。
 */
export function migrateLegacyGraphNode<T extends LegacyGraphNodeLike>(node: T): T {
  if (!isLegacyGraphNode(node)) return node;
  const config = { ...(node.config ?? {}) };
  const outputs = Array.isArray(config.outputs) ? config.outputs : [];
  // 用户可能改过节点名/描述；只有仍是默认旧文案（或为空）时才覆盖，避免抹掉自定义内容。
  const defaultLegacyLabels = new Set(["图谱检索", "知识图谱", ""]);
  const defaultLegacyDescriptions = new Set(["子图多跳扩展", "知识图谱", ""]);
  const label =
    typeof node.label === "string" && node.label && !defaultLegacyLabels.has(node.label.trim())
      ? node.label
      : "知识检索";
  const description =
    typeof node.description === "string" &&
    node.description &&
    !defaultLegacyDescriptions.has(node.description.trim())
      ? node.description
      : "向量+关键词+图谱多路召回";
  return {
    ...node,
    kind: "rag",
    label,
    description,
    config: {
      ...defaultNodeConfig.rag,
      ...config,
      graph: true,
      graphHops:
        typeof config.graphHops === "number" && config.graphHops >= 1 && config.graphHops <= 4
          ? config.graphHops
          : defaultNodeConfig.rag.graphHops,
      // 旧节点若声明了输出，尊重用户的输出映射；否则补上 formatted，保持与旧契约一致。
      outputs: outputs.length > 0 ? outputs : LEGACY_GRAPH_OUTPUTS,
    },
  };
}

/** 批量迁移节点列表（返回新数组，不改入参）。 */
export function migrateLegacyGraphNodes<T extends LegacyGraphNodeLike>(nodes: readonly T[]): T[] {
  return nodes.map((node) => migrateLegacyGraphNode(node));
}

export interface WorkflowRunNodeInput {
  id: string;
  kind: NodeKind;
  label?: string;
  config?: Record<string, unknown>;
}

export interface WorkflowCanvasNodeLike {
  id: string;
  data: {
    kind: string;
    label?: string;
    config?: Record<string, unknown>;
  };
}

export interface LabeledWorkflowCanvasNodeLike {
  id: string;
  data: {
    kind: string;
    label: string;
    config?: Record<string, unknown>;
  };
}

export interface ExecutableWorkflowCanvasNodeLike {
  id: string;
  data: {
    kind: string;
    label: string;
    config: Record<string, unknown>;
  };
}

/**
 * Convert persisted/editor canvas nodes to the executor shape.
 *
 * Historical graph nodes are migrated at this boundary so every client and the server
 * apply the same compatibility rule before starting a run.
 */
export function graphToRunNodes(graph: {
  nodes: readonly ExecutableWorkflowCanvasNodeLike[];
}): Array<WorkflowRunNodeInput & { label: string; config: Record<string, unknown> }>;
export function graphToRunNodes(graph: {
  nodes: readonly LabeledWorkflowCanvasNodeLike[];
}): Array<WorkflowRunNodeInput & { label: string }>;
export function graphToRunNodes(graph: {
  nodes: readonly WorkflowCanvasNodeLike[];
}): WorkflowRunNodeInput[];
export function graphToRunNodes(graph: {
  nodes: readonly WorkflowCanvasNodeLike[];
}): WorkflowRunNodeInput[] {
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    kind: node.data.kind,
    label: node.data.label,
    config: node.data.config,
  }));
  return migrateLegacyGraphNodes(nodes) as WorkflowRunNodeInput[];
}

/** Fill editor defaults before comparing a legacy snapshot with the hydrated draft. */
export function effectiveNodeConfig(
  kind: NodeKind,
  config: Record<string, unknown> = {},
): Record<string, unknown> {
  const normalized = { ...defaultNodeConfig[kind], ...config };
  if (kind === "start" && !Object.hasOwn(config, "runVariables")) delete normalized.runVariables;
  if (
    kind === "rag" &&
    !Array.isArray(config.sources) &&
    typeof config.knowledgeBase === "string"
  ) {
    normalized.sources = config.knowledgeBase.trim() ? [config.knowledgeBase.trim()] : [];
    delete normalized.knowledgeBase;
  }
  if (kind === "mcp") {
    if (!normalized.serviceSlug && typeof config.service === "string")
      normalized.serviceSlug = config.service;
    if (!normalized.toolName && typeof config.tool === "string") normalized.toolName = config.tool;
    delete normalized.service;
    delete normalized.tool;
  }
  if (
    kind === "llm" &&
    !Object.hasOwn(config, "systemPrompt") &&
    typeof config.prompt === "string" &&
    config.prompt
  ) {
    normalized.systemPrompt = config.prompt;
    normalized.prompt = "";
  }
  if (kind === "input" && !Array.isArray(config.inputs)) {
    const variable =
      typeof config.variable === "string" && config.variable ? config.variable : "query";
    normalized.inputs = [
      { name: variable, source: { type: "run", variable }, required: config.required !== false },
    ];
    if (!Array.isArray(config.outputs) || config.outputs.length === 0)
      normalized.outputs = [{ name: variable, selector: `$inputs.${variable}` }];
  }
  return normalized;
}

export const workflowNodeDataSchema = z
  .object({
    id: z.string().optional(),
    kind: nodeKindSchema,
    label: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(["idle", "running", "success", "error"]).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((data, context) => {
    const parsed = nodeConfigSchemas[data.kind].safeParse(data.config ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.addIssue({
          code: "custom",
          path: ["config", ...issue.path],
          message: issue.message,
        });
    }
  });

export const workflowGraphSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    nodes: z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          type: z.string().optional(),
          position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
          data: workflowNodeDataSchema,
        }),
      )
      .max(500),
    edges: z
      .array(
        z.object({
          id: z.string().min(1).optional(),
          source: z.string().min(1),
          target: z.string().min(1),
          label: z.enum(["true", "false"]).optional(),
          branchId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,200}$/)
            .optional(),
        }),
      )
      .max(2000),
  })
  .superRefine((graph, context) => {
    const ids = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (ids.has(node.id))
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: `duplicate node id ${node.id}`,
        });
      if (node.data.id !== undefined && node.data.id !== node.id)
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "data", "id"],
          message: "node.data.id must match node.id",
        });
      ids.add(node.id);
    }
    const edgeIds = new Set<string>();
    for (const [index, edge] of graph.edges.entries()) {
      if (!ids.has(edge.source) || !ids.has(edge.target))
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "edge references an unknown node",
        });
      if (edge.id && edgeIds.has(edge.id))
        context.addIssue({
          code: "custom",
          path: ["edges", index, "id"],
          message: "duplicate edge id",
        });
      if (edge.id) edgeIds.add(edge.id);
    }
  });

export const workflowFileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.literal(1),
  exportedAt: z.string().optional(),
  graph: workflowGraphSchema,
  runVariables: z.array(runVariableSchema),
});
