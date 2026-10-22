// 与 studio-web src/types.ts 同语义的跨端子集（RN 无 DOM 依赖）。
export type Role = "user" | "assistant" | "system" | "tool";
export type MessageStatus = "streaming" | "complete" | "error" | "stopped";
export type ToolCallStatus = "pending" | "done" | "error";
export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
}
export interface RagCitation {
  source: string;
  chunkIndex: number;
  content: string;
  [key: string]: unknown;
}
export interface SqlStep {
  id: string;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  message?: string;
}
export interface SqlResultProps {
  rows: Record<string, unknown>[];
  sourceId?: string;
  sourceName?: string;
  question?: string;
  sql?: string;
  auditId?: string;
  steps?: SqlStep[];
  durationMs?: number;
  truncated?: boolean;
  clarifying?: string;
}
export type UiBlock =
  | {
      type: "financial_report_card";
      props: { reports: Array<{ id: string; name: string; status: string }> };
    }
  | { type: "sql_result"; props: SqlResultProps }
  | { type: string; [key: string]: unknown };
export interface ToolCall {
  id?: string;
  name: string;
  arguments: string;
  result?: unknown;
  ui?: UiBlock;
  error?: string;
  status?: ToolCallStatus;
}
export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status?: MessageStatus;
  errorMessage?: string;
  toolCalls?: ToolCall[];
  uiBlocks?: UiBlock[];
  ragCitations?: RagCitation[];
  usage?: MessageUsage;
  tool_call_id?: string;
  tool_name?: string;
}
export interface McpToolBinding {
  serviceSlug: string;
  toolName: string;
}
export interface ChatResourceBinding {
  mcpTools: McpToolBinding[];
  rag: { sources: string[]; topK: number };
  sqlSources: string[];
}
export function emptyChatResources(): ChatResourceBinding {
  return { mcpTools: [], rag: { sources: [], topK: 5 }, sqlSources: [] };
}
type UnknownRecord = Record<string, unknown>;
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
function mcpToolList(value: unknown): McpToolBinding[] {
  if (!Array.isArray(value)) return [];
  const bindings = new Map<string, McpToolBinding>();
  value.forEach((item) => {
    if (!isRecord(item)) return;
    const serviceSlug = typeof item.serviceSlug === "string" ? item.serviceSlug.trim() : "";
    const toolName = typeof item.toolName === "string" ? item.toolName.trim() : "";
    if (!serviceSlug || !toolName) return;
    bindings.set(`${serviceSlug}:${toolName}`, { serviceSlug, toolName });
  });
  return [...bindings.values()];
}
export function normalizeChatResources(value: unknown): ChatResourceBinding {
  const resources = isRecord(value) ? value : {};
  const rag = isRecord(resources.rag) ? resources.rag : {};
  const topK = Math.max(1, Math.min(20, Math.floor(Number(rag.topK) || 5)));
  return {
    mcpTools: mcpToolList(resources.mcpTools),
    rag: { sources: stringList(rag.sources), topK },
    sqlSources: stringList(resources.sqlSources),
  };
}
export interface Session {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  resources: ChatResourceBinding;
  providerId?: string;
  model?: string;
}

