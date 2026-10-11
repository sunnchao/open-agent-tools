import { ToolExecutionJobSchema, type ToolExecutionJob } from "@open-agent-tools/mcp-contracts";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Worker } from "bullmq";
import { createRedisClient } from "@open-agent-tools/database/redis";

export const TOOL_EXECUTION_QUEUE = "mcp-tool-execution";

export interface ToolContainerRuntime {
  execute(job: ToolExecutionJob, environment?: Record<string, string>): Promise<unknown>;
}

type ToolEnvironmentLoader = (serviceId: string) => Promise<Record<string, string>>;

export class ToolExecutionProcessor {
  readonly #runtime: ToolContainerRuntime;
  readonly #loadEnvironment: ToolEnvironmentLoader;

  constructor(runtime: ToolContainerRuntime, loadEnvironment?: ToolEnvironmentLoader) {
    this.#runtime = runtime;
    this.#loadEnvironment = loadEnvironment ?? (async () => ({}));
  }

  async process(input: unknown): Promise<CallToolResult> {
    const job = ToolExecutionJobSchema.parse(input);
    const environment = await this.#loadEnvironment(job.serviceId);
    const output = await this.#runtime.execute(job, environment);
    const result = CallToolResultSchema.safeParse(output);
    if (!result.success) {
      throw new Error("Tool container returned an invalid MCP result");
    }
    return result.data;
  }
}

export function createToolExecutionWorker(
  redisUrl: string,
  runtime: ToolContainerRuntime,
  concurrency = 4,
  loadEnvironment?: ToolEnvironmentLoader,
): { close: () => Promise<void> } {
  const connection = createRedisClient(redisUrl, { maxRetriesPerRequest: null }).client;
  const processor = new ToolExecutionProcessor(runtime, loadEnvironment);
  const worker = new Worker(TOOL_EXECUTION_QUEUE, async (job) => processor.process(job.data), {
    connection,
    concurrency,
  });

  return {
    close: async () => {
      await worker.close();
      connection.disconnect();
    },
  };
}
