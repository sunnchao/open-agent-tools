import assert from "node:assert/strict";
import test from "node:test";

import type { ToolExecutionJob } from "@open-agent-tools/mcp-contracts";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";

import { createDockerClient, DockerToolContainerRuntime } from "../infrastructure/docker/docker-runtime.js";
import { createToolExecutionWorker, TOOL_EXECUTION_QUEUE } from "./execution-queue.js";

const redisUrl = process.env.TEST_REDIS_URL;
const imageDigest = process.env.TEST_TOOL_IMAGE_DIGEST;

test(
  "E2E-001 runs a queued Tool job in an isolated container",
  { skip: !redisUrl || !imageDigest },
  async () => {
    const queueConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const eventConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = new Queue<ToolExecutionJob>(TOOL_EXECUTION_QUEUE, {
      connection: queueConnection,
    });
    const events = new QueueEvents(TOOL_EXECUTION_QUEUE, { connection: eventConnection });
    const runtime = new DockerToolContainerRuntime(await createDockerClient(), {
      imageRepository: "",
    });
    const worker = createToolExecutionWorker(redisUrl!, runtime, 1);
    const requestId = `request-queue-e2e-${Date.now()}`;
    const jobData: ToolExecutionJob = {
      requestId,
      serviceId: "service-1",
      versionId: "version-1",
      imageDigest: imageDigest!,
      toolName: "echo",
      arguments: { value: "queue-e2e-ok" },
      context: {
        clientId: "client-1",
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      },
      limits: {
        timeoutMs: 30_000,
        memoryMb: 256,
        cpuMillis: 1_000,
        network: "none",
      },
    };

    try {
      await Promise.all([events.waitUntilReady(), queue.waitUntilReady()]);
      const job = await queue.add("execute-tool", jobData, {
        jobId: requestId,
        attempts: 1,
      });
      const result = CallToolResultSchema.parse(await job.waitUntilFinished(events, 35_000));

      assert.deepEqual(result.content, [{ type: "text", text: "queue-e2e-ok" }]);
      assert.deepEqual(result.structuredContent, { requestId });
      assert.equal(result.isError, false);
    } finally {
      await Promise.all([worker.close(), queue.close(), events.close()]);
      queueConnection.disconnect();
      eventConnection.disconnect();
    }
  },
);
