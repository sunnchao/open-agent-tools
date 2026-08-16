/**
 * P1.2 记忆工具（Pi defineTool 版）。
 *
 * 与 legacy `tools/memory.ts`（LangChain tool + Zod）同名同语义，execute 复用
 * 同一 MemoryStore，仅把 schema 从 Zod 迁移为 TypeBox、把 tool 包装为
 * pi-coding-agent 的 defineTool。
 */
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  MEMORY_CONFIDENCES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type MemoryStore,
} from "../store/memory.ts";

export interface MemoryPiToolContext {
  store: MemoryStore;
  currentSessionId: () => string | undefined;
  modelName?: string;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function createMemoryPiTools(context: MemoryPiToolContext): ToolDefinition[] {
  const scopeEnum = StringEnum([...MEMORY_SCOPES] as const);
  const typeEnum = StringEnum([...MEMORY_TYPES] as const);
  const confidenceEnum = StringEnum([...MEMORY_CONFIDENCES] as const);

  const memorySearch: ToolDefinition = defineTool({
    name: "memory_search",
    label: "检索长期记忆",
    description: "检索用户已审核的长期记忆，包括用户偏好、纠错反馈、项目事实、参考资料和工作日志。",
    parameters: Type.Object({
      query: Type.String({ description: "检索词或当前任务描述", minLength: 1 }),
      scope: Type.Optional(scopeEnum),
      type: Type.Optional(typeEnum),
      limit: Type.Optional(
        Type.Integer({ description: "最多返回条数，默认 8", minimum: 1, maximum: 20 }),
      ),
    }),
    async execute(_toolCallId, params) {
      const matches = context.store.search(params.query, {
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.type ? { type: params.type } : {}),
        limit: params.limit ?? 8,
        includeUnreviewed: false,
      });
      return {
        content: [
          {
            type: "text",
            text: json({
              query: params.query,
              matches: matches.map((match) => ({
                slug: match.meta.slug,
                scope: match.meta.scope,
                type: match.meta.type,
                headline: match.meta.headline,
                description: match.meta.description,
                body: match.body,
                score: Number(match.score.toFixed(3)),
              })),
            }),
          },
        ],
        details: {},
      };
    },
  });

  const memoryPropose: ToolDefinition = defineTool({
    name: "memory_propose",
    label: "提议长期记忆",
    description:
      "提议一条需要跨会话保留的长期记忆。只用于稳定的用户偏好、明确纠错、项目约定或可复用事实；写入后处于待审核状态，不会自动注入模型。",
    parameters: Type.Object({
      slug: Type.String({
        description: "稳定、简短的记忆标识，推荐 kebab-case",
        minLength: 1,
        maxLength: 80,
      }),
      scope: scopeEnum,
      type: StringEnum(["user", "feedback", "project", "reference"] as const),
      description: Type.String({ description: "一句话摘要", minLength: 1, maxLength: 240 }),
      headline: Type.String({ description: "简短标题", minLength: 1, maxLength: 120 }),
      body: Type.String({
        description: "完整、独立可理解的记忆正文",
        minLength: 1,
        maxLength: 8_000,
      }),
      confidence: Type.Optional(confidenceEnum),
    }),
    async execute(_toolCallId, params) {
      const result = context.store.write({
        slug: params.slug,
        scope: params.scope,
        type: params.type,
        description: params.description,
        headline: params.headline,
        body: params.body,
        confidence: params.confidence ?? "unknown",
        actor: "tool",
        conversationId: context.currentSessionId(),
        model: context.modelName,
        unreviewed: true,
      });
      return {
        content: [
          {
            type: "text",
            text: json({
              proposed: true,
              created: result.created,
              slug: result.meta.slug,
              scope: result.meta.scope,
              type: result.meta.type,
              headline: result.meta.headline,
              unreviewed: result.meta.unreviewed,
              next: `请提示用户运行 /memory accept ${result.meta.slug} 或 /memory review 进行审核。`,
            }),
          },
        ],
        details: {},
      };
    },
  });

  const memoryDailyAppend: ToolDefinition = defineTool({
    name: "memory_daily_append",
    label: "记录今日工作日志",
    description:
      "提议把具有后续价值的工作事项记入今日日志。提议需用户审核后才会参与召回；不要记录临时错误、搜索结果或秘密。",
    parameters: Type.Object({
      bullet: Type.String({
        description: "一条简洁、可复用的工作记录",
        minLength: 1,
        maxLength: 1_000,
      }),
      scope: Type.Optional(scopeEnum),
    }),
    async execute(_toolCallId, params) {
      const entry = context.store.appendDaily(params.bullet, {
        scope: params.scope ?? "project",
        actor: "tool",
        conversationId: context.currentSessionId(),
      });
      return {
        content: [
          {
            type: "text",
            text: json({
              proposed: true,
              slug: entry.meta.slug,
              scope: entry.meta.scope,
              date: entry.meta.date,
              unreviewed: entry.meta.unreviewed,
              next: `请提示用户运行 /memory accept ${entry.meta.slug} 或 /memory review 进行审核。`,
            }),
          },
        ],
        details: {},
      };
    },
  });

  const memoryList: ToolDefinition = defineTool({
    name: "memory_list",
    label: "列出长期记忆",
    description: "列出长期记忆元数据。默认只返回已审核记忆。",
    parameters: Type.Object({
      scope: Type.Optional(scopeEnum),
      type: Type.Optional(typeEnum),
      limit: Type.Optional(
        Type.Integer({ description: "最多返回条数，默认 30", minimum: 1, maximum: 100 }),
      ),
    }),
    async execute(_toolCallId, params) {
      const entries = context.store.list({
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.type ? { type: params.type } : {}),
        limit: params.limit ?? 30,
        includeUnreviewed: false,
      });
      return {
        content: [
          {
            type: "text",
            text: json({
              entries: entries.map((entry) => ({
                slug: entry.slug,
                scope: entry.scope,
                type: entry.type,
                headline: entry.headline,
                description: entry.description,
                unreviewed: entry.unreviewed,
                updatedAt: new Date(entry.updatedAt).toISOString(),
              })),
            }),
          },
        ],
        details: {},
      };
    },
  });

  const memoryRead: ToolDefinition = defineTool({
    name: "memory_read",
    label: "读取长期记忆",
    description: "按 slug 读取一条已审核长期记忆的完整内容。",
    parameters: Type.Object({
      slug: Type.String({ description: "记忆 slug", minLength: 1 }),
      scope: Type.Optional(scopeEnum),
    }),
    async execute(_toolCallId, params) {
      const entry = context.store.read(params.slug, params.scope);
      if (!entry || entry.meta.unreviewed) {
        return {
          content: [{ type: "text", text: json({ error: `未找到已审核记忆: ${params.slug}` }) }],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text",
            text: json({
              meta: {
                slug: entry.meta.slug,
                scope: entry.meta.scope,
                type: entry.meta.type,
                headline: entry.meta.headline,
                description: entry.meta.description,
                confidence: entry.meta.confidence,
                updatedAt: new Date(entry.meta.updatedAt).toISOString(),
              },
              body: entry.body,
            }),
          },
        ],
        details: {},
      };
    },
  });

  return [memorySearch, memoryPropose, memoryDailyAppend, memoryList, memoryRead];
}
