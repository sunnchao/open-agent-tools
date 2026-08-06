import { nodeInputs, type NodeInputBinding, type WorkflowNodeData } from "./model.js";

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
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function createNodeTestInputDraft(
  data: WorkflowNodeData,
  runOutputs: Record<string, Record<string, unknown>> | null,
  runInputs: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    nodeInputs(data).map((binding) => {
      const source = binding.source;
      const value =
        source.type === "literal"
          ? source.value
          : source.type === "run"
            ? runInputs[source.variable]
            : runOutputs?.[source.nodeId]?.[source.output];
      return [binding.name, serializeNodeTestValue(value)];
    }),
  );
}

export function describeNodeTestInputSource(binding: NodeInputBinding): string {
  const source = binding.source;
  if (source.type === "literal") return "固定值";
  if (source.type === "run") return `运行输入 · ${source.variable || "未命名"}`;
  return `节点输出 · ${source.nodeId}.${source.output}`;
}
