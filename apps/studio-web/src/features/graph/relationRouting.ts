import { Position, type Edge, type Node } from "@xyflow/react";

export interface RelationEdgeData extends Record<string, unknown> {
  relType: string;
  rawId: string;
  curveOffset: number;
  showLabel?: boolean;
}

export type RelationFlowEdge = Edge<RelationEdgeData, "relation">;

interface EdgeLike {
  id: string;
  source: string;
  target: string;
}

interface Point {
  x: number;
  y: number;
}

interface EdgePorts {
  sourceHandle: string;
  targetHandle: string;
}

function pairKey(edge: EdgeLike): string {
  return edge.source < edge.target
    ? `${edge.source}\u0000${edge.target}`
    : `${edge.target}\u0000${edge.source}`;
}

/**
 * 为同一节点对的关系分配稳定的曲线车道。反向边会翻转相对偏移，
 * 因此 A -> B 与 B -> A 仍落在可见的不同物理车道上。
 */
export function parallelCurveOffsets(edges: EdgeLike[], gap = 28): Map<string, number> {
  const groups = new Map<string, EdgeLike[]>();
  for (const edge of edges) {
    const key = pairKey(edge);
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }

  const offsets = new Map<string, number>();
  for (const group of groups.values()) {
    group.forEach((edge, index) => {
      const lane = index - (group.length - 1) / 2;
      const direction = edge.source < edge.target ? 1 : -1;
      offsets.set(edge.id, lane * gap * direction);
    });
  }
  return offsets;
}

/** 让关系从最接近目标的一侧离开节点，减少穿过节点和无意义折返。 */
export function relationPorts(source: Point, target: Point): EdgePorts {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "right-source", targetHandle: "left-target" }
      : { sourceHandle: "left-source", targetHandle: "right-target" };
  }
  return dy >= 0
    ? { sourceHandle: "bottom-source", targetHandle: "top-target" }
    : { sourceHandle: "top-source", targetHandle: "bottom-target" };
}

export function relationPortsForNodes(
  sourceId: string,
  targetId: string,
  nodes: Array<Pick<Node, "id" | "position">>,
): EdgePorts {
  const byId = new Map(nodes.map((node) => [node.id, node.position]));
  return relationPorts(byId.get(sourceId) ?? { x: 0, y: 0 }, byId.get(targetId) ?? { x: 0, y: 0 });
}

export function rerouteRelationEdges(
  edges: RelationFlowEdge[],
  nodes: Array<Pick<Node, "id" | "position">>,
): RelationFlowEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node.position]));
  return edges.map((edge) => {
    const ports = relationPorts(
      byId.get(edge.source) ?? { x: 0, y: 0 },
      byId.get(edge.target) ?? { x: 0, y: 0 },
    );
    if (edge.sourceHandle === ports.sourceHandle && edge.targetHandle === ports.targetHandle) {
      return edge;
    }
    return { ...edge, sourceHandle: ports.sourceHandle, targetHandle: ports.targetHandle };
  });
}

export const RELATION_PORTS = [
  { position: Position.Top, name: "top" },
  { position: Position.Right, name: "right" },
  { position: Position.Bottom, name: "bottom" },
  { position: Position.Left, name: "left" },
] as const;
