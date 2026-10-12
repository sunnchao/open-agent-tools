export * from "./graph.js";
export * from "./resume.js";
export * from "./paths.js";
export * from "./http.js";
export * from "./outputs.js";
export * from "./condition.js";
import { referenceRoot, valuePath } from "./paths.js";
import {
  conditionCases,
  conditionConfigIssues,
  conditionNeedsValue,
  isVisualCondition,
} from "./condition.js";
import { httpConfigIssues } from "./http.js";
import type { HttpNodeConfig } from "./graph.js";

/** Shared by the editor, published API and executor. Declarations live on the start node. */
export type VariableType = "any" | "string" | "number" | "boolean" | "object" | "array";
export interface RunVariable {
  name: string;
  type: VariableType;
  required?: boolean;
  defaultValue?: unknown;
}
export interface VariableNode {
  id: string;
  kind: string;
  config?: Record<string, unknown>;
}
export interface VariableIssue {
  code: string;
  message: string;
  nodeId: string;
  suggestions?: string[];
  reference?: string;
  field?: string;
  caseId?: string;
  ruleIndex?: number;
}
interface InputBinding {
  name: string;
  required?: boolean;
  source: { type: string; variable?: string; value?: unknown; nodeId?: string; output?: string };
}
interface OutputBinding {
  name: string;
  selector: string;
}
const types: VariableType[] = ["any", "string", "number", "boolean", "object", "array"];
const reservedNames = new Set(["__proto__", "prototype", "constructor"]);
export function validVariableName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !reservedNames.has(name);
}
export function inputsOf(node: VariableNode): InputBinding[] {
  return Array.isArray(node.config?.inputs) ? node.config.inputs : [];
}
export function hasRunDeclarations(nodes: VariableNode[]): boolean {
  return nodes.some(
    (node) => node.kind === "start" && Object.hasOwn(node.config ?? {}, "runVariables"),
  );
}
export function runVariables(nodes: VariableNode[]): RunVariable[] {
  if (hasRunDeclarations(nodes)) {
    return nodes
      .filter((node) => node.kind === "start")
      .flatMap((node) =>
        Array.isArray(node.config?.runVariables) ? node.config.runVariables : [],
      );
  }
  // Legacy workflows infer inputs once; explicit empty declarations must stay empty.
  const inferred = new Map<string, RunVariable>();
  for (const node of nodes)
    for (const input of inputsOf(node)) {
      if (input?.source?.type !== "run" || !input.source.variable) continue;
      const name = input.source.variable;
      inferred.set(name, {
        name,
        type: "any",
        required: input.required !== false || inferred.get(name)?.required === true,
      });
    }
  return [...inferred.values()];
}
export function similarVariableNames(name: string, candidates: string[]): string[] {
  const normalized = name.toLowerCase();
  return candidates.filter((candidate) => {
    if (candidate === name) return false;
    const other = candidate.toLowerCase();
    if (normalized === other) return true;
    if (normalized.length < 3 || Math.abs(normalized.length - other.length) > 1) return false;
    if (normalized.length === other.length) {
      const mismatches = [...normalized]
        .map((char, i) => (char === other[i] ? -1 : i))
        .filter((i) => i >= 0);
      return (
        mismatches.length === 1 ||
        (mismatches.length === 2 &&
          mismatches[1] === mismatches[0]! + 1 &&
          normalized[mismatches[0]!] === other[mismatches[1]!] &&
          normalized[mismatches[1]!] === other[mismatches[0]!])
      );
    }
    const longer = normalized.length > other.length ? normalized : other;
    const shorter = normalized.length > other.length ? other : normalized;
    return [...longer].some((_, i) => longer.slice(0, i) + longer.slice(i + 1) === shorter);
  });
}
export function matchesVariableType(value: unknown, type: VariableType): boolean {
  if (type === "any") return true;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
export function prepareRunInputs(variables: RunVariable[], values: Record<string, unknown>) {
  const input: Record<string, unknown> = { ...values };
  const errors: string[] = [];
  for (const variable of variables) {
    let value = Object.hasOwn(input, variable.name) ? input[variable.name] : undefined;
    if (value === undefined && variable.defaultValue !== undefined) value = variable.defaultValue;
    if (value === undefined) {
      if (variable.required !== false) errors.push(`入口变量 ${variable.name} 为必填`);
    } else if (!matchesVariableType(value, variable.type)) {
      errors.push(`入口变量 ${variable.name} 应为 ${variable.type}`);
    } else {
      Object.defineProperty(input, variable.name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return { input, errors };
}
export function templateFields(kind: string): string[] {
  if (kind === "llm") return ["systemPrompt", "prompt"];
  if (kind === "rag" || kind === "graph" || kind === "sql") return ["query"];
  if (kind === "condition") return ["expression", "cases"];
  if (kind === "mcp") return ["arguments"];
  if (kind === "http") return ["url", "params", "headers", "body", "authorization"];
  return [];
}
export function templateReferences(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((match) => match[1]!.trim());
}
export function templateStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(templateStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(templateStrings);
  return [];
}
export function resultFields(kind: string): Record<string, VariableType> | null {
  if (kind === "sql")
    return {
      sql: "string",
      rows: "array",
      rowCount: "number",
      auditId: "string",
      sourceId: "string",
      selectedTables: "array",
      steps: "array",
      durationMs: "number",
      truncated: "boolean",
    };
  if (kind === "graph") return { formatted: "string", seeds: "array" };
  if (kind === "rag") return { formatted: "string", chunks: "array" };
  if (kind === "http")
    return { body: "any", status_code: "number", headers: "object", size: "number" };
  return null;
}

export function inputVariableType(
  node: VariableNode,
  name: string,
  nodes: VariableNode[],
  seen = new Set<string>(),
): VariableType {
  const key = `${node.id}:${name}`;
  if (seen.has(key)) return "any";
  seen.add(key);
  const binding = inputsOf(node).find((item) => item.name === name);
  if (!binding) return "any";
  const source = binding.source;
  if (source.type === "run")
    return runVariables(nodes).find((item) => item.name === source.variable)?.type ?? "any";
  if (source.type === "literal") {
    if (Array.isArray(source.value)) return "array";
    if (source.value === null || source.value === undefined) return "any";
    const type = typeof source.value;
    return types.includes(type as VariableType) ? (type as VariableType) : "any";
  }
  const upstream = nodes.find((item) => item.id === source.nodeId);
  if (!upstream) return "any";
  const outputs = Array.isArray(upstream.config?.outputs)
    ? (upstream.config.outputs as OutputBinding[])
    : [];
  const selector = outputs.find((item) => item.name === source.output)?.selector;
  const path = selector ? valuePath(selector) : null;
  if (!path) return "any";
  if (path[0] === "$inputs" || (["input", "end"].includes(upstream.kind) && path[0] === "$result"))
    return path.length === 2 ? inputVariableType(upstream, path[1]!, nodes, seen) : "any";
  if (path[0] !== "$result") return "any";
  if (path.length === 1) {
    if (upstream.kind === "llm") return "string";
    if (upstream.kind === "condition")
      return isVisualCondition(upstream.config) ? "string" : "boolean";
    return ["http", "sql", "rag", "graph"].includes(upstream.kind) ? "object" : "any";
  }
  return path.length === 2 ? (resultFields(upstream.kind)?.[path[1]!] ?? "any") : "any";
}
export function selectorIssue(node: VariableNode, selector: string): string | null {
  const parts = valuePath(selector);
  if (!parts || !["$result", "$inputs"].includes(parts[0]!))
    return `输出路径 ${selector || "（空）"} 格式无效`;
  const [root, ...path] = parts;
  if (path.some((key) => reservedNames.has(key))) return `输出路径 ${selector} 包含保留字段`;
  if (!path.length) return null;
  if (root === "$inputs" || node.kind === "input" || node.kind === "end") {
    const input = inputsOf(node).find((item) => item.name === path[0]);
    if (!input) return `输出路径 ${selector} 引用了未声明的输入 ${path[0]}`;
    // Further paths depend on runtime values and are not inferred from a single sample.
    return null;
  }
  if (["llm", "condition", "start"].includes(node.kind))
    return `${node.kind} 的完整结果没有子字段：${selector}`;
  const fields = resultFields(node.kind);
  if (fields && !Object.hasOwn(fields, path[0]!)) return `结果中不存在字段 ${path[0]}`;
  if (fields?.[path[0]!] === "string" && path.length > 1) return `文本字段 ${path[0]} 没有子字段`;
  return null;
}
export function variableIssues(nodes: VariableNode[]): VariableIssue[] {
  const issues: VariableIssue[] = [];
  const variables = runVariables(nodes);
  const declared = new Set(variables.map((item) => item?.name));
  for (const node of nodes) {
    const add = (
      code: string,
      message: string,
      suggestions?: string[],
      details?: { reference?: string; field?: string },
    ) =>
      issues.push({
        code,
        message,
        nodeId: node.id,
        ...(suggestions?.length ? { suggestions } : {}),
        ...details,
      });
    if (node.kind === "start" && Object.hasOwn(node.config ?? {}, "runVariables")) {
      if (!Array.isArray(node.config?.runVariables))
        add("run-declaration", "入口变量声明必须是列表");
      const names = new Set<string>();
      for (const variable of variables) {
        if (!variable || typeof variable.name !== "string" || !validVariableName(variable.name)) {
          add(
            "run-declaration",
            "入口变量名须以字母或下划线开头，仅使用字母、数字、下划线或 $，且不能是保留名",
          );
          continue;
        }
        if (names.has(variable.name)) add("run-declaration", `入口变量 ${variable.name} 重复`);
        names.add(variable.name);
        if (!types.includes(variable.type))
          add("run-declaration", `入口变量 ${variable.name} 类型无效`);
        else if (
          variable.defaultValue !== undefined &&
          !matchesVariableType(variable.defaultValue, variable.type)
        )
          add("run-default", `入口变量 ${variable.name} 的默认值应为 ${variable.type}`);
      }
    }
    const inputs = inputsOf(node);
    if (node.kind === "http")
      for (const issue of httpConfigIssues((node.config ?? {}) as HttpNodeConfig))
        add(issue.code, issue.message);
    const names = new Set(inputs.map((input) => input?.name));
    if (node.kind === "condition") {
      for (const issue of conditionConfigIssues(
        node.config ?? {},
        new Map(inputs.map((input) => [input.name, inputVariableType(node, input.name, nodes)])),
      )) {
        const suggestions = issue.reference
          ? similarVariableNames(referenceRoot(issue.reference), [...names]).map(
              (candidate) =>
                candidate + issue.reference!.slice(referenceRoot(issue.reference!).length),
            )
          : [];
        issues.push({ ...issue, nodeId: node.id, ...(suggestions.length ? { suggestions } : {}) });
      }
    }
    for (const input of inputs) {
      if (typeof input?.name !== "string" || !validVariableName(input.name))
        add("input-identifier", `输入变量名 ${input?.name ?? "（空）"} 无效`);
      if (input?.source?.type === "run" && !declared.has(input.source.variable ?? "")) {
        const missing = input.source.variable ?? "";
        const suggestions = similarVariableNames(
          missing,
          [...declared].filter(Boolean) as string[],
        );
        add(
          "run-reference",
          `入口变量 ${missing || "（未选择）"} 未声明，请在开始节点创建后选择`,
          suggestions,
          { reference: missing },
        );
      }
    }
    for (const field of templateFields(node.kind)) {
      if (node.kind === "condition" && (field === "expression") === isVisualCondition(node.config))
        continue;
      let value = node.config?.[field];
      if (node.kind === "condition" && field === "cases")
        value = conditionCases(node.config ?? {}).flatMap((item) =>
          Array.isArray(item?.rules)
            ? item.rules
                .filter((rule) => rule && conditionNeedsValue(rule.operator))
                .map((rule) => rule.value)
            : [],
        );
      if (node.kind === "http" && field === "body") {
        const config = node.config as HttpNodeConfig;
        if (["get", "head"].includes(config.method ?? "get") || config.body?.type === "none")
          continue;
        if (config.body?.type === "json" && typeof config.body.data === "string") {
          try {
            value = JSON.parse(config.body.data || "{}");
          } catch {
            continue;
          }
        }
      }
      if (field === "arguments" && typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          continue;
        }
      }
      for (const text of templateStrings(value))
        for (const name of templateReferences(text)) {
          const root = referenceRoot(name);
          if (!valuePath(name) || !names.has(root)) {
            const similar = similarVariableNames(
              root,
              [...names].filter((item): item is string => typeof item === "string"),
            ).map((candidate) => candidate + name.slice(root.length));
            add(
              "template-reference",
              `${field} 引用了未绑定变量 ${name || "（空）"}；${similar.length ? `可修复为 ${similar.join("、")}` : "请通过“插入变量”选择"}`,
              similar,
              { reference: name, field },
            );
          }
        }
    }
    const outputs: OutputBinding[] = Array.isArray(node.config?.outputs) ? node.config.outputs : [];
    for (const output of outputs) {
      if (typeof output?.name !== "string" || !validVariableName(output.name))
        add("output-identifier", `输出变量名 ${output?.name ?? "（空）"} 无效`);
      const error = selectorIssue(
        node,
        typeof output?.selector === "string" ? output.selector : "",
      );
      if (error) add("selector-reference", error);
    }
  }
  return issues;
}
