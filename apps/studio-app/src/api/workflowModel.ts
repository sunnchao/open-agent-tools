// RN 版工作流纯逻辑：与 Web 版 model.ts/graph.ts/variables.ts 同语义，去除 @xyflow/react 强依赖。
import {
  conditionRouteIssues,
  effectiveNodeConfig,
  isLegacyGraphNode,
  isVisualCondition,
  migrateLegacyGraphNode,
  runVariables,
  variableIssues,
  resultFields,
  templateFields,
  conditionCases,
  conditionReference,
  referenceRoot,
  type ConditionCase,
  type NodeKind,
  type RunVariable,
  type VariableIssue,
} from "@open-agent-tools/workflow-contracts";
import type { WorkflowEdge, WorkflowNode, WorkflowSnapshot } from "./workflow";
import type { ResourceCatalog } from "./misc";

export type { NodeKind };
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
export interface WorkflowValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  suggestions?: string[];
  reference?: string;
  field?: string;
}
export interface WorkflowGraphNode {
  id: string;
  data: {
    id?: string;
    kind: NodeKind;
    label: string;
    description?: string;
    config: Record<string, WorkflowConfigValue>;
  };
}
export interface WorkflowGraphEdge {
  source: string;
  target: string;
  label?: unknown;
  branchId?: string;
}
export interface VariableOption {
  value: string;
  label: string;
  group: string;
}
export interface PaletteItem {
  kind: NodeKind;
  label: string;
  description: string;
  group: "输入" | "知识与模型" | "工具与逻辑" | "输出";
}
export {
  conditionCases,
  conditionReference,
  referenceRoot,
  runVariables,
  templateFields,
  resultFields,
};
export type { ConditionCase, RunVariable, VariableIssue };

export const palette: PaletteItem[] = [
  { kind: "start", label: "开始", description: "工作流入口", group: "输入" },
  { kind: "input", label: "用户输入", description: "定义输入变量", group: "输入" },
  {
    kind: "rag",
    label: "知识检索",
    description: "向量+关键词+图谱多路召回",
    group: "知识与模型",
  },
  { kind: "sql", label: "SQL 问数", description: "自然语言查询数据库", group: "工具与逻辑" },
  { kind: "llm", label: "LLM", description: "生成或理解文本", group: "知识与模型" },
  { kind: "mcp", label: "MCP Tool", description: "调用 MCP 工具", group: "工具与逻辑" },
  { kind: "http", label: "HTTP 请求", description: "调用外部 API", group: "工具与逻辑" },
  {
    kind: "condition",
    label: "条件分支",
    description: "按 IF / ELIF / ELSE 条件分流",
    group: "工具与逻辑",
  },
  { kind: "end", label: "结束", description: "定义最终输出", group: "输出" },
];
export const NODE_KINDS: NodeKind[] = [
  "start",
  "input",
  "rag",
  "sql",
  "llm",
  "mcp",
  "http",
  "condition",
  "end",
];

export function defaultConfig(kind: NodeKind): Record<string, WorkflowConfigValue> {
  return { ...(effectiveNodeConfig(kind) as Record<string, WorkflowConfigValue>) };
}

function validInputs(value: unknown): NodeInputBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is NodeInputBinding =>
      !!item &&
      typeof item === "object" &&
      typeof (item as Partial<NodeInputBinding>).name === "string" &&
      Boolean((item as Partial<NodeInputBinding>).source),
  );
}
function validOutputs(value: unknown): NodeOutputBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is NodeOutputBinding =>
      !!item &&
      typeof item === "object" &&
      typeof (item as Partial<NodeOutputBinding>).name === "string" &&
      typeof (item as Partial<NodeOutputBinding>).selector === "string",
  );
}
export function nodeInputs(data: { config: Record<string, unknown> }): NodeInputBinding[] {
  return validInputs(data.config.inputs);
}
export function nodeOutputs(data: { config: Record<string, unknown> }): NodeOutputBinding[] {
  return validOutputs(data.config.outputs);
}

