import {
  nodeConfigSchemas,
  runVariables,
  workflowFileSchema,
  workflowGraphSchema,
} from "@open-agent-tools/workflow-contracts";
import type { ResourceCatalog } from "../resources/api.js";
import { createEdge, createNode, snapshotGraph } from "./graph.js";
import { validateWorkflowGraph } from "./model.js";
import { variableNodes } from "./variables.js";
import type { WorkflowSnapshot } from "./types.js";

export const workflowFileSizeLimit = 2 * 1024 * 1024;
const secretField =
  /(api[-_]?key|authorization|password|client[-_]?secret|provider[-_]?key|(^|[_-])(access|refresh|bearer)[-_]?token|(^|[_-])secret($|[_-]))/i;

function credentialName(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "apikey",
    "authorization",
    "password",
    "clientsecret",
    "providerkey",
    "accesstoken",
    "refreshtoken",
    "bearertoken",
    "secret",
  ].some((part) => normalized.includes(part));
}

function assertNoCredentials(value: unknown, path = "file"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentials(item, `${path}.${index}`));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (secretField.test(key))
        throw new Error(`${path}.${key} 包含凭据字段，请移除后再导入或导出`);
      if (key === "arguments" && typeof item === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(item);
        } catch {
          /* Graph validation reports malformed arguments. */
        }
        assertNoCredentials(parsed, `${path}.${key}`);
      }
      if (key === "defaultValue" && credentialName(String((value as { name?: string }).name ?? "")))
        throw new Error(`${path} 的凭据变量不能携带默认值`);
      assertNoCredentials(item, `${path}.${key}`);
    }
  }
}

export function serializeWorkflow(
  snapshot: WorkflowSnapshot,
  exportedAt = new Date().toISOString(),
): string {
  assertNoCredentials(snapshot);
  const graph = workflowGraphSchema.parse(
    snapshotGraph(snapshot.name, snapshot.nodes, snapshot.edges),
  );
  for (const node of graph.nodes)
    node.data.config = nodeConfigSchemas[node.data.kind].parse(node.data.config ?? {}) as Record<
      string,
      unknown
    >;
  const value = {
    name: graph.name,
    version: 1,
    exportedAt,
    graph,
    runVariables: runVariables(graph.nodes.map((node) => ({ id: node.id, ...node.data }))),
  };
  const json = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(json).length > workflowFileSizeLimit)
    throw new Error("工作流文件超过 2 MB");
  return json;
}

export function parseWorkflowFile(text: string, catalog: ResourceCatalog | null): WorkflowSnapshot {
  if (new TextEncoder().encode(text).length > workflowFileSizeLimit)
    throw new Error("工作流文件超过 2 MB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("文件不是合法 JSON");
  }
  assertNoCredentials(value);
  const parsed = workflowFileSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    );
  const { graph, runVariables: declarations } = parsed.data;
  const nodes = graph.nodes.map((node, index) => {
    const result = createNode(
      node.id,
      node.data.kind,
      node.position ?? { x: index * 280, y: 160 },
      node.data.config,
    );
    result.data.label = node.data.label ?? result.data.label;
    result.data.description = node.data.description ?? result.data.description;
    return result;
  });
  if (JSON.stringify(declarations) !== JSON.stringify(runVariables(variableNodes(nodes))))
    throw new Error("文件入口变量与开始节点声明不一致");
  const edges = graph.edges.map((edge) => ({
    ...createEdge(edge.source, edge.target),
    ...(edge.id ? { id: edge.id } : {}),
    ...(edge.label ? { label: edge.label } : {}),
  }));
  const issues = validateWorkflowGraph(nodes, edges, catalog);
  if (issues.length)
    throw new Error(
      issues.map((issue) => `${issue.nodeId ?? "工作流"}: ${issue.message}`).join("\n"),
    );
  return { name: parsed.data.name, nodes, edges };
}

export function downloadWorkflow(snapshot: WorkflowSnapshot, slug: string): void {
  const content = serializeWorkflow(snapshot);
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slug.replace(/[^a-zA-Z0-9_-]/g, "_") || "workflow"}.workflow.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
