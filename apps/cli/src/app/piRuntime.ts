/**
 * piRuntime：CLI 在 PI Agent 底座上的接入层（P0.3）。
 *
 * 封装 pi-coding-agent 的 createAgentSession，把 Pi 事件流桥接为现有
 * StreamableAgentCallbacks（onToken/onReasoning/onToolCall/onToolStart/
 * onToolResult/onToolDenied/onUsage/onAudit/requestPermission），并承担：
 * - 模型装配：ModelRuntime + OpenAI 兼容 provider（OPENAI_API_* env）。
 * - HITL 权限门：write / edit / bash 经 tool_call 事件拦截，复用 callbacks.requestPermission
 *   （由调用方接到 PermissionManager）。
 * - 审计：tool_call / tool_execution_* 事件 → onAudit（写 audit_log）。
 * - 系统提示词注入：before_agent_start 事件返回每轮动态构建的 systemPrompt。
 *
 * 与 deepagents 版 Agent.runTurn 的对应关系：
 *   repl 原调用 runTurn(history, systemPrompt, cb) → piRuntime.prompt(input, { systemPrompt, callbacks })。
 */
import path from "node:path";
import os from "node:os";
import { Type, type Usage } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ExtensionAPI,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getModelName, getThinkingLevel } from "./env.ts";
import type { StreamableAgentCallbacks } from "../ui/agentCallbacks.ts";
import { createMemoryPiTools } from "../tools/memoryPi.ts";
import { createTodoPiTool } from "../tools/todoPi.ts";
import { createSubagentPiTool, READ_ONLY_SUBAGENT_TOOLS } from "../tools/subagentPi.ts";
import { loadMcpPiTools } from "../tools/mcpPi.ts";
import type { MemoryStore } from "../store/memory.ts";

/** 与 deepagents 版 ToolCallLike 形状对齐（避免依赖 deepagent 类型）。 */
export interface ToolCallLike {
  name?: string;
  args?: unknown;
  id?: string;
}

/** 需要 HITL 授权的中断工具（对应 deepagents 的 write_file / edit_file / execute）。 */
const HITL_TOOLS = new Set(["write", "edit", "bash"]);
/** Pi 内置工具白名单。P0 与 deepagents 14 工具对齐：读类全开，写/执行走 HITL。 */
const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "ls", "find"];
export const PI_MODEL_CONTEXT_WINDOW = 128_000;
export const PI_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 10_000,
  keepRecentTokens: 4_000,
} as const;

export interface AuditEntry {
  source: "builtin" | "mcp";
  server?: string | null;
  toolName: string;
  decision: "allowed" | "denied" | "auto";
  argsSummary: string;
  error?: string | null;
}

export interface PiRuntimeOptions {
  cwd: string;
  /** 复用的审计写入器（recordAudit → logAudit + sessionId）。 */
  onAudit: (entry: AuditEntry) => void;
  /** 长期记忆服务（记忆工具 execute 复用）。 */
  memoryStore: MemoryStore;
  /** 当前会话 id（记忆写入关联）。 */
  currentSessionId: () => string | undefined;
  /** MCP requirePermission=true 的工具调用授权回调；缺失时默认拒绝。 */
  requestPermission?: (name: string, argsSummary: string) => Promise<boolean>;
}

export interface PiRuntime {
  /** 当前底层 Pi 会话（P0.6 会话桥接 / 调试用）。 */
  readonly session: AgentSession | null;
  /**
   * 执行一轮对话（替代 Agent.runTurn）。
   * 返回最终助手文本（供 repl 落库）；流式渲染经由 callbacks 完成。
   */
  prompt(
    input: string,
    opts: { systemPrompt: string; callbacks: StreamableAgentCallbacks },
  ): Promise<string>;
  /** 注入跨会话历史（/load 恢复）。仅保留 user / assistant 纯文本轮次，跳过 tool/system。 */
  setHistory(messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<void>;
  /** 当前已装配的工具名（/tools 展示用）。 */
  getToolNames(): string[];
  /** 当前 MCP 工具 → server 映射（/tools 来源标记用）。 */
  getMcpToolServers(): Array<{ name: string; server: string }>;
  /** 重建底层会话（MCP / 记忆工具装配变化后调用）。 */
  rebuild(): Promise<void>;
  /** 关闭并清理。 */
  dispose(): void;
}

/** 历史注入用的空 usage（Pi AssistantMessage 必填字段）。 */
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 从 Pi AssistantMessage 提取纯文本（text block 拼接）。 */
export function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("");
}

