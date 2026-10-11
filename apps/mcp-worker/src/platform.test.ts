import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { ArtifactInspectionJob } from "@open-agent-tools/mcp-contracts";

import { BullMqArtifactInspectionQueue, type BuildQueue } from "./control-plane/build-queue.js";
import { createBuildQueueProcessor } from "./workers/build-queue.js";

test("management queue jobs remain asynchronous and compatible with the background Worker", async () => {
  const job: ArtifactInspectionJob = {
    buildJobId: "build-1",
    serviceId: "service-1",
    versionId: "version-1",
    versionRevision: 2,
    objectKey: "service-1/version-1/artifact.zip",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    artifactSize: 1024,
  };
  const queued: Array<{ name: string; data: ArtifactInspectionJob }> = [];
  const queue: BuildQueue = {
    add: async (name, data, options) => {
      assert.equal(options.jobId, data.buildJobId);
      queued.push({ name, data });
    },
  };
  const processed: Array<{ kind: string; data: ArtifactInspectionJob }> = [];
  const processor = createBuildQueueProcessor({
    inspection: {
      inspect: async (data) => {
        processed.push({ kind: "INSPECT", data });
        return { status: "SUCCEEDED" };
      },
    },
    build: {
      build: async (data) => {
        processed.push({ kind: "BUILD", data });
        return { status: "SUCCEEDED" };
      },
    },
  });
  const managementQueue = new BullMqArtifactInspectionQueue(queue);
  const buildJob = { ...job, buildJobId: "build-2" };

  await managementQueue.enqueueInspection(job);
  await managementQueue.enqueueBuild(buildJob);
  assert.deepEqual(processed, []);

  for (const queuedJob of queued) {
    assert.deepEqual(await processor(queuedJob), { status: "SUCCEEDED" });
  }
  assert.deepEqual(processed, [
    { kind: "INSPECT", data: job },
    { kind: "BUILD", data: buildJob },
  ]);
});

test("legacy migration paths resolve to the merged migration history without changing mcp-server", async () => {
  const migrations = resolve(import.meta.dirname, "../drizzle");
  const legacyMigrations = resolve(import.meta.dirname, "../../mcp-control-plane/drizzle");
  assert.equal(await realpath(legacyMigrations), await realpath(migrations));

  const journal = JSON.parse(await readFile(resolve(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  assert.ok(journal.entries.length > 0);
  for (const { tag } of journal.entries) {
    const migration = await readFile(resolve(migrations, `${tag}.sql`));
    assert.deepEqual(await readFile(resolve(legacyMigrations, `${tag}.sql`)), migration);
  }
});
