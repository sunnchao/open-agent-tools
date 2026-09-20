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
}
interface InputBinding {
  name: string;
  required?: boolean;
  source: { type: string; variable?: string; value?: unknown };
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
  if (kind === "rag" || kind === "graph") return ["query"];
  if (kind === "condition") return ["expression"];
  if (kind === "mcp") return ["arguments"];
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
  if (kind === "graph") return { formatted: "string", seeds: "array" };
  if (kind === "rag") return { formatted: "string", chunks: "array" };
  return null;
}
export function selectorIssue(node: VariableNode, selector: string): string | null {
  if (!/^\$(result|inputs)(\.[A-Za-z_$][\w$]*)*$/.test(selector))
    return `输出路径 ${selector || "（空）"} 格式无效`;
  const [root, ...path] = selector.split(".");
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
    const add = (code: string, message: string) => issues.push({ code, message, nodeId: node.id });
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
    const names = new Set(inputs.map((input) => input?.name));
    for (const input of inputs) {
      if (typeof input?.name !== "string" || !validVariableName(input.name))
        add("input-identifier", `输入变量名 ${input?.name ?? "（空）"} 无效`);
      if (input?.source?.type === "run" && !declared.has(input.source.variable ?? ""))
        add(
          "run-reference",
          `入口变量 ${input.source.variable || "（未选择）"} 未声明，请在开始节点创建后选择`,
        );
    }
    for (const field of templateFields(node.kind)) {
      let value = node.config?.[field];
      if (field === "arguments" && typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          continue;
        }
      }
      for (const text of templateStrings(value))
        for (const name of templateReferences(text)) {
          if (!names.has(name)) {
            const similar = similarVariableNames(
              name,
              [...names].filter((item): item is string => typeof item === "string"),
            );
            add(
              "template-reference",
              `${field} 引用了未绑定变量 ${name || "（空）"}；${similar.length ? `是否选择 ${similar.join("、")}？` : "请通过“插入变量”选择"}`,
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
