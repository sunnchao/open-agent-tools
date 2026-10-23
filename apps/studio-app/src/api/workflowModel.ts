import type {
  InputSource,
  NodeInputBinding,
  NodeOutputBinding,
  WorkflowValidationIssue,
  WorkflowGraphEdge,
  VariableOption,
} from "@open-agent-tools/workflow-contracts";
export type {
  InputSource,
  NodeInputBinding,
  NodeOutputBinding,
  WorkflowValidationIssue,
  WorkflowGraphEdge,
  VariableOption,
};
import {
  migrateNodeData as sharedMigrateNodeData,
  nodeInputs,
  nodeOutputs,
  validateNodeResources as sharedValidateNodeResources,
  validateWorkflowGraph as sharedValidateWorkflowGraph,
  sourceKey,
  inputOptions,
  outputOptions as sharedOutputOptions,
  replaceTemplateReference,
  repairVariableReference as sharedRepairVariableReference,
  type MigratableNodeData,
} from "@open-agent-tools/workflow-contracts";
export { nodeInputs, nodeOutputs, sourceKey, inputOptions, replaceTemplateReference };
// RN 版工作流纯逻辑：与 Web 版 model.ts/graph.ts/variables.ts 同语义，去除 @xyflow/react 强依赖。
import {
  effectiveNodeConfig,
  runVariables,
  resultFields,
  templateFields,
  conditionCases,
  conditionReference,
  referenceRoot,
  variableNodes,
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
  const migrated = sharedMigrateNodeData(data as MigratableNodeData, nodeId, {
    normalizeConfig: false,
  });
  return {
    id: migrated.id,
    kind: migrated.kind,
    label: migrated.label ?? palette.find((p) => p.kind === migrated.kind)?.label ?? migrated.kind,
    description: migrated.description ?? "",
    status: "idle",
    config: migrated.config,
  };
}

export function validateNodeResources(
  data: { kind: NodeKind; config: Record<string, unknown>; label?: string },
  catalog: ResourceCatalog | null,
): string | null {
  return sharedValidateNodeResources(data, catalog, false);
}

export function validateWorkflowGraph(
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraphEdge[],
  catalog: ResourceCatalog | null,
): WorkflowValidationIssue[] {
  return sharedValidateWorkflowGraph(nodes, edges, catalog, { strict: false });
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
    const variables = runVariables(variableNodes(nodes));
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

export function outputOptions(node: VarNode, sample?: unknown): VariableOption[] {
  return sharedOutputOptions(node, sample, (selector) => selector);
}

export function repairVariableReference(
  nodes: WorkflowNode[],
  issue: VariableIssue,
  replacement: string,
): WorkflowNode[] {
  return sharedRepairVariableReference(nodes, issue, replacement, {
    conditionOnly: true,
    requireConditionBinding: false,
  });
}