const ROLES: Role[] = ["user", "assistant", "system", "tool"];
const MESSAGE_STATUSES: MessageStatus[] = ["streaming", "complete", "error", "stopped"];
const TOOL_STATUSES: ToolCallStatus[] = ["pending", "done", "error"];

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeToolCall(value: unknown): ToolCall | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  const status =
    typeof value.status === "string" && TOOL_STATUSES.includes(value.status as ToolCallStatus)
      ? (value.status as ToolCallStatus)
      : undefined;
  return {
    name,
    arguments:
      typeof value.arguments === "string"
        ? value.arguments
        : value.arguments === undefined
          ? ""
          : JSON.stringify(value.arguments),
    ...(typeof value.id === "string" && value.id.trim() ? { id: value.id.trim() } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(isRecord(value.ui) ? { ui: value.ui as UiBlock } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizeMessage(value: unknown, index: number): Message | null {
  if (!isRecord(value)) return null;
  const role =
    typeof value.role === "string" && ROLES.includes(value.role as Role)
      ? (value.role as Role)
      : null;
  if (!role) return null;
  const status =
    typeof value.status === "string" &&
    MESSAGE_STATUSES.includes(value.status as MessageStatus)
      ? (value.status as MessageStatus)
      : undefined;
  const toolCalls = Array.isArray(value.toolCalls)
    ? value.toolCalls.map(normalizeToolCall).filter((item): item is ToolCall => item !== null)
    : [];
  const uiBlocks = Array.isArray(value.uiBlocks)
    ? value.uiBlocks.filter(isRecord).map((item) => item as UiBlock)
    : [];
  return {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id.trim()
        : `message-${index}`,
    role,
    content: typeof value.content === "string" ? value.content : "",
    createdAt: finiteNumber(value.createdAt, Date.now()),
    ...(status ? { status } : {}),
    ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(uiBlocks.length > 0 ? { uiBlocks } : {}),
    ...(Array.isArray(value.ragCitations)
      ? {
          ragCitations: value.ragCitations.filter(
            (item): item is RagCitation =>
              isRecord(item) &&
              typeof item.source === "string" &&
              typeof item.content === "string",
          ),
        }
      : {}),
    ...(isRecord(value.usage)
      ? {
          usage: {
            inputTokens: finiteNumber(value.usage.inputTokens, 0),
            outputTokens: finiteNumber(value.usage.outputTokens, 0),
            totalTokens: finiteNumber(value.usage.totalTokens, 0),
            toolCalls: finiteNumber(value.usage.toolCalls, 0),
            toolErrors: finiteNumber(value.usage.toolErrors, 0),
          },
        }
      : {}),
    ...(typeof value.tool_call_id === "string" ? { tool_call_id: value.tool_call_id } : {}),
    ...(typeof value.tool_name === "string" ? { tool_name: value.tool_name } : {}),
  };
}

/** Accepts persisted/API payloads without trusting their shape. */
export function normalizeSession(value: unknown): Session {
  if (!isRecord(value)) throw new Error("会话数据格式无效");
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) throw new Error("会话缺少有效 ID");
  const messages = Array.isArray(value.messages)
    ? value.messages
        .map((item, index) => normalizeMessage(item, index))
        .filter((item): item is Message => item !== null)
    : [];
  return {
    id,
    title:
      typeof value.title === "string" && value.title.trim() ? value.title.trim() : "New chat",
    messages,
    updatedAt: finiteNumber(value.updatedAt, Date.now()),
    resources: normalizeChatResources(value.resources),
    ...(typeof value.providerId === "string" && value.providerId.trim()
      ? { providerId: value.providerId.trim() }
      : {}),
    ...(typeof value.model === "string" && value.model.trim()
      ? { model: value.model.trim() }
      : {}),
  };
}

export function normalizeSessions(value: unknown): Session[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sessions: Session[] = [];
  for (const item of value) {
    try {
      const session = normalizeSession(item);
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    } catch {
      // Skip a damaged cache entry rather than taking down the whole chat screen.
    }
  }
  return sessions;
}
export interface ChatRequestMessage {
  role: Role;
  content: string;
}
export type WorkspaceTab =
  | "chat"
  | "mcp"
  | "rag"
  | "connectors"
  | "observatory"
  | "reports"
  | "workflow"
  | "settings";
export const WORKSPACES: Array<{ id: WorkspaceTab; label: string; en: string }> = [
  { id: "chat", label: "对话", en: "Chat" },
  { id: "mcp", label: "MCP", en: "Toolkit" },
  { id: "rag", label: "知识库", en: "Knowledge + Graph" },
  { id: "connectors", label: "连接器", en: "Connectors" },
  { id: "observatory", label: "问数", en: "Schema" },
  { id: "reports", label: "报表", en: "Reports" },
  { id: "workflow", label: "工作流", en: "Workflow" },
  { id: "settings", label: "设置", en: "Settings" },
];

export const WORKSPACE_COPY: Record<
  WorkspaceTab,
  { label: string; en: string; description: string }
> = {
  chat: { label: "对话", en: "Chat", description: "多模型会话与工具协同" },
  mcp: { label: "MCP", en: "Toolkit", description: "工具治理、发布与调用" },
  rag: { label: "知识库", en: "Knowledge + Graph", description: "文档检索、图谱增强与质量运营" },
  connectors: { label: "连接器", en: "Connectors", description: "同步外部内容源" },
  observatory: { label: "问数", en: "Schema", description: "自然语言查询与审计" },
  reports: { label: "报表", en: "Reports", description: "定时报表与运行记录" },
  workflow: { label: "工作流", en: "Workflow", description: "编排、发布与回放" },
  settings: { label: "设置", en: "Settings", description: "连接、模型与品牌配置" },
};
