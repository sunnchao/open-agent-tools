// RN 版工作流周边纯函数：与 Web 版 nodeTest/runEdges/runHistory/runOutput/clipboard/io 同语义，去除 DOM/xyflow 强依赖。
import {
  migrateLegacyGraphNode,
  nodeConfigSchemas,
  portableHttpConfig,
  runVariables,
  workflowFileSchema,
  workflowGraphSchema,
  type LegacyGraphNodeLike,
} from "@open-agent-tools/workflow-contracts";
import { createEdge, createNode, nodeInputs, nodeOutputs, snapshotGraph } from "./workflowModel";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowRunHistory,
  WorkflowSnapshot,
} from "./workflow";

// ---- nodeTest ----
export function serializeNodeTestValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
export function parseNodeTestValue(value: string): unknown {
  const t = value.trim();
  if (!t) return "";
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return value;
  }
}
export function createNodeTestInputDraft(
  data: { config: Record<string, unknown> },
  runOutputs: Record<string, Record<string, unknown>> | null,
  runInputs: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    nodeInputs(data).map((b) => {
      const s = b.source;
      const v =
        s.type === "literal"
          ? s.value
          : s.type === "run"
            ? runInputs[s.variable]
            : runOutputs?.[s.nodeId]?.[s.output];
      return [b.name, serializeNodeTestValue(v)];
    }),
  );
}
export function formatNodeTestDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(3)}s`;
}
export function formatWorkflowRunOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    const f = JSON.stringify(value, null, 2);
    return f === undefined ? String(value) : f;
  } catch {
    return String(value);
  }
}

// ---- runEdges ----
export type EdgeRunStatus = "active" | "done" | "error";
export type EdgeRunStates = Record<string, EdgeRunStatus>;
export function updateRunEdges(
  current: EdgeRunStates,
  incomingEdgeIds: string[],
  status: EdgeRunStatus,
): EdgeRunStates {
  const next = { ...current };
  for (const id of incomingEdgeIds) next[id] = status;
  return next;
}

// ---- runHistory 回放 ----
export interface RunLogEntry {
  id: string;
  label: string;
  kind?: string;
  status: "success" | "error";
  detail?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
}
export function replayWorkflowRun(history: WorkflowRunHistory): {
  log: RunLogEntry[];
  outputs: Record<string, unknown> | null;
  nodeOutputs: Record<string, Record<string, unknown>>;
} {
  const graphNodes = new Map(history.graph.nodes.map((n) => [n.id, n]));
  const starts = new Map<string, { label: string; kind?: string }>();
  const outputs: Record<string, Record<string, unknown>> = {};
  const log: RunLogEntry[] = [];
  const seen = new Set<number>();
  for (const event of [...history.events].sort((a, b) => a.sequence - b.sequence)) {
    if (seen.has(event.sequence)) continue;
    seen.add(event.sequence);
    const data = event.payload as Record<string, unknown>;
    const nodeId = typeof data.node_id === "string" ? data.node_id : null;
    if (event.type === "node_started" && nodeId)
      starts.set(nodeId, {
        label: typeof data.title === "string" ? data.title : nodeId,
        kind: typeof data.node_type === "string" ? data.node_type : undefined,
      });
    if (event.type !== "node_finished" || !nodeId) continue;
    const node = graphNodes.get(nodeId);
    const started = starts.get(nodeId);
    const meta = data as {
      inputs?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
      result?: unknown;
      error?: unknown;
      metadata?: { durationMs?: number };
    };
    log.push({
      id: nodeId,
      label:
        started?.label ?? String((node?.data as { label?: string } | undefined)?.label ?? nodeId),
      kind: started?.kind ?? String((node?.data as { kind?: string } | undefined)?.kind ?? ""),
      status: data.status === "success" ? "success" : "error",
      detail: typeof data.error === "string" ? data.error : undefined,
      inputs: meta.inputs,
      outputs: meta.outputs,
      result: meta.result,
      durationMs: meta.metadata?.durationMs,
    });
    if (meta.outputs)
      Object.defineProperty(outputs, nodeId, { value: meta.outputs, enumerable: true });
  }
  if (history.run.error && !log.some((i) => i.detail === history.run.error))
    log.push({
      id: `run-${history.run.id}`,
      label: "Workflow",
      status: "error",
      detail: history.run.error,
    });
  return { log, outputs: history.run.outputs, nodeOutputs: outputs };
}

// ---- 连接合法性（含环检测） ----
export function canConnectTarget(
  source: string,
  target: string,
  nodes: Array<{ id: string; data?: { kind?: string } }>,
  edges: Array<{ source: string; target: string }>,
): boolean {
  if (source === target || nodes.find((n) => n.id === target)?.data?.kind === "start") return false;
  if (!nodes.some((n) => n.id === source) || !nodes.some((n) => n.id === target)) return false;
  const queue = [target];
  const visited = new Set<string>();
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    if (id === source) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of edges) if (e.source === id) queue.push(e.target);
  }
  return true;
}

// ---- 导出/导入（去凭据，与 Web io.ts 同策略简化版） ----
export const workflowFileSizeLimit = 2 * 1024 * 1024;

/**
 * 兼容旧文件：独立「图谱检索」节点已并入知识检索，旧导出文件里仍可能是 kind:"graph"。
 * 在 schema 校验前先把这些节点迁移成 rag，否则 workflowGraphSchema 会直接拒绝整个文件。
 *
 * 注意：导入文件/剪贴板用的是画布节点结构（kind 位于 node.data.kind），
 * 需逐个迁移 data；migrateLegacyGraphNode 对非 graph 节点会原样返回。
 */
function migrateLegacyGraphPayload<T>(graph: T): T {
  if (!graph || typeof graph !== "object") return graph;
  const record = graph as { nodes?: unknown };
  if (!Array.isArray(record.nodes)) return graph;
  const nodes = record.nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const data = (node as { data?: unknown }).data;
    if (!data || typeof data !== "object") return node;
    return {
      ...(node as object),
      data: migrateLegacyGraphNode(data as LegacyGraphNodeLike),
    };
  });
  return { ...(graph as object), nodes } as T;
}
const secretField =
  /(api[-_]?key|authorization|password|client[-_]?secret|provider[-_]?key|(^|[_-])(access|refresh|bearer)[-_]?token|(^|[_-])secret($|[_-]))/i;
function assertNoCredentials(value: unknown, path = "file"): void {
  if (Array.isArray(value)) value.forEach((item, i) => assertNoCredentials(item, `${path}.${i}`));
  else if (value && typeof value === "object") {
    for (const [k, item] of Object.entries(value)) {
      if (secretField.test(k)) throw new Error(`${path}.${k} 包含凭据字段，请移除后再导入或导出`);
      assertNoCredentials(item, `${path}.${k}`);
    }
  }
}
export function serializeWorkflow(
  snapshot: WorkflowSnapshot,
  exportedAt = new Date().toISOString(),
): string {
  const graph = workflowGraphSchema.parse(
    snapshotGraph(snapshot.name, snapshot.nodes, snapshot.edges),
  );
  const value = {
    name: graph.name,
    version: 1,
    exportedAt,
    graph,
    runVariables: runVariables(
      graph.nodes.map((n) => ({
        id: n.id,
        kind: String((n.data as { kind?: string }).kind ?? ""),
        config: (n.data as { config?: Record<string, unknown> }).config ?? {},
      })),
    ),
  };
  const json = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(json).length > workflowFileSizeLimit)
    throw new Error("工作流文件超过 2 MB");
  assertNoCredentials(value.runVariables);
  return json;
}
export function parseWorkflowFile(text: string): WorkflowSnapshot {
  if (new TextEncoder().encode(text).length > workflowFileSizeLimit)
    throw new Error("工作流文件超过 2 MB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("文件不是合法 JSON");
  }
  // 旧导出文件可能含已废弃的 graph 节点，先迁移再走 schema 校验。
  if (value && typeof value === "object" && "graph" in value) {
    const file = value as { graph?: unknown };
    value = { ...(value as object), graph: migrateLegacyGraphPayload(file.graph) };
  }
  const parsed = workflowFileSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
  assertNoCredentials(parsed.data.runVariables);
  const nodes = parsed.data.graph.nodes.map((n, index) => {
    const created = createNode(
      n.id,
      n.data.kind as unknown as Parameters<typeof createNode>[1],
      (n.data.kind === "http"
        ? portableHttpConfig(nodeConfigSchemas.http.parse(n.data.config ?? {}))
        : n.data.config) as Record<string, unknown>,
    );
    void index;
    (created.data as { label?: string }).label =
      (n.data.label as string | undefined) ?? (created.data as { label?: string }).label;
    return created;
  });
  const edges: WorkflowEdge[] = parsed.data.graph.edges.map((e) => ({
    ...createEdge(e.source, e.target),
    ...(e.id ? { id: e.id } : {}),
    ...(e.label ? { label: e.label } : {}),
    ...(e.branchId ? { branchId: e.branchId } : {}),
  }));
  return { name: parsed.data.name, nodes, edges };
}

// ---- 子图剪贴板（移动端：复制选中节点 JSON 文本） ----
const clipboardFormat = "open-agent-tools/workflow-selection";
export function serializeSelection(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  ids: Set<string>,
): string {
  const selected = nodes.filter((n) => ids.has(n.id));
  if (!selected.length) throw new Error("请先选择节点");
  if (selected.some((n) => String((n.data as { kind?: string }).kind) === "start"))
    throw new Error("开始节点不能复制，请取消选择开始节点");
  const graph = snapshotGraph(
    "selection",
    selected,
    edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  );
  const portable = JSON.parse(serializeWorkflow(graph)) as { graph: unknown };
  return JSON.stringify({ format: clipboardFormat, version: 1, graph: portable.graph });
}
export function parseSelection(text: string): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  if (new TextEncoder().encode(text).length > workflowFileSizeLimit)
    throw new Error("剪贴板工作流超过 2 MB");
  let value: { format?: string; version?: number; graph?: unknown };
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("剪贴板不是工作流 JSON");
  }
  if (!value || value.format !== clipboardFormat || value.version !== 1)
    throw new Error("剪贴板不含支持的工作流节点");
  // 旧剪贴板内容同样可能含 graph 节点，迁移后再校验。
  const parsed = workflowGraphSchema.safeParse(migrateLegacyGraphPayload(value.graph));
  if (!parsed.success) throw new Error(`剪贴板节点格式无效：${parsed.error.issues[0]?.message}`);
  if (!parsed.data.nodes.length) throw new Error("剪贴板未包含任何节点");
  const nodes = parsed.data.nodes.map((n, index) => {
    void index;
    const created = createNode(
      n.id,
      n.data.kind as unknown as Parameters<typeof createNode>[1],
      n.data.config as Record<string, unknown>,
    );
    (created.data as { label?: string }).label =
      (n.data.label as string | undefined) ?? (created.data as { label?: string }).label;
    return created;
  });
  const edges = parsed.data.edges.map((e) => ({
    ...createEdge(e.source, e.target),
    ...(e.label ? { label: e.label } : {}),
    ...(e.branchId ? { branchId: e.branchId } : {}),
  }));
  return { nodes, edges };
}
export function cloneSubgraph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  selectedIds: Set<string>,
  idFactory: () => string = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const selected = nodes.filter((n) => selectedIds.has(n.id));
  if (selected.some((n) => String((n.data as { kind?: string }).kind) === "start"))
    throw new Error("开始节点不能复制，请取消选择开始节点");
  const ids = new Map(
    selected.map((n) => [n.id, `${String((n.data as { kind?: string }).kind)}-${idFactory()}`]),
  );
  const copies = selected.map((n) => {
    const id = ids.get(n.id)!;
    const config = {
      ...(((n.data as { config?: Record<string, unknown> }).config ?? {}) as Record<
        string,
        unknown
      >),
    };
    if (Array.isArray(config.inputs))
      config.inputs = (config.inputs as Array<{ source?: { type?: string; nodeId?: string } }>).map(
        (input) =>
          input.source?.type === "node" && input.source.nodeId
            ? {
                ...input,
                source: {
                  ...input.source,
                  nodeId: ids.get(input.source.nodeId) ?? input.source.nodeId,
                },
              }
            : input,
      );
    return {
      ...n,
      id,
      data: { ...((n.data as object) ?? {}), id, status: "idle", config } as WorkflowNode["data"],
    };
  });
  const links = edges
    .filter((e) => ids.has(e.target) && ids.has(e.source))
    .map((e) => ({
      ...createEdge(ids.get(e.source)!, ids.get(e.target)!),
      ...(e.branchId ? { branchId: e.branchId } : {}),
    }));
  return { nodes: copies, edges: links };
}
export function assertSelectionSources(nodes: WorkflowNode[], existingNodes: WorkflowNode[]): void {
  const available = new Map([...existingNodes, ...nodes].map((n) => [n.id, n]));
  for (const node of nodes) {
    for (const input of nodeInputs({
      config: ((node.data as { config?: Record<string, unknown> }).config ?? {}) as Record<
        string,
        unknown
      >,
    })) {
      if (input.source.type !== "node") continue;
      const source = available.get(input.source.nodeId);
      if (
        !source ||
        !nodeOutputs({
          config: ((source.data as { config?: Record<string, unknown> }).config ?? {}) as Record<
            string,
            unknown
          >,
        }).some((o) => o.name === (input.source as { output: string }).output)
      )
        throw new Error("剪贴板引用的上游节点在当前工作流中不存在，请同时复制该来源节点后重试");
    }
  }
}

// ---- MCP 授权能力（与 Web grantCapabilities 同语义） ----
export function grantCapabilities(
  service: { currentVersionId: string | null },
  versions: Array<{
    id: string;
    status: string;
    versionNumber: number;
    tools: unknown[];
    prompts: unknown[];
  }>,
): { versionNumber: number | null; toolCount: number; promptCount: number } {
  const current = versions.find(
    (v) => v.id === service.currentVersionId && v.status === "PUBLISHED",
  );
  return {
    versionNumber: current?.versionNumber ?? null,
    toolCount: current?.tools.length ?? 0,
    promptCount: current?.prompts.length ?? 0,
  };
}
export function constrainGrantScopes(
  selected: Iterable<string>,
  caps: { toolCount: number; promptCount: number },
): string[] {
  const order = ["mcp:connect", "tools:list", "tools:call", "prompts:list", "prompts:get"];
  const values = new Set(selected);
  values.add("mcp:connect");
  return order.filter((s) => {
    if (!values.has(s)) return false;
    if (s === "mcp:connect") return true;
    if (s.startsWith("tools:")) return caps.toolCount > 0;
    return caps.promptCount > 0;
  });
}