export function migrateNodeData(
  data: {
    id?: string;
    kind: NodeKind | "graph";
    label?: string;
    description?: string;
    config?: Record<string, unknown>;
  },
  nodeId?: string,
): {
  id: string;
  kind: NodeKind;
  label: string;
  description: string;
  status: NodeRunStatus;
  config: Record<string, WorkflowConfigValue>;
} {
  // 旧版独立「图谱检索」节点已并入知识检索（rag + config.graph），读取历史草稿时先迁移。
  const migrated = isLegacyGraphNode(data)
    ? migrateLegacyGraphNode({
        id: data.id,
        kind: data.kind,
        label: data.label,
        description: data.description,
        config: data.config,
      })
    : data;
  const kind = migrated.kind as NodeKind;
  const raw = (migrated.config ?? {}) as Record<string, unknown>;
  const config = {
    ...defaultConfig(kind),
    ...(raw as Record<string, WorkflowConfigValue>),
  } as Record<string, WorkflowConfigValue>;
  if (kind === "mcp") {
    if (!config.serviceSlug && typeof raw.service === "string") config.serviceSlug = raw.service;
    if (!config.toolName && typeof raw.tool === "string") config.toolName = raw.tool;
    delete config.service;
    delete config.tool;
  }
  return {
    id: typeof migrated.id === "string" && migrated.id ? migrated.id : (nodeId ?? ""),
    kind,
    label: migrated.label ?? palette.find((p) => p.kind === kind)?.label ?? kind,
    description: migrated.description ?? "",
    status: "idle",
    config,
  };
}

