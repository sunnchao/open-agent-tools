import { ToolExecutionJobSchema } from "@open-agent-tools/mcp-contracts";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Queue, QueueEvents } from "bullmq";
import {
  createRedisClient,
  describeRedisError,
  type Redis,
} from "@open-agent-tools/database/redis";

import type { ToolExecutionRequest, ToolExecutor } from "./tool-executor.js";

export const TOOL_EXECUTION_QUEUE = "mcp-tool-execution";

/** 启动时等待 Redis 就绪的时限。 */
const REDIS_CONNECT_TIMEOUT_MS = 5_000;

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

/** 等待单个 ioredis 连接就绪；失败或超时时给出明确原因。 */
async function waitUntilReady(client: Redis, label: string): Promise<void> {
  if (client.status === "ready") return;
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      client.once("ready", () => resolve());
      client.once("error", (error) => reject(error));
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} 连接超时（${REDIS_CONNECT_TIMEOUT_MS}ms 内未就绪）`));
      }, REDIS_CONNECT_TIMEOUT_MS);
    }),
  ]);
}

export async function createBullMqToolExecutor(redisUrl: string): Promise<{
  executor: BullMqToolExecutor;
  close: () => Promise<void>;
}> {
  // createRedisClient 恒返回单机 Redis 客户端（非 Cluster），此处收窄类型以便等待就绪。
  const queueConnection = createRedisClient(redisUrl, {
    maxRetriesPerRequest: null,
  }).client as Redis;
  const eventConnection = createRedisClient(redisUrl, {
    maxRetriesPerRequest: null,
  }).client as Redis;
  try {
    await Promise.all([
      waitUntilReady(queueConnection, "队列连接"),
      waitUntilReady(eventConnection, "事件连接"),
    ]);
  } catch (error) {
    queueConnection.disconnect();
    eventConnection.disconnect();
    throw new Error(`Redis 不可达（${redisUrl}）：${describeRedisError(error)}`);
  }

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
