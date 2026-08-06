import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactInspectionJob } from "@open-agent-tools/mcp-contracts";

import {
  createArtifactInspectionProcessor,
  createBuildQueueProcessor,
  type ArtifactInspectionProcessorService,
} from "./build-queue.js";

const job: ArtifactInspectionJob = {
  buildJobId: "build-1",
  serviceId: "service-1",
  versionId: "version-1",
  versionRevision: 2,
  objectKey: "service-1/version-1/artifact.zip",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  artifactSize: 1024,
};

test("BLD-001 forwards a validated inspection payload to the coordinator", async () => {
  const received: ArtifactInspectionJob[] = [];
  const service: ArtifactInspectionProcessorService = {
    inspect: async (input) => {
      received.push(input);
      return { status: "SUCCEEDED" };
    },
  };
  const result = await createArtifactInspectionProcessor(service)({ data: job });

  assert.deepEqual(result, { status: "SUCCEEDED" });
  assert.deepEqual(received, [job]);
});

test("BLD-001 rejects malformed queue data before invoking the coordinator", async () => {
  let called = false;
  const service: ArtifactInspectionProcessorService = {
    inspect: async () => {
      called = true;
      return { status: "SUCCEEDED" };
    },
  };

  await assert.rejects(
    createArtifactInspectionProcessor(service)({ data: { ...job, artifactSize: 0 } }),
    /too small|positive/i,
  );
  assert.equal(called, false);
});

test("BLD-001 routes INSPECT and BUILD names to the matching coordinator", async () => {
  const calls: string[] = [];
  const processor = createBuildQueueProcessor({
    inspection: {
      inspect: async () => {
        calls.push("inspect");
        return { status: "SUCCEEDED" };
      },
    },
    build: {
      build: async () => {
        calls.push("build");
        return { status: "SUCCEEDED", imageDigest: `sha256:${"b".repeat(64)}` };
      },
    },
  });

  await processor({ name: "inspect-artifact", data: job });
  await processor({ name: "build-tool", data: job });
  assert.deepEqual(calls, ["inspect", "build"]);
});

test("BLD-001 rejects unknown build queue job names", async () => {
  const processor = createBuildQueueProcessor({
    inspection: { inspect: async () => ({ status: "SUCCEEDED" }) },
    build: { build: async () => ({ status: "SUCCEEDED" }) },
  });
  await assert.rejects(processor({ name: "unknown", data: job }), /Unknown build queue job/);
});