export function validateNodeResources(
  data: { kind: NodeKind; config: Record<string, unknown>; label?: string },
  catalog: ResourceCatalog | null,
): string | null {
  const label = typeof data.label === "string" ? data.label : data.kind;
  void label;
  if (data.kind === "sql") {
    if (!String(data.config.query ?? "").trim()) return "请配置 SQL 问数问题";
    if (!catalog) return "资源目录尚未加载，无法校验 SQL 数据源";
    if (catalog.sql?.error) return `SQL 数据源加载失败：${catalog.sql.error}`;
    const sourceId = String(data.config.sourceId ?? "").trim();
    const source = sourceId
      ? catalog.sql?.sources.find((i) => i.id === sourceId)
      : catalog.sql?.sources.find((i) => i.isDefault);
    if (!source)
      return sourceId
        ? `SQL 数据源已失效或停用：${sourceId}`
        : "暂无默认 SQL 数据源，请选择数据源或在设置中配置";
  }
  if (data.kind === "rag") {
    const sources = Array.isArray(data.config.sources) ? data.config.sources : [];
    if (sources.length === 0) return "至少挂载一个 RAG 文档";
    if (!catalog) return "资源目录尚未加载，无法校验 RAG 文档";
    const available = new Set(catalog.rag.sources.map((s) => s.source));
    const missing = (sources as unknown[]).find((s) => typeof s === "string" && !available.has(s));
    if (missing) return `RAG 文档已失效：${String(missing)}`;
  }
  if (data.kind === "mcp") {
    const serviceSlug = String(data.config.serviceSlug ?? "");
    const toolName = String(data.config.toolName ?? "");
    if (!serviceSlug || !toolName) return "请选择 MCP 服务和 Tool";
    if (!catalog) return "资源目录尚未加载，无法校验 MCP Tool";
    const service = catalog.mcp.services.find((i) => i.serviceSlug === serviceSlug);
    if (!service?.tools.some((t) => t.name === toolName))
      return `MCP Tool 已失效：${serviceSlug}/${toolName}`;
    try {
      const parsed = JSON.parse(String(data.config.arguments ?? "{}")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return "MCP 参数映射必须是 JSON 对象";
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
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, [] as WorkflowGraphEdge[]]));
  const outgoing = new Map(nodes.map((n) => [n.id, [] as WorkflowGraphEdge[]]));
  const starts = nodes.filter((n) => n.data.kind === "start");
  const ends = nodes.filter((n) => n.data.kind === "end");
  if (nodes.length === 0) issues.push({ code: "empty", message: "工作流至少需要一个节点" });
  if (starts.length !== 1)
    issues.push({
      code: "start-count",
      message: starts.length === 0 ? "工作流需要一个开始节点" : "工作流只能有一个开始节点",
      ...(starts[1] ? { nodeId: starts[1].id } : {}),
    });
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
    if (node.data.kind === "start" && nodeIncoming.length > 0)
      issues.push({ code: "start-incoming", message: "开始节点不能有上游连接", nodeId: node.id });
    if (node.data.kind !== "start" && nodeIncoming.length === 0)
      issues.push({
        code: "missing-incoming",
        message: `${node.data.label} 缺少上游连接`,
        nodeId: node.id,
      });
    if (node.data.kind === "end" && nodeOutgoing.length > 0)
      issues.push({ code: "end-outgoing", message: "结束节点不能连接下游节点", nodeId: node.id });
    if (node.data.kind !== "end" && nodeOutgoing.length === 0)
      issues.push({
        code: "missing-outgoing",
        message: `${node.data.label} 缺少下游连接`,
        nodeId: node.id,
      });
    const rawInputs = Array.isArray(node.data.config.inputs)
      ? (node.data.config.inputs as NodeInputBinding[])
      : [];
    const rawOutputs = Array.isArray(node.data.config.outputs)
      ? (node.data.config.outputs as NodeOutputBinding[])
      : [];
    const inputNames = new Set<string>();
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
      if (inputNames.has(name))
        issues.push({
          code: "input-duplicate",
          message: `${node.data.label} 的输入 ${name} 重复`,
          nodeId: node.id,
        });
      inputNames.add(name);
      if (input.source?.type === "node") {
        const src = input.source as { type: "node"; nodeId: string; output: string };
        const direct = nodeIncoming.some((e) => e.source === src.nodeId);
        const sourceNode = byId.get(src.nodeId);
        const declared =
          sourceNode && nodeOutputs(sourceNode.data).some((o) => o.name === src.output);
        if (!direct || !declared)
          issues.push({
            code: "node-output",
            message: `${node.data.label} 引用了无效输出 ${src.nodeId}.${src.output}`,
            nodeId: node.id,
          });
      }
    }
    const outputNames = new Set<string>();
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
      if (outputNames.has(name))
        issues.push({
          code: "output-duplicate",
          message: `${node.data.label} 的输出 ${name} 重复`,
          nodeId: node.id,
        });
      outputNames.add(name);
      if (!/^\$(result|inputs)(\.[A-Za-z_$][\w$]*)*$/.test(selector))
        issues.push({
          code: "output-selector",
          message: `${node.data.label} 的输出选择器 ${selector || "为空"} 无效`,
          nodeId: node.id,
        });
    }
    if (node.data.kind === "end" && rawOutputs.length === 0)
      issues.push({
        code: "end-output",
        message: `${node.data.label} 尚未配置最终输出`,
        nodeId: node.id,
      });
    if (
      node.data.kind === "llm" &&
      rawInputs.length === 0 &&
      !String(node.data.config.prompt ?? "").trim()
    )
      issues.push({
        code: "llm-prompt",
        message: `${node.data.label} 需要输入变量或用户提示词`,
        nodeId: node.id,
      });
    if (node.data.kind === "condition" && isVisualCondition(node.data.config)) {
      issues.push(
        ...conditionRouteIssues(node.data.config, nodeOutgoing).map((i) => ({
          ...i,
          nodeId: node.id,
        })),
      );
    }
    const resourceError = validateNodeResources(
      { kind: node.data.kind, config: node.data.config, label: node.data.label },
      catalog,
    );
    if (resourceError) issues.push({ code: "resource", message: resourceError, nodeId: node.id });
  }
  // 环检测
  const degrees = new Map(nodes.map((n) => [n.id, incoming.get(n.id)?.length ?? 0]));
  const queue = nodes.filter((n) => degrees.get(n.id) === 0).map((n) => n.id);
  let visited = 0;
  for (let i = 0; i < queue.length; i += 1) {
    visited += 1;
    for (const e of outgoing.get(queue[i]!) ?? []) {
      const next = (degrees.get(e.target) ?? 1) - 1;
      degrees.set(e.target, next);
      if (next === 0) queue.push(e.target);
    }
  }
  if (visited !== nodes.length) issues.push({ code: "cycle", message: "工作流中存在循环连接" });
  issues.push(
    ...variableIssues(nodes.map((n) => ({ id: n.id, kind: n.data.kind, config: n.data.config }))),
  );
  return issues;
}

