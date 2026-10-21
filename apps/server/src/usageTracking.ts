import { AsyncLocalStorage } from "node:async_hooks";
import { recordUsageEvent, type UsageSource } from "./usage.js";

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

interface UsageContext {
  source: UsageSource;
  workspaceId?: string;
  sessionId?: string | null;
  parent?: UsageContext;
  usage: UsageSnapshot;
  models: Map<string, ModelUsage>;
  onUsage?: (usage: UsageSnapshot) => void;
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

function publish(context: UsageContext): void {
  context.onUsage?.({ ...context.usage });
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
  const entry = context.models.get(key) ?? {
    providerId,
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    failed: false,
  };
  context.models.set(key, entry);
  entry.requests += 1;
  for (let scope: UsageContext | undefined = context; scope; scope = scope.parent) {
    scope.usage.requests += 1;
    publish(scope);
  }
  const startedAt = Date.now();
  try {
    const result = await run();
    const finite = (value: number | undefined) =>
      Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : 0;
    const inputTokens = finite(result.tokenUsage?.inputTokens);
    const outputTokens = finite(result.tokenUsage?.outputTokens);
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    for (let scope: UsageContext | undefined = context; scope; scope = scope.parent) {
      scope.usage.inputTokens += inputTokens;
      scope.usage.outputTokens += outputTokens;
      scope.usage.totalTokens += inputTokens + outputTokens;
      publish(scope);
    }
    return result;
  } catch (error) {
    entry.failed = true;
    throw error;
  } finally {
    entry.durationMs += Date.now() - startedAt;
  }
}

export function recordToolCall(failed = false): void {
  const context = storage.getStore();
  if (!context) return;
  context.usage.toolCalls += 1;
  if (failed) context.usage.toolErrors += 1;
  publish(context);
}
