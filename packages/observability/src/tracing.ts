/**
 * Langfuse tracing 的安全包装：未启用时全部退化为 no-op，业务代码零侵入。
 * 依赖 instrumentation.ts 中的 langfuseSpanProcessor（SDK 初始化）。
 */
import {
  propagateAttributes,
  startActiveObservation,
  startObservation as startObservationRaw,
} from "@langfuse/tracing";
import { tracingEnabled } from "./instrumentation.js";

export type ObservationKind =
  | "span"
  | "generation"
  | "tool"
  | "retriever"
  | "agent"
  | "chain"
  | "event"
  | "embedding";

export interface ObservationHandle {
  /** 更新当前 observation 的属性（input/output/metadata/usage 等）。 */
  update(attributes: Record<string, unknown>): void;
  /** 结束 observation（仅手动创建的子 observation 需要调用）。 */
  end(): void;
}

const noopHandle: ObservationHandle = {
  update: () => undefined,
  end: () => undefined,
};

/**
 * 创建一条 Langfuse trace（根 observation）。fn 内部创建的 observation 自动嵌套在 trace 下，
 * fn 正常返回时 trace 自动结束。未启用 tracing 时直接执行 fn，零开销。
 */
export async function runTraced<T>(
  name: string,
  fn: (span: ObservationHandle) => Promise<T> | T,
): Promise<T> {
  if (!tracingEnabled) return fn(noopHandle);
  return startActiveObservation(name, async (span) =>
    fn({ update: (attributes) => span.update(attributes as never), end: () => span.end() }),
  );
}

/**
 * 创建子 observation（generation / tool / retriever / span 等）。返回句柄，务必调用 end()。
 * 未启用 tracing 时返回 no-op 句柄。
 */
export function startObservation(
  name: string,
  attributes?: Record<string, unknown>,
  options?: { asType?: ObservationKind },
): ObservationHandle {
  if (!tracingEnabled) return noopHandle;
  const observation = startObservationRaw(name, attributes ?? {}, {
    // asType 为联合类型时 TS 无法选择具体重载，断言为 never 让其匹配任意重载。
    asType: (options?.asType ?? "span") as never,
  });
  return {
    update: (next) => {
      observation.update(next as never);
    },
    end: () => {
      observation.end();
    },
  };
}

/** 为作用域内所有 observation 传播 trace 级属性（sessionId / userId / tags / metadata）。 */
export async function withTraceAttributes<T>(
  attributes: {
    sessionId?: string;
    userId?: string;
    tags?: string[];
    metadata?: Record<string, string>;
    version?: string;
    traceName?: string;
  },
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!tracingEnabled) return fn();
  return propagateAttributes(attributes, fn);
}

/** 截断超长内容，避免把大段文本/对象写入 trace。 */
export function slimValue(value: unknown, maxString = 2000, maxItems = 50): unknown {
  if (typeof value === "string") {
    if (value.length <= maxString) return value;
    return `${value.slice(0, maxString)}…(+${value.length - maxString} chars)`;
  }
  if (Array.isArray(value)) {
    if (value.length <= maxItems) return value.map((item) => slimValue(item, maxString, maxItems));
    return [
      ...value.slice(0, maxItems).map((item) => slimValue(item, maxString, maxItems)),
      `…(+${value.length - maxItems} items)`,
    ];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const slim: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, maxItems)) {
      slim[key] = slimValue(item, maxString, maxItems);
    }
    if (entries.length > maxItems) slim["…"] = `+${entries.length - maxItems} keys`;
    return slim;
  }
  return value;
}
