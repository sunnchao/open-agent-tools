import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
  MEMORY_CONFIDENCES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type MemoryStore,
} from "../store/memory.ts";

export interface MemoryToolContext {
  store: MemoryStore;
  currentSessionId: () => string | undefined;
  modelName?: string;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function createMemoryTools(context: MemoryToolContext): StructuredToolInterface[] {
  const memorySearch = tool(
    async ({ query, scope, type, limit }) => {
      const matches = context.store.search(query, {
        ...(scope ? { scope } : {}),
        ...(type ? { type } : {}),
        limit: limit ?? 8,
        includeUnreviewed: false,
      });
      return json({
        query,
        matches: matches.map((match) => ({
          slug: match.meta.slug,
          scope: match.meta.scope,
          type: match.meta.type,
          headline: match.meta.headline,
          description: match.meta.description,
          body: match.body,
          score: Number(match.score.toFixed(3)),
        })),
      });
    },
    {
      name: "memory_search",
      description:
        "检索用户已审核的长期记忆，包括用户偏好、纠错反馈、项目事实、参考资料和工作日志。",
      schema: z.object({
        query: z.string().min(1).describe("检索词或当前任务描述"),
        scope: z.enum(MEMORY_SCOPES).optional().describe("可选作用域过滤"),
        type: z.enum(MEMORY_TYPES).optional().describe("可选记忆类型过滤"),
        limit: z.number().int().min(1).max(20).optional().describe("最多返回条数，默认 8"),
      }),
    },
  );

  const memoryPropose = tool(
    async ({ slug, scope, type, description, headline, body, confidence }) => {
      const result = context.store.write({
        slug,
        scope,
        type,
        description,
        headline,
        body,
        confidence: confidence ?? "unknown",
        actor: "tool",
        conversationId: context.currentSessionId(),
        model: context.modelName,
        unreviewed: true,
      });
      return json({
        proposed: true,
        created: result.created,
        slug: result.meta.slug,
        scope: result.meta.scope,
        type: result.meta.type,
        headline: result.meta.headline,
        unreviewed: result.meta.unreviewed,
        next: `请提示用户运行 /memory accept ${result.meta.slug} 或 /memory review 进行审核。`,
      });
    },
    {
      name: "memory_propose",
      description:
        "提议一条需要跨会话保留的长期记忆。只用于稳定的用户偏好、明确纠错、项目约定或可复用事实；写入后处于待审核状态，不会自动注入模型。",
      schema: z.object({
        slug: z.string().min(1).max(80).describe("稳定、简短的记忆标识，推荐 kebab-case"),
        scope: z.enum(MEMORY_SCOPES).describe("global 跨项目；project 仅当前工作目录"),
        type: z.enum(["user", "feedback", "project", "reference"] as const).describe("记忆类型"),
        description: z.string().min(1).max(240).describe("一句话摘要"),
        headline: z.string().min(1).max(120).describe("简短标题"),
        body: z.string().min(1).max(8_000).describe("完整、独立可理解的记忆正文"),
        confidence: z.enum(MEMORY_CONFIDENCES).optional().describe("事实可靠度"),
      }),
    },
  );

  const memoryDailyAppend = tool(
    async ({ bullet, scope }) => {
      const entry = context.store.appendDaily(bullet, {
        scope: scope ?? "project",
        actor: "tool",
        conversationId: context.currentSessionId(),
      });
      return json({
        proposed: true,
        slug: entry.meta.slug,
        scope: entry.meta.scope,
        date: entry.meta.date,
        unreviewed: entry.meta.unreviewed,
        next: `请提示用户运行 /memory accept ${entry.meta.slug} 或 /memory review 进行审核。`,
      });
    },
    {
      name: "memory_daily_append",
      description:
        "提议把具有后续价值的工作事项记入今日日志。提议需用户审核后才会参与召回；不要记录临时错误、搜索结果或秘密。",
      schema: z.object({
        bullet: z.string().min(1).max(1_000).describe("一条简洁、可复用的工作记录"),
        scope: z.enum(MEMORY_SCOPES).optional().describe("默认 project"),
      }),
    },
  );

  const memoryList = tool(
    async ({ scope, type, limit }) => {
      const entries = context.store.list({
        ...(scope ? { scope } : {}),
        ...(type ? { type } : {}),
        limit: limit ?? 30,
        includeUnreviewed: false,
      });
      return json({
        entries: entries.map((entry) => ({
          slug: entry.slug,
          scope: entry.scope,
          type: entry.type,
          headline: entry.headline,
          description: entry.description,
          unreviewed: entry.unreviewed,
          updatedAt: new Date(entry.updatedAt).toISOString(),
        })),
      });
    },
    {
      name: "memory_list",
      description: "列出长期记忆元数据。默认只返回已审核记忆。",
      schema: z.object({
        scope: z.enum(MEMORY_SCOPES).optional(),
        type: z.enum(MEMORY_TYPES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
  );

  const memoryRead = tool(
    async ({ slug, scope }) => {
      const entry = context.store.read(slug, scope);
      if (!entry || entry.meta.unreviewed) return json({ error: `未找到已审核记忆: ${slug}` });
      return json({
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
      });
    },
    {
      name: "memory_read",
      description: "按 slug 读取一条已审核长期记忆的完整内容。",
      schema: z.object({
        slug: z.string().min(1),
        scope: z.enum(MEMORY_SCOPES).optional(),
      }),
    },
  );

  return [memorySearch, memoryPropose, memoryDailyAppend, memoryList, memoryRead];
}
