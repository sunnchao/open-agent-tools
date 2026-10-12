const reserved = new Set(["__proto__", "prototype", "constructor"]);

export function valuePath(reference: string): string[] | null {
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(reference)) return null;
  const parts = reference.match(/[A-Za-z_$][\w$]*|\d+/g)!;
  return parts.some((part) => reserved.has(part)) ? null : parts;
}

export function referenceRoot(reference: string): string {
  return valuePath(reference)?.[0] ?? reference;
}

export function resolveReference(reference: string, values: Record<string, unknown>): unknown {
  const path = valuePath(reference);
  if (!path) throw new Error(`变量路径 ${reference} 格式无效`);
  let value: unknown = values;
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error(`变量路径 ${reference} 不存在（字段 ${key}）`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function interpolateTemplate(
  value: unknown,
  inputs: Record<string, unknown>,
  mode: "text" | "expression" = "text",
): string {
  return String(value ?? "").replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_match, name: string) => {
    const resolved = resolveReference(name.trim(), inputs);
    if (resolved === undefined) return mode === "expression" ? "undefined" : "";
    return mode === "expression" || typeof resolved !== "string"
      ? JSON.stringify(resolved)
      : resolved;
  });
}

export function interpolateTemplateValue(value: unknown, inputs: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => interpolateTemplateValue(item, inputs));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateTemplateValue(item, inputs)]),
    );
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{\s*([^{}]*?)\s*\}\}$/);
  return exact ? resolveReference(exact[1]!.trim(), inputs) : interpolateTemplate(value, inputs);
}
