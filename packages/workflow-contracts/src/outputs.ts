export function collectEndOutputs(
  nodes: Array<{ id: string; kind: string }>,
  nodeOutputs: Record<string, Record<string, unknown>>,
  executionOrder: string[],
): Record<string, unknown> {
  const ends = new Set(nodes.filter((node) => node.kind === "end").map((node) => node.id));
  return Object.fromEntries(
    executionOrder
      .filter((id) => ends.has(id))
      .flatMap((id) => Object.entries(nodeOutputs[id] ?? {})),
  );
}
