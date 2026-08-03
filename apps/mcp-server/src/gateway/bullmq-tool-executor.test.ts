import assert from "node:assert/strict";
import test from "node:test";

import {
  BullMqToolExecutor,
  type ExecutionJobHandle,
  type ExecutionQueue,
} from "./bullmq-tool-executor.js";
import type { ToolExecutionRequest } from "./tool-executor.js";

const request: ToolExecutionRequest = {
  requestId: "request-1",
  serviceId: "service-1",
  versionId: "version-1",
  imageDigest: `sha256:${"a".repeat(64)}`,
  toolName: "get_report",
  arguments: { id: "report-1" },
  context: {
    clientId: "client-1",
    deadlineAt: "2026-07-31T12:00:30.000Z",
  },
  limits: {
    timeoutMs: 30_000,
    memoryMb: 256,
    cpuMillis: 1_000,
    network: "none",
  },
};

test("GW-006 enqueues exactly one non-retried execution and validates its result", async () => {
  const calls: unknown[][] = [];
  const job: ExecutionJobHandle = {
    waitUntilFinished: async (_events, ttl) => {
      assert.equal(ttl, 31_000);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const queue: ExecutionQueue = {
    add: async (...args) => {
      calls.push(args);
      return job;
    },
  };
  const executor = new BullMqToolExecutor(queue, {}, { completionGraceMs: 1_000 });

  const result = await executor.execute(request);

  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "execute-tool",
    request,
    {
      jobId: request.requestId,
      attempts: 1,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  ]);
});

test("GW-011 rejects malformed worker output", async () => {
  const queue: ExecutionQueue = {
    add: async () => ({
      waitUntilFinished: async () => ({ content: [{ type: "unknown" }] }),
    }),
  };
  const executor = new BullMqToolExecutor(queue, {});

  await assert.rejects(executor.execute(request), /invalid MCP result/);
});
