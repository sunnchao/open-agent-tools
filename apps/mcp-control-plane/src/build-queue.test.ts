import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactInspectionJob } from "@open-agent-tools/mcp-contracts";

import { BullMqArtifactInspectionQueue, type BuildQueue } from "./build-queue.js";

const job: ArtifactInspectionJob = {
  buildJobId: "build-1",
  serviceId: "service-1",
  versionId: "version-1",
  versionRevision: 2,
  objectKey: "service-1/version-1/artifact.zip",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  artifactSize: 1024,
};

test("ZIP-001 dispatches an idempotent artifact inspection job", async () => {
  const calls: unknown[][] = [];
  const queue: BuildQueue = {
    add: async (...args) => {
      calls.push(args);
    },
  };

  await new BullMqArtifactInspectionQueue(queue).enqueueInspection(job);

  assert.deepEqual(calls, [
    [
      "inspect-artifact",
      job,
      {
        jobId: job.buildJobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    ],
  ]);
});

test("BLD-001 dispatches a durable Tool build job with the same idempotency key", async () => {
  const calls: unknown[][] = [];
  const queue: BuildQueue = {
    add: async (...args) => {
      calls.push(args);
    },
  };

  await new BullMqArtifactInspectionQueue(queue).enqueueBuild(job);

  assert.deepEqual(calls[0], [
    "build-tool",
    job,
    {
      jobId: job.buildJobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  ]);
});
