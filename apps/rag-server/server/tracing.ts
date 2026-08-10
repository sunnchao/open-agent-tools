/**
 * Langfuse tracing 的安全包装：未启用时退化为 no-op。
 * 请求级 trace 根（startActiveObservation）会自动收纳 LangChain CallbackHandler 创建的子 observation。
 */
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { tracingEnabled } from "./instrumentation.js";

export interface ObservationHandle {
  update(attributes: Record<string, unknown>): void;
  end(): void;
}

const noopHandle: ObservationHandle = { update: () => undefined, end: () => undefined };

/** 创建一条 Langfuse trace（根 observation）。未启用时直接执行 fn。 */
export async function runTraced<T>(
  name: string,
  fn: (span: ObservationHandle) => Promise<T> | T,
): Promise<T> {
  if (!tracingEnabled) return fn(noopHandle);
  return startActiveObservation(name, async (span) =>
    fn({ update: (attributes) => span.update(attributes as never), end: () => span.end() }),
  );
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
