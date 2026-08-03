import { ToolExecutionJobSchema } from "@open-agent-tools/mcp-contracts";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";

import type { ToolExecutionRequest, ToolExecutor } from "./tool-executor.js";

export const TOOL_EXECUTION_QUEUE = "mcp-tool-execution";

export interface ExecutionJobHandle {
  waitUntilFinished(events: object, ttl: number): Promise<unknown>;
}

export interface ExecutionQueue {
  add(
    name: string,
    data: ToolExecutionRequest,
    options: {
      jobId: string;
      attempts: number;
      removeOnComplete: number;
      removeOnFail: number;
    },
  ): Promise<ExecutionJobHandle>;
}

export interface BullMqToolExecutorOptions {
  completionGraceMs?: number;
}

export class BullMqToolExecutor implements ToolExecutor {
  readonly #queue: ExecutionQueue;
  readonly #events: object;
  readonly #completionGraceMs: number;

  constructor(queue: ExecutionQueue, events: object, options: BullMqToolExecutorOptions = {}) {
    this.#queue = queue;
    this.#events = events;
    this.#completionGraceMs = options.completionGraceMs ?? 5_000;
  }

  async execute(request: ToolExecutionRequest): Promise<CallToolResult> {
    const parsedRequest = ToolExecutionJobSchema.parse(request);
    const job = await this.#queue.add("execute-tool", parsedRequest, {
      jobId: parsedRequest.requestId,
      attempts: 1,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
    const output = await job.waitUntilFinished(
      this.#events,
      parsedRequest.limits.timeoutMs + this.#completionGraceMs,
    );
    const result = CallToolResultSchema.safeParse(output);
    if (!result.success) {
      throw new Error("Execution worker returned an invalid MCP result");
    }
    return result.data;
  }
}

export function createBullMqToolExecutor(redisUrl: string): {
  executor: BullMqToolExecutor;
  close: () => Promise<void>;
} {
  const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const eventConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<ToolExecutionRequest>(TOOL_EXECUTION_QUEUE, {
    connection: queueConnection,
  });
  const events = new QueueEvents(TOOL_EXECUTION_QUEUE, { connection: eventConnection });

  return {
    executor: new BullMqToolExecutor(queue, events),
    close: async () => {
      await Promise.all([queue.close(), events.close()]);
      queueConnection.disconnect();
      eventConnection.disconnect();
    },
  };
}
