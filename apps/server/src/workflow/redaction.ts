import { redactAuditPayload } from "@open-agent-tools/observability/audit";
import {
  httpCredentialValues,
  interpolateTemplate,
  type HttpNodeConfig,
  runVariables,
} from "@open-agent-tools/workflow-contracts";
import type { WorkflowNodeInput } from "./executor.js";

export function workflowRedactor(nodes: WorkflowNodeInput[], runInputs: Record<string, unknown>) {
  const enabled = nodes.some((node) => node.kind === "http");
  const initialInputs = {
    ...Object.fromEntries(
      runVariables(nodes)
        .filter((variable) => variable.defaultValue !== undefined)
        .map((variable) => [variable.name, variable.defaultValue]),
    ),
    ...runInputs,
  };
  const secrets = new Set<string>();
  const add = (node: WorkflowNodeInput, inputs: Record<string, unknown>) => {
    if (node.kind !== "http") return;
    for (const value of httpCredentialValues((node.config ?? {}) as HttpNodeConfig, inputs))
      secrets.add(value);
    const auth = (node.config as HttpNodeConfig | undefined)?.authorization;
    if (auth?.type === "basic") {
      try {
        const username = interpolateTemplate(auth.config?.username, inputs);
        const password = interpolateTemplate(auth.config?.password, inputs);
        if (password) secrets.add(Buffer.from(`${username}:${password}`).toString("base64"));
      } catch {
        /* Resolve dynamic credentials when their upstream input becomes available. */
      }
    }
  };
  for (const node of nodes) {
    const inputs = Object.fromEntries(
      (Array.isArray(node.config?.inputs) ? node.config.inputs : []).map(
        (binding: {
          name: string;
          source: { type: string; value?: unknown; variable?: string };
        }) => [
          binding.name,
          binding.source?.type === "literal"
            ? binding.source.value
            : binding.source?.type === "run"
              ? initialInputs[binding.source.variable ?? ""]
              : undefined,
        ],
      ),
    );
    add(node, inputs);
  }
  const redact = <T>(value: T): T => {
    if (!enabled || value === undefined) return value;
    const replace = (item: unknown): unknown => {
      if (typeof item === "string") {
        let text = item;
        for (const secret of [...secrets].sort((a, b) => b.length - a.length))
          if (secret) text = text.split(secret).join("[REDACTED]");
        return text;
      }
      if (Array.isArray(item)) return item.map(replace);
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [key, replace(child)]),
        );
      return item;
    };
    return replace(redactAuditPayload(value)) as T;
  };
  return { add, redact };
}
