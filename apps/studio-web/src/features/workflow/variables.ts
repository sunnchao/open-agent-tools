import {
  resultFields,
  runVariables,
  templateFields,
  type VariableIssue,
  type VariableNode,
} from "@open-agent-tools/workflow-contracts";
import { nodeInputs, nodeOutputs, type NodeInputBinding } from "./model.js";
import type { WorkflowNode } from "./types.js";

export function variableNodes(
  nodes: { id: string; data: { kind: string; config: Record<string, unknown> } }[],
): VariableNode[] {
  return nodes.map((node) => ({ id: node.id, kind: node.data.kind, config: node.data.config }));
}
export function nextVariableName(names: string[], prefix: string): string {
  if (!names.includes(prefix)) return prefix;
  let index = 2;
  while (names.includes(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}
export interface VariableOption {
  value: string;
  label: string;
  group: string;
}
export const sourceKey = (source: NodeInputBinding["source"]): string =>
  JSON.stringify(
    source.type === "literal"
      ? { type: "literal", value: "" }
      : source.type === "run"
        ? { type: "run", variable: source.variable }
        : { type: "node", nodeId: source.nodeId, output: source.output },
  );
export function inputOptions(
  node: WorkflowNode,
  nodes: WorkflowNode[],
  edges: { source: string; target: string }[],
): VariableOption[] {
  const predecessors = new Set(
    edges.filter((edge) => edge.target === node.id).map((edge) => edge.source),
  );
  return [
    ...runVariables(variableNodes(nodes)).map((variable) => ({
      value: sourceKey({ type: "run", variable: variable.name }),
      label: `${variable.name} · ${variable.type}`,
      group: "运行输入",
    })),
    ...nodes
      .filter((item) => predecessors.has(item.id))
      .flatMap((item) =>
        nodeOutputs(item.data).map((output) => ({
          value: sourceKey({ type: "node", nodeId: item.id, output: output.name }),
          label: `${output.name} · ${item.data.label}`,
          group: `前置节点 · ${item.data.label}`,
        })),
      ),
    { value: sourceKey({ type: "literal", value: "" }), label: "固定值", group: "其他" },
  ];
}
export function outputOptions(node: WorkflowNode, sample?: unknown): VariableOption[] {
  const options: VariableOption[] = [
    { value: "$result", label: "完整结果 · $result", group: "节点结果" },
    { value: "$inputs", label: "全部输入 · $inputs", group: "本节点输入" },
    ...nodeInputs(node.data).map((input) => ({
      value: `$inputs.${input.name}`,
      label: input.name,
      group: "本节点输入",
    })),
    ...Object.entries(resultFields(node.data.kind) ?? {}).map(([key, type]) => ({
      value: `$result.${key}`,
      label: `${key} · ${type}`,
      group: "结果字段",
    })),
  ];
  const seen = new Set(options.map((option) => option.value));
  function visit(value: unknown, path: string, depth: number) {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return;
    for (const [key, child] of Object.entries(value)) {
      if (
        !/^[A-Za-z_$][\w$]*$/.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        continue;
      const selector = `${path}.${key}`;
      if (!seen.has(selector)) {
        options.push({
          value: selector,
          label: `${selector} · ${Array.isArray(child) ? "array" : child === null ? "null" : typeof child}`,
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

/** 只替换模板占位符；JSON 模式递归处理值，不处理对象 key 或普通字符串。 */
export function replaceTemplateReference(
  value: string,
  before: string,
  after: string,
  json = false,
): string {
  if (!before || !after || before === after) return value;
  if (!json) {
    return value.replace(templateToken, (match, name: string) =>
      name.trim() === before ? `{{${after}}}` : match,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  let changed = false;
  const replace = (item: unknown): unknown => {
    if (typeof item === "string")
      return item.replace(templateToken, (match, name: string) => {
        if (name.trim() !== before) return match;
        changed = true;
        return `{{${after}}}`;
      });
    if (Array.isArray(item)) return item.map(replace);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, replace(child)]));
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
  const target = nodes.find((node) => node.id === issue.nodeId);
  if (!target || typeof issue.reference !== "string") return nodes;

  if (issue.code === "run-reference") {
    const declared = new Set(
      runVariables(variableNodes(nodes))
        .map((variable) => variable?.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!declared.has(replacement)) return nodes;
    const rawInputs = target.data.config.inputs;
    if (!Array.isArray(rawInputs)) return nodes;
    let changed = false;
    const nextInputs = rawInputs.map((binding) => {
      if (!binding || typeof binding !== "object") return binding;
      const source = (binding as { source?: unknown }).source;
      if (!source || typeof source !== "object") return binding;
      const typedSource = source as { type?: unknown; variable?: unknown };
      if (typedSource.type !== "run" || typedSource.variable !== issue.reference) return binding;
      changed = true;
      return {
        ...binding,
        source: { ...source, variable: replacement },
      };
    });
    if (!changed) return nodes;
    return nodes.map((node) =>
      node.id === target.id
        ? { ...node, data: { ...node.data, config: { ...node.data.config, inputs: nextInputs } } }
        : node,
    );
  }

  if (issue.code !== "template-reference" || !issue.field) return nodes;
  if (!templateFields(target.data.kind).includes(issue.field)) return nodes;
  const names = new Set(nodeInputs(target.data).map((input) => input.name));
  if (!names.has(replacement)) return nodes;
  const current = target.data.config[issue.field];
  if (typeof current !== "string") return nodes;
  const json = issue.field === "arguments";
  const next = replaceTemplateReference(current, issue.reference, replacement, json);
  if (next === current) return nodes;
  return nodes.map((node) =>
    node.id === target.id
      ? { ...node, data: { ...node.data, config: { ...node.data.config, [issue.field!]: next } } }
      : node,
  );
}

export function renameVariable(
  nodes: WorkflowNode[],
  nodeId: string,
  kind: "inputs" | "outputs" | "runVariables",
  before: string,
  after: string,
): WorkflowNode[] {
  if (!before || before === after) return nodes;
  return nodes.map((node) => {
    const config = { ...node.data.config };
    if (kind === "runVariables") {
      config.inputs = nodeInputs(node.data).map((input) =>
        input.source.type === "run" && input.source.variable === before
          ? { ...input, source: { ...input.source, variable: after } }
          : input,
      );
    }
    if (kind === "outputs") {
      config.inputs = nodeInputs(node.data).map((input) =>
        input.source.type === "node" &&
        input.source.nodeId === nodeId &&
        input.source.output === before
          ? { ...input, source: { ...input.source, output: after } }
          : input,
      );
    }
    if (kind === "inputs" && node.id === nodeId) {
      const replace = (value: unknown): unknown => {
        if (typeof value === "string")
          return value.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (match, name: string) =>
            name.trim() === before ? `{{${after}}}` : match,
          );
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, replace(item)]),
          );
        return value;
      };
      for (const field of templateFields(node.data.kind)) {
        const value = config[field];
        if (typeof value !== "string") continue;
        if (field === "arguments") {
          try {
            config[field] = JSON.stringify(replace(JSON.parse(value)), null, 2);
          } catch {
            /* Keep an invalid draft for repair. */
          }
        } else config[field] = replace(value);
      }
      config.outputs = nodeOutputs(node.data).map((output) => {
        const roots = [
          "$inputs",
          ...(["input", "end"].includes(node.data.kind) ? ["$result"] : []),
        ];
        let selector = output.selector;
        for (const root of roots) {
          const prefix = `${root}.${before}`;
          if (selector === prefix || selector.startsWith(`${prefix}.`))
            selector = `${root}.${after}${selector.slice(prefix.length)}`;
        }
        return { ...output, selector };
      });
    }
    return { ...node, data: { ...node.data, config } };
  });
}
