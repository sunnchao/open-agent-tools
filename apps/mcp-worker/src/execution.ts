import { ToolExecutionJobSchema, type ToolExecutionJob } from "@open-agent-tools/mcp-contracts";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Worker } from "bullmq";
import { Redis } from "ioredis";

export const TOOL_EXECUTION_QUEUE = "mcp-tool-execution";

export interface ToolContainerRuntime {
  execute(job: ToolExecutionJob): Promise<unknown>;
}

export class ToolExecutionProcessor {
  readonly #runtime: ToolContainerRuntime;

  constructor(runtime: ToolContainerRuntime) {
    this.#runtime = runtime;
  }

  async process(input: unknown): Promise<CallToolResult> {
    const job = ToolExecutionJobSchema.parse(input);
    const output = await this.#runtime.execute(job);
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
): { close: () => Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const processor = new ToolExecutionProcessor(runtime);
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
