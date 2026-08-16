import { Type, StringEnum, type Usage } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const READ_ONLY_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface IsolatedSubagentSession {
  readonly messages: ReadonlyArray<{ role: string; content?: unknown }>;
  prompt(input: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: AgentSessionEventListener): () => void;
}

export interface SubagentToolOptions {
  createSession: () => Promise<IsolatedSubagentSession>;
  onUsage?: (usage: SubagentUsage) => void;
}

function finalText(messages: IsolatedSubagentSession["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("");
    if (text) return text;
  }
  return "";
}

function addUsage(target: SubagentUsage, usage: Usage | undefined): void {
  if (!usage) return;
  target.inputTokens += usage.input ?? 0;
  target.outputTokens += usage.output ?? 0;
  target.reasoningTokens += usage.reasoning ?? 0;
}

function abortError(): Error {
  const error = new Error("子代理任务已取消");
  error.name = "AbortError";
  return error;
}

export async function runIsolatedSubagent(
  description: string,
  signal: AbortSignal | undefined,
  opts: SubagentToolOptions,
): Promise<string> {
  const session = await opts.createSession();
  const usage: SubagentUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let abortPromise: Promise<void> | null = null;
  const abort = (): void => {
    abortPromise ??= session.abort().catch(() => undefined);
  };
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end" && event.message.role === "assistant") {
      addUsage(usage, event.message.usage);
    }
    if (event.type === "compaction_end") addUsage(usage, event.result?.usage);
  });

  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      throw abortError();
    }
    await session.prompt(description);
    if (signal?.aborted) throw abortError();
    const text = finalText(session.messages);
    if (!text) throw new Error("子代理未返回文本结果");
    return text;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (abortPromise) await abortPromise;
    unsubscribe();
    session.dispose();
    if (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.reasoningTokens > 0) {
      opts.onUsage?.(usage);
    }
  }
}

/** Legacy deepagents `task` 的 Pi 替代：每次调用创建短生命周期、只读、隔离的子会话。 */
export function createSubagentPiTool(opts: SubagentToolOptions): ToolDefinition {
  return defineTool({
    name: "task",
    label: "子代理任务",
    description:
      "启动一个短生命周期、上下文隔离的只读子代理，完成复杂检索或分析并返回单份报告。子代理只能读取和搜索当前项目，不能修改文件或执行命令。",
    promptSnippet: "Delegate a complex read-only research task to an isolated subagent",
    promptGuidelines: [
      "Use task for complex, multi-step repository research that benefits from an isolated context.",
      "Give the subagent a self-contained description because it cannot see the parent conversation.",
    ],
    executionMode: "parallel",
    parameters: Type.Object({
      description: Type.String({ description: "要交给子代理的完整、自包含任务描述" }),
      subagent_type: Type.Optional(
        StringEnum(["general-purpose"] as const, {
          description: "子代理类型；当前仅支持 general-purpose",
          default: "general-purpose",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const text = await runIsolatedSubagent(params.description, signal, opts);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
