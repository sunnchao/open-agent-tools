import { AsyncLocalStorage } from "node:async_hooks";
import { nonNegativeInteger } from "@open-agent-tools/api-contracts/values";
import { recordUsageEvent, type UsageSource } from "./events.js";

export interface UsageSnapshot {
  /** Model calls, not conversation turns; calls without token metadata are still counted. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
}

interface ModelUsage {
  providerId: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  failed: boolean;
}

/** 逐模型用量明细（审计展示用）；含嵌套链路（如 SQL 问数）调用的模型。 */
export interface UsageModelDetail {
  providerId: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  failed: boolean;
}

interface UsageContext {
  source: UsageSource;
  workspaceId?: string;
  sessionId?: string | null;
  parent?: UsageContext;
  usage: UsageSnapshot;
  /** 当前作用域自己的模型用量（用于落 usage_events，嵌套链路不重复记账）。 */
  models: Map<string, ModelUsage>;
  /** 整轮（含嵌套链路）的模型用量聚合：根上下文创建，子上下文共享同一引用。 */
  allModels: Map<string, ModelUsage>;
  /** 第二参数为逐模型明细（含嵌套链路），供 SSE 与审计使用。 */
  onUsage?: (usage: UsageSnapshot, models: UsageModelDetail[]) => void;
}

function newModelUsage(providerId: string, model: string): ModelUsage {
  return {
    providerId,
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    failed: false,
  };
}

const storage = new AsyncLocalStorage<UsageContext>();

export function currentUsageWorkspaceId(): string | undefined {
  return storage.getStore()?.workspaceId;
}

export function currentUsage(): UsageSnapshot {
  return (
    storage.getStore()?.usage ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      toolErrors: 0,
    }
  );
}

/**
 * 当前用量上下文中逐模型的明细快照，供 SSE `usage` 帧与 IM 审计使用。
 *
 * 从根上下文到嵌套上下文逐层合并：同一 provider/model 在 chat 与 SQL 问数
 * 等子链路中的调用会累加，便于审计回答"这轮到底用了哪些模型、各花多少 token"。
 * 必须在 `trackUsage` 作用域内调用；作用域外返回空数组。
 */
export function currentUsageModels(): UsageModelDetail[] {
  let root = storage.getStore();
  if (!root) return [];
  while (root.parent) root = root.parent;
  // allModels 由根上下文创建并被所有子上下文共享，已结束的嵌套链路也在其中。
  return [...root.allModels.values()].map((entry) => ({
    providerId: entry.providerId,
    model: entry.model,
    requests: entry.requests,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    totalTokens: entry.inputTokens + entry.outputTokens,
    durationMs: entry.durationMs,
    failed: entry.failed,
  }));
}

function publish(context: UsageContext): void {
  context.onUsage?.({ ...context.usage }, currentUsageModels());
}

export async function trackUsage<T>(
  options: Pick<UsageContext, "source" | "workspaceId" | "sessionId" | "onUsage">,
  run: () => Promise<T>,
): Promise<T> {
  const parent = storage.getStore();
  const context: UsageContext = {
    ...options,
    workspaceId: options.workspaceId ?? parent?.workspaceId,
    sessionId: options.sessionId ?? parent?.sessionId,
    parent,
    usage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      toolErrors: 0,
    },
    models: new Map(),
    allModels: parent?.allModels ?? new Map(),
  };
  return storage.run(context, async () => {
    let failed = false;
    try {
      const result = await run();
      failed = Boolean(result && typeof result === "object" && "error" in result && result.error);
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      for (const model of context.models.values()) {
        recordUsageEvent({
          kind: "chat",
          source: context.source,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          ...model,
          status: failed || model.failed ? "error" : "ok",
        });
      }
      publish(context);
    }
  });
}

/** Nested operations contribute to the displayed total, but persist only their own requests. */
export async function trackLlmRequest<
  T extends {
    tokenUsage?: { inputTokens: number; outputTokens: number };
  },
>(providerId: string, model: string, run: () => Promise<T>): Promise<T> {
  const context = storage.getStore();
  if (!context) return run();
  const key = JSON.stringify([providerId, model]);
  const entry = context.models.get(key) ?? newModelUsage(providerId, model);
  context.models.set(key, entry);
  // 聚合表与 models 分开维护：models 只为当前作用域落 usage_events，allModels 汇总整轮。
  const aggregate = context.allModels.get(key) ?? newModelUsage(providerId, model);
  context.allModels.set(key, aggregate);
  entry.requests += 1;
  aggregate.requests += 1;
  for (let scope: UsageContext | undefined = context; scope; scope = scope.parent) {
    scope.usage.requests += 1;
    publish(scope);
  }
  const startedAt = Date.now();
  try {
    const result = await run();
    const inputTokens = nonNegativeInteger(result.tokenUsage?.inputTokens);
    const outputTokens = nonNegativeInteger(result.tokenUsage?.outputTokens);
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    aggregate.inputTokens += inputTokens;
    aggregate.outputTokens += outputTokens;
    for (let scope: UsageContext | undefined = context; scope; scope = scope.parent) {
      scope.usage.inputTokens += inputTokens;
      scope.usage.outputTokens += outputTokens;
      scope.usage.totalTokens += inputTokens + outputTokens;
      publish(scope);
    }
    return result;
  } catch (error) {
    entry.failed = true;
    aggregate.failed = true;
    throw error;
  } finally {
    const elapsed = Date.now() - startedAt;
    entry.durationMs += elapsed;
    aggregate.durationMs += elapsed;
  }
}

export function recordToolCall(failed = false): void {
  const context = storage.getStore();
  if (!context) return;
  context.usage.toolCalls += 1;
  if (failed) context.usage.toolErrors += 1;
  publish(context);
}