/** 取一轮 prompt 结束后最后一个含文本的 assistant 消息。 */
export function lastAssistantText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const text = assistantText(msg.content);
    if (text) return text;
  }
  return "";
}

/** P0 自定义工具：当前时间（原 deepagents 的 getCurrentTime）。 */
function createTimeTool(): ToolDefinition {
  return defineTool({
    name: "get_current_time",
    label: "获取当前时间",
    description: "获取当前 ISO 8601 时间（UTC）。",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
      details: {},
    }),
  });
}

/** 提取工具调用参数摘要（审计 / 授权提示用）。 */
export function argsSummary(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** 把工具执行结果合并进调用审计；成功显式记 null，失败保留可检索的错误文本。 */
export function completeToolAudit(
  entry: AuditEntry,
  result: unknown,
  isError: boolean,
): AuditEntry {
  if (!isError) return { ...entry, error: null };
  const text = assistantText((result as { content?: unknown } | null)?.content);
  return { ...entry, error: text || "工具执行失败" };
}

interface ToolCallHandlerOptions {
  callbacks: StreamableAgentCallbacks | null;
  mcpToolNames: readonly string[];
  onAudit: (entry: AuditEntry) => void;
}

/** 将 Pi 的 session 事件转发到现有 CLI 流式回调。 */
export function attachSessionCallbacks(
  session: Pick<AgentSession, "subscribe">,
  getCallbacks: () => StreamableAgentCallbacks | null,
): () => void {
  const listener: AgentSessionEventListener = (event: AgentSessionEvent) => {
    if (event.type !== "message_update") return;
    const cb = getCallbacks();
    if (!cb) return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") cb.onToken?.(update.delta);
    if (update.type === "thinking_delta") cb.onReasoning?.(update.delta);
  };
  return session.subscribe(listener);
}

/** 处理工具展示、默认 timeout、HITL 决策与调用审计。 */
export async function handleToolCallEvent(
  event: ToolCallEvent,
  opts: ToolCallHandlerOptions,
): Promise<ToolCallEventResult | undefined> {
  const cb = opts.callbacks;
  if (!cb) return undefined;
  const name = event.toolName;
  const input = event.input as Record<string, unknown>;
  if (name === "bash" && typeof input.timeout !== "number") input.timeout = 30;

  const summary = argsSummary(input);
  const call: ToolCallLike = { name, args: input, id: event.toolCallId };
  cb.onToolCall?.(call);

  if (opts.mcpToolNames.includes(name)) {
    cb.onToolStart?.(call);
    return undefined;
  }
  if (!HITL_TOOLS.has(name)) {
    cb.onToolStart?.(call);
    opts.onAudit({
      source: "builtin",
      server: null,
      toolName: name,
      decision: "auto",
      argsSummary: summary,
    });
    return undefined;
  }

  const allowed = (await cb.requestPermission?.(name, summary)) ?? false;
  if (allowed) {
    cb.onToolStart?.(call);
    opts.onAudit({
      source: "builtin",
      server: null,
      toolName: name,
      decision: "allowed",
      argsSummary: summary,
    });
    return undefined;
  }
  cb.onToolDenied?.(call);
  opts.onAudit({
    source: "builtin",
    server: null,
    toolName: name,
    decision: "denied",
    argsSummary: summary,
  });
  return { block: true, reason: `用户拒绝了工具调用: ${name}`, terminate: false };
}

type PiMessage = Parameters<SessionManager["appendMessage"]>[0];

function createHistorySessionManager(
  cwd: string,
  model: { api: string; provider: string; id: string },
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): SessionManager {
  const manager = SessionManager.inMemory(cwd);
  const firstTimestamp = Date.now() - messages.length;
  messages.forEach((message, index) => {
    const timestamp = firstTimestamp + index;
    const piMessage: PiMessage =
      message.role === "user"
        ? { role: "user", content: message.content, timestamp }
        : {
            role: "assistant",
            content: [{ type: "text", text: message.content }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: EMPTY_USAGE,
            stopReason: "stop",
            timestamp,
          };
    manager.appendMessage(piMessage);
  });
  return manager;
}

export async function createPiRuntime(opts: PiRuntimeOptions): Promise<PiRuntime> {
  const { cwd, onAudit, memoryStore, currentSessionId, requestPermission } = opts;

  // ---- 模型装配（P0.2 已验证的 compat 配置） ----
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const modelName = getModelName();
  const thinkingLevel = getThinkingLevel();
  const baseUrl = process.env.OPENAI_API_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("PI 底座需要 OPENAI_API_BASE_URL / OPENAI_API_KEY（.env.local）");
  }
  modelRuntime.registerProvider("openai-compatible", {
    name: "OpenAI Compatible",
    baseUrl,
    apiKey,
    api: "openai-completions",
    models: [
      {
        id: modelName,
        name: modelName,
        reasoning: true,
        input: ["text"],
        contextWindow: PI_MODEL_CONTEXT_WINDOW,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          supportsStrictTools: false,
        },
      },
    ],
  });
  const model = modelRuntime.getModel("openai-compatible", modelName);
  if (!model) {
    throw new Error(`PI 底座无法解析模型: ${modelName}`);
  }

  // ---- 每轮状态（prompt 前更新，事件订阅读取） ----
  let activeCallbacks: StreamableAgentCallbacks | null = null;
  let pendingSystemPrompt = "";
  // 当前已装配的工具名（/tools 展示用；rebuild 时更新）。
  let currentToolNames: string[] = BUILTIN_TOOLS;
  // MCP 工具名（tool_call 事件跳过重复审计；dispose 时关闭连接）。
  let mcpToolNames: string[] = [];
  let currentMcpToolServers: Array<{ name: string; server: string }> = [];
  let mcpCleanup: (() => Promise<void>) | null = null;
  // 一轮 prompt 内的 token 用量（turn_end 累加）。
  let turnUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pendingBuiltinAudits = new Map<string, AuditEntry>();

  const settingsManager = SettingsManager.inMemory({
    // P2.6：开启自动压缩（长会话接近上下文窗口时摘要旧消息，避免 overflow）。
    // reserveTokens 保留给输出与工具结果；keepRecentTokens 保留最近消息原文。
    compaction: PI_COMPACTION_SETTINGS,
    retry: { enabled: true, maxRetries: 2 },
  });
  const agentDir = path.join(os.tmpdir(), "open-agent-tools-pi");

  // ---- 扩展：HITL 权限门 + 审计 ----
  const coreExtension = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (_event) => {
      if (!pendingSystemPrompt) return undefined;
      return { systemPrompt: pendingSystemPrompt };
    });

    pi.on("tool_call", async (event: ToolCallEvent, _ctx) => {
      return handleToolCallEvent(event, {
        callbacks: activeCallbacks,
        mcpToolNames,
        onAudit: (entry) => {
          if (entry.decision === "denied") onAudit(entry);
          else pendingBuiltinAudits.set(event.toolCallId, entry);
        },
      });
    });

    pi.on("tool_execution_end", async (event, _ctx) => {
      const pendingAudit = pendingBuiltinAudits.get(event.toolCallId);
      if (pendingAudit) {
        pendingBuiltinAudits.delete(event.toolCallId);
        onAudit(completeToolAudit(pendingAudit, event.result, event.isError));
      }
      const cb = activeCallbacks;
      if (!cb) return undefined;
      const text = assistantText(event.result?.content);
      cb.onToolResult?.({ name: event.toolName, id: event.toolCallId }, text);
    });

    pi.on("turn_end", async (event) => {
      if (event.message.role !== "assistant") return;
      const usage = event.message.usage;
      if (!usage) return;
      turnUsage.inputTokens += usage.input ?? 0;
      turnUsage.outputTokens += usage.output ?? 0;
      turnUsage.reasoningTokens += usage.reasoning ?? 0;
    });

    pi.on("session_compact", async (event) => {
      if (!activeCallbacks) return;
      const usage = event.compactionEntry.usage;
      if (!usage) return;
      turnUsage.inputTokens += usage.input ?? 0;
      turnUsage.outputTokens += usage.output ?? 0;
      turnUsage.reasoningTokens += usage.reasoning ?? 0;
    });
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [coreExtension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  let session: AgentSession | null = null;

  const createSubagentSession = async (): Promise<AgentSession> => {
    const childResourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () =>
        "You are a read-only repository research subagent. Inspect the project with the available tools and return one concise, evidence-based report. You cannot modify files or execute shell commands.",
      appendSystemPromptOverride: () => [],
    });
    await childResourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel,
      tools: [...READ_ONLY_SUBAGENT_TOOLS],
      resourceLoader: childResourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    return created.session;
  };

  const rebuild = async (nextSessionManager?: SessionManager): Promise<void> => {
    const sessionManager =
      nextSessionManager ?? session?.sessionManager ?? SessionManager.inMemory(cwd);
    session?.dispose();
    await mcpCleanup?.().catch(() => undefined);
    mcpCleanup = null;

    await resourceLoader.reload();
    // 自定义工具（时间 + 记忆 + todo + 隔离子代理）。注意：createAgentSession 的 tools 是白名单，
    // 自定义工具名必须显式包含在内，否则会被过滤。
    const baseCustom = [
      createTimeTool(),
      createTodoPiTool(cwd),
      createSubagentPiTool({
        createSession: createSubagentSession,
        onUsage: (usage) => {
          turnUsage.inputTokens += usage.inputTokens;
          turnUsage.outputTokens += usage.outputTokens;
          turnUsage.reasoningTokens += usage.reasoningTokens;
        },
      }),
      ...createMemoryPiTools({
        store: memoryStore,
        currentSessionId,
        modelName,
      }),
    ];
    // MCP 动态工具（复用既有配置/信任/ACL 语义）。
    const mcp = await loadMcpPiTools(
      new Set([...BUILTIN_TOOLS, ...baseCustom.map((t) => t.name)]),
      {
        requestPermission,
        onAudit,
      },
    );
    for (const e of mcp.errors) console.warn(`MCP: ${e}`);
    mcpToolNames = mcp.mcpToolNames;
    currentMcpToolServers = mcp.toolServers;
    mcpCleanup = mcp.cleanup;

    const customTools = [...baseCustom, ...mcp.tools];
    const created = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel,
      tools: [...BUILTIN_TOOLS, ...customTools.map((t) => t.name)],
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    currentToolNames = [...BUILTIN_TOOLS, ...customTools.map((t) => t.name)];
    session = created.session;
    attachSessionCallbacks(session, () => activeCallbacks);
  };

  await rebuild();

  return {
    get session() {
      return session;
    },
    async prompt(input, { systemPrompt, callbacks }) {
      if (!session) throw new Error("PI 会话未初始化");
      pendingSystemPrompt = systemPrompt;
      turnUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
      pendingBuiltinAudits.clear();
      let receivedTextDelta = false;
      const originalOnToken = callbacks.onToken;
      const promptCallbacks: StreamableAgentCallbacks = {
        ...callbacks,
        onToken: (text) => {
          receivedTextDelta = true;
          originalOnToken?.(text);
        },
      };
      activeCallbacks = promptCallbacks;
      try {
        await session.prompt(input, { streamingBehavior: "followUp" });
        const answer = lastAssistantText(
          session.messages as unknown as Array<{ role: string; content: unknown }>,
        );
        if (!receivedTextDelta && answer) originalOnToken?.(answer);
        if (turnUsage.inputTokens > 0 || turnUsage.outputTokens > 0) {
          callbacks.onUsage?.(turnUsage);
        }
        return answer;
      } finally {
        pendingBuiltinAudits.clear();
        activeCallbacks = null;
        pendingSystemPrompt = "";
      }
    },
    async setHistory(messages) {
      await rebuild(createHistorySessionManager(cwd, model, messages));
    },
    getToolNames() {
      return [...currentToolNames];
    },
    getMcpToolServers() {
      return [...currentMcpToolServers];
    },
    async rebuild() {
      await rebuild();
    },
    dispose() {
      session?.dispose();
      session = null;
      void mcpCleanup?.().catch(() => undefined);
      mcpCleanup = null;
    },
  };
}

export { HITL_TOOLS, BUILTIN_TOOLS };
