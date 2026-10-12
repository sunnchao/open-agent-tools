import {
  conditionCases,
  conditionReference,
  inputVariableType,
  isVisualCondition,
  runVariables,
  type ConditionCase,
  type ConditionValueType,
} from "@open-agent-tools/workflow-contracts";
import type { Edge } from "@xyflow/react";
import { nodeInputs, type NodeInputBinding } from "./model.js";
import {
  inputOptions,
  nextVariableName,
  sourceKey,
  variableNodes,
  type VariableOption,
} from "./variables.js";
import type { WorkflowNode, WorkflowEdge } from "./types.js";

export function newConditionCase(): ConditionCase {
  return { id: `case-${crypto.randomUUID()}`, logicalOperator: "and", rules: [] };
}
export function branchIdOf(edge: Edge): string | undefined {
  const value = (edge as WorkflowEdge).branchId;
  return typeof value === "string" ? value : undefined;
}
export function branchHandle(branchId: string): string {
  return `branch:${branchId}`;
}
export function edgeBranch(config: Record<string, unknown>, edge: Edge): string {
  return isVisualCondition(config) ? (branchIdOf(edge) ?? "") : String(edge.label || "default");
}
export function conditionBranches(config: Record<string, unknown>) {
  if (!isVisualCondition(config))
    return [
      { id: "true", label: "IF", caseLabel: "CASE 1" },
      { id: "false", label: "ELSE", caseLabel: "ELSE" },
      { id: "default", label: "默认", caseLabel: "默认兜底" },
    ];
  return [
    ...conditionCases(config).map((item, index) => ({
      id: item.id,
      label: index === 0 ? "IF" : "ELIF",
      caseLabel: `CASE ${index + 1}`,
    })),
    { id: "else", label: "ELSE", caseLabel: "ELSE" },
  ];
}
export function configureBranchEdge(
  edge: Edge,
  config: Record<string, unknown>,
  branchId: string,
): WorkflowEdge {
  const next: WorkflowEdge = { ...edge, sourceHandle: branchHandle(branchId) };
  delete next.label;
  delete next.branchId;
  if (isVisualCondition(config)) next.branchId = branchId;
  else if (branchId === "true" || branchId === "false") next.label = branchId;
  return next;
}
export function restoreBranchEdge(edge: Edge, nodes: WorkflowNode[]): WorkflowEdge {
  const node = nodes.find((item) => item.id === edge.source);
  return node?.data.kind === "condition"
    ? { ...edge, sourceHandle: branchHandle(edgeBranch(node.data.config, edge)) }
    : edge;
}
export function canConnectTarget(
  source: string,
  target: string,
  nodes: WorkflowNode[],
  edges: Edge[],
): boolean {
  if (source === target || nodes.find((item) => item.id === target)?.data.kind === "start")
    return false;
  if (!nodes.some((node) => node.id === source) || !nodes.some((node) => node.id === target))
    return false;
  const queue = [target],
    visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (id === source) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of edges) if (edge.source === id) queue.push(edge.target);
  }
  return true;
}
export function updateConditionGraph(
  nodes: WorkflowNode[],
  edges: Edge[],
  nodeId: string,
  config: Record<string, unknown>,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const previous = nodes.find((node) => node.id === nodeId);
  const allowed = new Set(conditionBranches(config).map((branch) => branch.id));
  const oldVisual = previous ? isVisualCondition(previous.data.config) : false;
  const newVisual = isVisualCondition(config);
  const nextNodes = nodes.map((node) =>
    node.id === nodeId ? { ...node, data: { ...node.data, config } } : node,
  );
  const nextEdges = edges
    .filter(
      (edge) =>
        edge.source !== nodeId ||
        (oldVisual === newVisual && allowed.has(edgeBranch(previous!.data.config, edge))),
    )
    .map((edge) => restoreBranchEdge(edge, nextNodes));
  return { nodes: nextNodes, edges: nextEdges };
}
export interface ConditionVariableOption extends VariableOption {
  type: ConditionValueType;
}
function conditionSourceKey(source: NodeInputBinding["source"]): string {
  return source.type === "literal" ? JSON.stringify(source) : sourceKey(source);
}
export function conditionVariableOptions(
  node: WorkflowNode,
  nodes: WorkflowNode[],
  edges: Edge[],
): ConditionVariableOption[] {
  const all = variableNodes(nodes);
  const runs = runVariables(all);
  const options = inputOptions(node, nodes, edges).filter(
    (option) => (JSON.parse(option.value) as NodeInputBinding["source"]).type !== "literal",
  );
  for (const binding of nodeInputs(node.data)) {
    if (
      binding.source.type === "literal" &&
      !options.some((option) => option.value === conditionSourceKey(binding.source))
    )
      options.push({
        value: conditionSourceKey(binding.source),
        label: binding.name,
        group: "已绑定变量",
      });
  }
  return options.map((option) => {
    const source = JSON.parse(option.value) as NodeInputBinding["source"];
    const type =
      source.type === "run"
        ? (runs.find((item) => item.name === source.variable)?.type ?? "any")
        : inputVariableType(
            {
              id: "$condition-option",
              kind: "condition",
              config: {
                inputs: [{ name: "value", source }],
              },
            },
            "value",
            all,
          );
    return {
      ...option,
      label: source.type === "run" ? option.label : `${option.label} · ${type}`,
      type,
    };
  });
}
export function selectConditionVariable(
  config: Record<string, unknown>,
  caseId: string,
  ruleIndex: number,
  selected: string,
): Record<string, unknown> {
  const source = JSON.parse(selected) as NodeInputBinding["source"];
  const inputs = Array.isArray(config.inputs) ? ([...config.inputs] as NodeInputBinding[]) : [];
  let binding = inputs.find(
    (item) => conditionSourceKey(item.source) === conditionSourceKey(source),
  );
  if (!binding) {
    const prefix =
      source.type === "run" ? source.variable : source.type === "node" ? source.output : "value";
    binding = {
      name: nextVariableName(
        inputs.map((item) => item.name),
        prefix,
      ),
      source,
      required: false,
    };
    inputs.push(binding);
  }
  return {
    ...config,
    inputs,
    cases: conditionCases(config).map((item) =>
      item.id === caseId
        ? {
            ...item,
            rules: item.rules.map((rule, index) =>
              index === ruleIndex ? { ...rule, variable: binding!.name } : rule,
            ),
          }
        : item,
    ),
  };
}
export function boundRuleType(
  node: WorkflowNode,
  variable: string,
  nodes: WorkflowNode[],
): ConditionValueType {
  const reference = conditionReference(variable);
  return reference.includes(".") || reference.includes("[")
    ? "any"
    : inputVariableType(
        { id: node.id, kind: node.data.kind, config: node.data.config },
        reference,
        variableNodes(nodes),
      );
}
export function ruleSource(node: WorkflowNode, variable: string): string | undefined {
  const name = conditionReference(variable);
  const binding = nodeInputs(node.data).find((item) => item.name === name);
  return binding ? conditionSourceKey(binding.source) : undefined;
}
