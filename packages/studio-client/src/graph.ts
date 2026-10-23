import type { GraphNode, GraphEdge } from "@open-agent-tools/api-contracts/graph";
export type { GraphNode, GraphEdge, GraphExport } from "@open-agent-tools/api-contracts/graph";

/** 名称是 UI 的遍历键；同名节点合并邻接关系，保持原有展示语义。 */
function adjacency(edges: GraphEdge[], nodes: GraphNode[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((node) => [node.id, node.name]));
  const graph = new Map<string, Set<string>>();
  const add = (from: string | undefined, to: string | undefined) => {
    if (from === undefined || !to) return;
    const neighbors = graph.get(from) ?? new Set<string>();
    neighbors.add(to);
    graph.set(from, neighbors);
  };
  for (const edge of edges) {
    const src = byId.get(edge.source);
    const dst = byId.get(edge.target);
    add(src, dst);
    add(dst, src);
  }
  return graph;
}

export function neighborsOf(edges: GraphEdge[], name: string, nodes: GraphNode[]): string[] {
  return [...(adjacency(edges, nodes).get(name) ?? [])];
}

export function walkChain(
  edges: GraphEdge[],
  nodes: GraphNode[],
  startNames: string[],
  hops: number,
): Set<string> {
  const graph = adjacency(edges, nodes);
  const seen = new Set(startNames);
  let frontier = [...startNames];
  for (let hop = 0; hop < hops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const neighbor of graph.get(name) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

export function edgeIdsInSet(
  edges: GraphEdge[],
  nodes: GraphNode[],
  names: Set<string>,
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node.name]));
  return new Set(
    edges
      .filter((edge) => {
        const src = byId.get(edge.source);
        const dst = byId.get(edge.target);
        return src && dst && names.has(src) && names.has(dst);
      })
      .map((edge) => edge.id),
  );
}
