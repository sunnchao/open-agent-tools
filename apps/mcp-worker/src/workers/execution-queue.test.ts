import assert from "node:assert/strict";
import test from "node:test";

import type { ToolExecutionJob } from "@open-agent-tools/mcp-contracts";
import { ToolExecutionProcessor, type ToolContainerRuntime } from "./execution-queue.js";

const job: ToolExecutionJob = {
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

test("RUN-001 validates and forwards a pinned execution job", async () => {
  const received: ToolExecutionJob[] = [];
  const runtime: ToolContainerRuntime = {
    execute: async (input) => {
      received.push(input);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };

  const result = await new ToolExecutionProcessor(runtime).process(job);

  assert.deepEqual(received, [job]);
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
});

test("RUN-001 rejects malformed jobs before container creation", async () => {
  let calls = 0;
  const runtime: ToolContainerRuntime = {
    execute: async () => {
      calls += 1;
      return { content: [] };
    },
  };

  await assert.rejects(
    new ToolExecutionProcessor(runtime).process({ ...job, imageDigest: "latest" }),
  );
  assert.equal(calls, 0);
});

test("RUN-005 rejects malformed container output", async () => {
  const runtime: ToolContainerRuntime = {
    execute: async () => ({ content: [{ type: "unsupported" }] }) as never,
  };

  await assert.rejects(new ToolExecutionProcessor(runtime).process(job), /invalid MCP result/);
});

test("loads current environment per service at execution time without adding secrets to jobs", async () => {
  const environments: Record<string, Record<string, string>> = {
    "service-1": { TAVILY_API_KEY: "first" },
    "service-2": { TAVILY_API_KEY: "other" },
  };
  const received: Array<Record<string, string> | undefined> = [];
  const runtime: ToolContainerRuntime = {
    execute: async (_input, environment) => {
      received.push(environment);
      return { content: [] };
    },
  };
  const processor = new ToolExecutionProcessor(runtime, async (id) => environments[id]!);
  await processor.process(job);
  environments["service-1"] = { TAVILY_API_KEY: "rotated" };
  await processor.process(job);
  await processor.process({ ...job, serviceId: "service-2" });
  assert.deepEqual(received, [
    { TAVILY_API_KEY: "first" },
    { TAVILY_API_KEY: "rotated" },
    { TAVILY_API_KEY: "other" },
  ]);
  assert.equal(Object.hasOwn(job, "environment"), false);
});

test("does not execute the Tool if its environment cannot be loaded", async () => {
  let calls = 0;
  const processor = new ToolExecutionProcessor(
    {
      execute: async () => {
        calls += 1;
        return { content: [] };
      },
    },
    async () => {
      throw new Error("Environment unavailable");
    },
  );
  await assert.rejects(processor.process(job), /Environment unavailable/);
  assert.equal(calls, 0);
});
