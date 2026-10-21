import type { MessageUsage } from "../types.js";

export function UsageTag({ usage }: { usage?: MessageUsage }) {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.requests !== undefined) parts.push(`模型请求 ${usage.requests} 次`);
  parts.push(`${usage.totalTokens.toLocaleString()} tokens`);
  if (usage.toolCalls > 0) {
    parts.push(
      usage.toolErrors > 0
        ? `工具 ${usage.toolCalls} 次（${usage.toolErrors} 失败）`
        : `工具 ${usage.toolCalls} 次`,
    );
  }
  return (
    <span
      title={`输入 ${usage.inputTokens.toLocaleString()} · 输出 ${usage.outputTokens.toLocaleString()}`}
    >
      {parts.join(" · ")}
    </span>
  );
}