// ---- 图：移动端用“列表 + 连接”表达，不依赖画布 ----
export function createNode(
  id: string,
  kind: NodeKind,
  config?: Record<string, WorkflowConfigValue>,
): WorkflowNode {
  const def = palette.find((p) => p.kind === kind)!;
  return {
    id,
    type: "studio",
    data: {
      id,
      kind,
      label: def.label,
      description: def.description,
      status: "idle",
      config:
        kind === "condition" && config !== undefined
          ? (effectiveNodeConfig(kind, config as Record<string, unknown>) as Record<
              string,
              unknown
            >)
          : { ...defaultConfig(kind), ...config },
    },
  };
}
export function createEdge(
  source: string,
  target: string,
  extra?: { branchId?: string; label?: unknown },
): WorkflowEdge {
  return {
    id: `edge-${source}-${target}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source,
    target,
    type: "studio",
    ...(extra?.branchId ? { branchId: extra.branchId } : {}),
    ...(extra?.label !== undefined ? { label: extra.label } : {}),
  } as WorkflowEdge;
}
export function hydrateWorkflowSnapshot(saved: WorkflowSnapshot): WorkflowSnapshot {
  let nodes = saved.nodes.map((n) => ({
    ...n,
    data: migrateNodeData(
      {
        ...(n.data as {
          id?: string;
          kind: NodeKind;
          label?: string;
          description?: string;
          config?: Record<string, unknown>;
        }),
      },
      n.id,
    ) as unknown as WorkflowNode["data"],
  }));
  const withDecl = nodes.some(
    (n) =>
      (n.data as { kind?: string }).kind === "start" &&
      Object.hasOwn((n.data as { config?: object }).config ?? {}, "runVariables"),
  );
  if (!withDecl) {
    const variables = runVariables(
      nodes.map((n) => ({
        id: n.id,
        kind: String((n.data as { kind?: string }).kind ?? ""),
        config: (n.data as { config?: Record<string, unknown> }).config ?? {},
      })),
    );
    nodes = nodes.map((n) =>
      (n.data as { kind?: string }).kind === "start"
        ? {
            ...n,
            data: {
              ...(n.data as unknown as Record<string, unknown>),
              config: {
                ...(((n.data as unknown as { config?: Record<string, unknown> }).config ??
                  {}) as Record<string, unknown>),
                runVariables: variables,
              },
            } as unknown as WorkflowNode["data"],
          }
        : n,
    );
  }
  return { ...saved, nodes, edges: saved.edges };
}
export function snapshotGraph(
  name: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowSnapshot {
  return {
    name,
    nodes: nodes.map((n) => ({
      id: n.id,
      ...(n.type ? { type: n.type } : {}),
      ...((n as { position?: unknown }).position
        ? { position: (n as { position: { x: number; y: number } }).position }
        : {}),
      data: { ...(n.data as object) },
    })) as WorkflowNode[],
    edges: edges.map((e) => ({ ...e })),
  };
}

// ---- 变量选项/修复（移动端 NodeInspector 复用）----
export type VarNode = {
  id: string;
  data: { kind: string; label?: string; config: Record<string, unknown> };
};
export const sourceKey = (source: InputSource): string =>
  JSON.stringify(
    source.type === "literal"
      ? { type: "literal", value: "" }
      : source.type === "run"
        ? { type: "run", variable: source.variable }
        : { type: "node", nodeId: source.nodeId, output: source.output },
  );
export function inputOptions(
  node: VarNode,
  nodes: VarNode[],
  edges: { source: string; target: string }[],
): VariableOption[] {
  const predecessors = new Set(edges.filter((e) => e.target === node.id).map((e) => e.source));
  return [
    ...runVariables(nodes.map((n) => ({ id: n.id, kind: n.data.kind, config: n.data.config }))).map(
      (v) => ({
        value: sourceKey({ type: "run", variable: v.name }),
        label: `${v.name} · ${v.type}`,
        group: "运行输入",
      }),
    ),
    ...nodes
      .filter((i) => predecessors.has(i.id))
      .flatMap((i) =>
        nodeOutputs(i.data).map((o) => ({
          value: sourceKey({ type: "node", nodeId: i.id, output: o.name }),
          label: `${o.name} · ${i.data.label ?? i.id}`,
          group: `前置节点 · ${i.data.label ?? i.id}`,
        })),
      ),
    { value: sourceKey({ type: "literal", value: "" }), label: "固定值", group: "其他" },
  ];
}
export function outputOptions(node: VarNode, sample?: unknown): VariableOption[] {
  const options: VariableOption[] = [
    { value: "$result", label: "完整结果 · $result", group: "节点结果" },
    { value: "$inputs", label: "全部输入 · $inputs", group: "本节点输入" },
    ...nodeInputs(node.data).map((i) => ({
      value: `$inputs.${i.name}`,
      label: i.name,
      group: "本节点输入",
    })),
    ...Object.entries(resultFields(node.data.kind) ?? {}).map(([k, t]) => ({
      value: `$result.${k}`,
      label: `${k} · ${String(t)}`,
      group: "结果字段",
    })),
  ];
  const seen = new Set(options.map((o) => o.value));
  function visit(value: unknown, path: string, depth: number) {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return;
    for (const [k, child] of Object.entries(value)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(k) || ["__proto__", "constructor", "prototype"].includes(k))
        continue;
      const selector = `${path}.${k}`;
      if (!seen.has(selector)) {
        options.push({
          value: selector,
          label: `${selector}`,
          group: "上次测试的样例字段（可能缺省）",
        });
        seen.add(selector);
      }
      visit(child, selector, depth + 1);
    }
  }
  visit(sample, "$result", 0);
  return options;
}
const templateToken = /\{\{\s*([^{}]*?)\s*\}\}/g;
export function replaceTemplateReference(
  value: string,
  before: string,
  after: string,
  json = false,
): string {
  if (!before || !after || before === after) return value;
  if (!json)
    return value.replace(templateToken, (m, name: string) =>
      name.trim() === before ? `{{${after}}}` : m,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  let changed = false;
  const replace = (item: unknown): unknown => {
    if (typeof item === "string")
      return item.replace(templateToken, (m, name: string) => {
        if (name.trim() !== before) return m;
        changed = true;
        return `{{${after}}}`;
      });
    if (Array.isArray(item)) return item.map(replace);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([k, c]) => [k, replace(c)]));
    return item;
  };
  const replaced = replace(parsed);
  return changed ? JSON.stringify(replaced, null, 2) : value;
}
export function repairVariableReference(
  nodes: WorkflowNode[],
  issue: VariableIssue,
  replacement: string,
): WorkflowNode[] {
  if (!replacement || replacement === issue.reference) return nodes;
  const target = nodes.find((n) => n.id === issue.nodeId);
  if (!target || typeof issue.reference !== "string") return nodes;
  if (issue.code === "condition-reference") {
    return nodes.map((n) =>
      n.id !== target.id
        ? n
        : {
            ...n,
            data: {
              ...(n.data as unknown as Record<string, unknown>),
              config: {
                ...(((n.data as unknown as { config?: Record<string, unknown> }).config ??
                  {}) as Record<string, unknown>),
                cases: conditionCases(
                  (n.data as unknown as { config?: Record<string, unknown> }).config ?? {},
                ).map((item: ConditionCase) => ({
                  ...item,
                  rules: item.rules.map((r) =>
                    conditionReference(r.variable) === issue.reference
                      ? { ...r, variable: replacement }
                      : r,
                  ),
                })),
              },
            } as unknown as WorkflowNode["data"],
          },
    );
  }
  return nodes;
}
