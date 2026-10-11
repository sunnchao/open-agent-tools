import type { VariableNode } from "./index.js";
import { effectiveNodeConfig } from "./graph.js";

export interface ResumeGraph {
  nodes: VariableNode[];
  edges: Array<{ id?: string; source: string; target: string; label?: string }>;
}
export interface CachedWorkflowNode {
  outputs: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  result?: unknown;
}
export interface WorkflowResumeCheckpoint {
  fromNodeId: string;
  executeNodeIds: string[];
  cachedNodes: Record<string, CachedWorkflowNode>;
  activeEdgeIds: string[];
}

export function cachedNodesFromEvents(
  events: Array<{ type: string; payload: Record<string, unknown> }>,
): Record<string, CachedWorkflowNode> {
  const cached: Array<[string, CachedWorkflowNode]> = [];
  for (const event of events) {
    const data = event.payload;
    if (
      event.type === "node_finished" &&
      data.status === "success" &&
      typeof data.node_id === "string" &&
      data.outputs &&
      typeof data.outputs === "object" &&
      !Array.isArray(data.outputs)
    ) {
      cached.push([
        data.node_id,
        {
          outputs: data.outputs as Record<string, unknown>,
          inputs: data.inputs as Record<string, unknown> | undefined,
          result: data.result,
        },
      ]);
    }
  }
  return Object.fromEntries(cached);
}

function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, ordered(child)]),
      );
    return item;
  };
  return JSON.stringify(ordered(value));
}

export function prepareResumeCheckpoint(
  current: ResumeGraph,
  previous: ResumeGraph,
  fromNodeId: string,
  cache: Record<string, CachedWorkflowNode>,
): WorkflowResumeCheckpoint {
  const byId = new Map(current.nodes.map((node) => [node.id, node]));
  if (!byId.has(fromNodeId)) throw new Error("续跑节点已不在当前草稿中");
  if (!Object.hasOwn(cache, fromNodeId)) throw new Error("该节点没有成功运行的缓存");
  const edges = current.edges.map((edge, index) => ({
    ...edge,
    id: edge.id?.trim() || `${edge.source}-${edge.target}-${index}`,
  }));
  const outgoing = (id: string) => edges.filter((edge) => edge.source === id);
  const incoming = (id: string) => edges.filter((edge) => edge.target === id);
  const execute = new Set([fromNodeId]);
  const queue = [fromNodeId];
  for (let index = 0; index < queue.length; index++)
    for (const edge of outgoing(queue[index]!))
      if (!execute.has(edge.target)) {
        execute.add(edge.target);
        queue.push(edge.target);
      }

  const before = new Map(previous.nodes.map((node) => [node.id, node]));
  const connections = (graph: ResumeGraph, id: string, direction: "source" | "target") =>
    canonical(
      graph.edges
        .filter((edge) => edge[direction] === id)
        .map((edge) => ({ source: edge.source, target: edge.target, label: edge.label ?? "" }))
        .sort((a, b) => canonical(a).localeCompare(canonical(b))),
    );
  if (connections(current, fromNodeId, "target") !== connections(previous, fromNodeId, "target")) {
    throw new Error("续跑节点的上游连接已修改，请先完整运行");
  }
  if (connections(current, fromNodeId, "target") !== connections(previous, fromNodeId, "target"))
    throw new Error("续跑节点的上游连接已修改，请先完整运行");
  const degrees = new Map(current.nodes.map((node) => [node.id, incoming(node.id).length]));
  const order = current.nodes.filter((node) => degrees.get(node.id) === 0).map((node) => node.id);
  for (let index = 0; index < order.length; index++)
    for (const edge of outgoing(order[index]!)) {
      const remaining = degrees.get(edge.target)! - 1;
      degrees.set(edge.target, remaining);
      if (remaining === 0) order.push(edge.target);
    }
  if (order.length !== current.nodes.length) throw new Error("工作流包含环，无法续跑");
  const active = new Set(
    current.nodes.filter((node) => incoming(node.id).length === 0).map((node) => node.id),
  );
  const reused: Array<[string, CachedWorkflowNode]> = [];
  const activeEdgeIds: string[] = [];
  const reached = new Set<string>();
  const currentIds = new Set(current.nodes.map((node) => node.id));
  for (const id of order) {
    if (id === fromNodeId) {
      reached.add(id);
      break;
    }
    if (!active.has(id) || execute.has(id)) continue;
    if (!Object.hasOwn(cache, id)) throw new Error(`上游节点 ${id} 缓存缺失，请先完整运行`);
    const cached = cache[id]!;
    const node = byId.get(id)!;
    const old = before.get(id);
    const oldIncoming = previous.edges
      .filter((edge) => edge.target === id)
      .map((edge) => edge.source);
    const newIncoming = current.edges
      .filter((edge) => edge.target === id)
      .map((edge) => edge.source);
    if (
      !old ||
      oldIncoming.some((source) => !currentIds.has(source)) ||
      newIncoming.some((source) => !before.has(source)) ||
      node.kind !== old.kind ||
      canonical(
        effectiveNodeConfig(
          node.kind as Parameters<typeof effectiveNodeConfig>[0],
          node.config ?? {},
        ),
      ) !==
        canonical(
          effectiveNodeConfig(
            old.kind as Parameters<typeof effectiveNodeConfig>[0],
            old.config ?? {},
          ),
        ) ||
      connections(current, id, "target") !== connections(previous, id, "target") ||
      (node.kind === "condition" &&
        connections(current, id, "source") !== connections(previous, id, "source"))
    )
      throw new Error(`上游节点 ${id} 已修改，请先完整运行`);
    reused.push([id, cached]);
    let selected = outgoing(id);
    if (node.kind === "condition") {
      if (typeof cached.result !== "boolean")
        throw new Error(`条件节点 ${id} 缓存不完整，请先完整运行`);
      const branches = selected.filter((edge) => edge.label === String(cached.result));
      selected = branches.length ? branches : selected.filter((edge) => !edge.label);
    }
    for (const edge of selected) {
      active.add(edge.target);
      activeEdgeIds.push(edge.id);
    }
  }
  if (!reached.has(fromNodeId)) {
    if (incoming(fromNodeId).length && !active.has(fromNodeId))
      throw new Error("历史条件路径未选择该节点，请先完整运行");
    throw new Error(`上游节点缓存缺失，请先完整运行`);
  }
  return {
    fromNodeId,
    executeNodeIds: [...execute],
    cachedNodes: Object.fromEntries(reused),
    activeEdgeIds,
  };
}
