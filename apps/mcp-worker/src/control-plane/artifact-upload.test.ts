import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ArtifactUploadError,
  ArtifactUploadService,
  type ArtifactInspectionQueue,
  type ArtifactObjectMetadata,
  type ArtifactStorage,
  type CreateArtifactUpload,
} from "./artifact-upload.js";
import {
  McpManagementService,
  ManagementError,
  type Actor,
  type IdGenerator,
} from "./management.js";
import { InMemoryMcpManagementRepository } from "./repository.js";

const operator: Actor = { id: "operator-1", role: "operator" };
const auditor: Actor = { id: "auditor-1", role: "auditor" };
const sha256 = `sha256:${"a".repeat(64)}`;
const size = 1024;

function sequentialIds(): IdGenerator {
  let value = 0;
  return () => `id-${++value}`;
}

class FakeStorage implements ArtifactStorage {
  readonly uploads: CreateArtifactUpload[] = [];
  readonly objects = new Map<string, ArtifactObjectMetadata>();

  async createUpload(input: CreateArtifactUpload) {
    this.uploads.push(input);
    return {
      url: "https://objects.example/upload",
      method: "PUT" as const,
      headers: {
        "content-type": "application/zip",
        "x-amz-checksum-sha256": input.checksumSha256Base64,
      },
      expiresAt: input.expiresAt,
    };
  }

  async headObject(objectKey: string): Promise<ArtifactObjectMetadata | null> {
    return this.objects.get(objectKey) ?? null;
  }
}

describe("artifact upload orchestration", () => {
  let repository: InMemoryMcpManagementRepository;
  let management: McpManagementService;
  let storage: FakeStorage;
  let queued: unknown[];
  let queue: ArtifactInspectionQueue;
  let uploads: ArtifactUploadService;
  let serviceId: string;
  let versionId: string;

  beforeEach(async () => {
    repository = new InMemoryMcpManagementRepository();
    management = new McpManagementService(repository, {
      createId: sequentialIds(),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    storage = new FakeStorage();
    queued = [];
    queue = {
      enqueueInspection: async (job) => {
        queued.push(job);
      },
    };
    uploads = new ArtifactUploadService(management, storage, queue, {
      now: () => "2026-07-31T12:00:00.000Z",
      uploadTtlMs: 15 * 60 * 1000,
    });
    const created = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    serviceId = created.service.id;
    versionId = created.draftVersion.id;
  });

  it("ZIP-001 creates a checksum- and size-bound direct upload", async () => {
    const upload = await uploads.requestUpload(
      serviceId,
      versionId,
      { sha256, size },
      operator,
    );

    assert.equal(upload.objectKey, `${serviceId}/${versionId}/${"a".repeat(64)}.zip`);
    assert.equal(upload.upload.method, "PUT");
    assert.equal(upload.upload.expiresAt, "2026-07-31T12:15:00.000Z");
    assert.equal(storage.uploads.length, 1);
    assert.deepEqual(storage.uploads[0], {
      objectKey: upload.objectKey,
      contentType: "application/zip",
      contentLength: size,
      checksumSha256Base64: Buffer.from("a".repeat(64), "hex").toString("base64"),
      expiresAt: "2026-07-31T12:15:00.000Z",
    });
  });

  it("ZIP-001 confirms matching metadata and durably queues one inspection job", async () => {
    const requested = await uploads.requestUpload(
      serviceId,
      versionId,
      { sha256, size },
      operator,
    );
    storage.objects.set(requested.objectKey, { sha256, size });

    const completed = await uploads.completeUpload(
      serviceId,
      versionId,
      {
        objectKey: requested.objectKey,
        sha256,
        size,
        expectedRevision: 1,
      },
      operator,
    );

    assert.equal(completed.dispatched, true);
    assert.equal(completed.version.status, "VALIDATING");
    assert.equal(completed.version.artifactDigest, sha256);
    assert.equal(completed.version.artifactObjectKey, requested.objectKey);
    assert.equal(completed.version.artifactSize, size);
    assert.equal(completed.job.kind, "INSPECT");
    assert.equal(completed.job.status, "QUEUED");
    assert.deepEqual(queued, [
      {
        buildJobId: completed.job.id,
        serviceId,
        versionId,
        versionRevision: completed.version.revision,
        objectKey: requested.objectKey,
        artifactDigest: sha256,
        artifactSize: size,
      },
    ]);
  });

  it("ZIP-002 rejects missing or mismatched objects without creating a job", async () => {
    const requested = await uploads.requestUpload(
      serviceId,
      versionId,
      { sha256, size },
      operator,
    );

    await assert.rejects(
      uploads.completeUpload(
        serviceId,
        versionId,
        {
          objectKey: requested.objectKey,
          sha256,
          size,
          expectedRevision: 1,
        },
        operator,
      ),
      (error: unknown) => error instanceof ArtifactUploadError && error.code === "OBJECT_MISSING",
    );

    for (const metadata of [
      { sha256: `sha256:${"b".repeat(64)}`, size },
      { sha256, size: size + 1 },
    ]) {
      storage.objects.set(requested.objectKey, metadata);
      await assert.rejects(
        uploads.completeUpload(
          serviceId,
          versionId,
          {
            objectKey: requested.objectKey,
            sha256,
            size,
            expectedRevision: 1,
          },
          operator,
        ),
        (error: unknown) =>
          error instanceof ArtifactUploadError && error.code === "OBJECT_MISMATCH",
      );
    }

    assert.equal(repository.buildJobs.size, 0);
    assert.equal((await management.getVersion(versionId, operator)).status, "DRAFT");
  });

  it("ZIP-001 keeps a durable queued job when immediate BullMQ dispatch fails", async () => {
    const requested = await uploads.requestUpload(
      serviceId,
      versionId,
      { sha256, size },
      operator,
    );
    storage.objects.set(requested.objectKey, { sha256, size });
    queue.enqueueInspection = async () => {
      throw new Error("redis unavailable");
    };

    const completed = await uploads.completeUpload(
      serviceId,
      versionId,
      {
        objectKey: requested.objectKey,
        sha256,
        size,
        expectedRevision: 1,
      },
      operator,
    );

    assert.equal(completed.dispatched, false);
    assert.equal(repository.buildJobs.get(completed.job.id)?.status, "QUEUED");
    assert.equal(completed.version.status, "VALIDATING");
  });

  it("ZIP-001 allows a failed version to upload a replacement package", async () => {
    const failed = await management.getVersion(versionId, operator);
    repository.versions.set(versionId, { ...failed, status: "FAILED" });

    const requested = await uploads.requestUpload(
      serviceId,
      versionId,
      { sha256, size },
      operator,
    );
    storage.objects.set(requested.objectKey, { sha256, size });
    const completed = await uploads.completeUpload(
      serviceId,
      versionId,
      {
        objectKey: requested.objectKey,
        sha256,
        size,
        expectedRevision: failed.revision,
      },
      operator,
    );

    assert.equal(completed.version.status, "VALIDATING");
    assert.equal(completed.version.revision, failed.revision + 1);
    assert.equal(completed.job.kind, "INSPECT");
    assert.equal(completed.job.status, "QUEUED");
  });

  it("ZIP-001 allows re-uploading a replacement package while validation is in flight", async () => {
    const first = await uploads.requestUpload(serviceId, versionId, { sha256, size }, operator);
    storage.objects.set(first.objectKey, { sha256, size });
    const initial = await uploads.completeUpload(
      serviceId,
      versionId,
      {
        objectKey: first.objectKey,
        sha256,
        size,
        expectedRevision: 1,
      },
      operator,
    );
    assert.equal(initial.version.status, "VALIDATING");

    const replacementSha = `sha256:${"b".repeat(64)}`;
    const replacement = await uploads.requestUpload(
      serviceId,
      versionId,
      { sha256: replacementSha, size },
      operator,
    );
    storage.objects.set(replacement.objectKey, { sha256: replacementSha, size });
    const recompleted = await uploads.completeUpload(
      serviceId,
      versionId,
      {
        objectKey: replacement.objectKey,
        sha256: replacementSha,
        size,
        expectedRevision: initial.version.revision,
      },
      operator,
    );

    assert.equal(recompleted.version.status, "VALIDATING");
    assert.equal(recompleted.version.artifactDigest, replacementSha);
    assert.equal(recompleted.version.revision, initial.version.revision + 1);
    assert.equal(queued.length, 2);
  });

  it("ZIP-001 rejects uploads for a READY version", async () => {
    const ready = await management.getVersion(versionId, operator);
    repository.versions.set(versionId, { ...ready, status: "READY" });

    await assert.rejects(
      uploads.requestUpload(serviceId, versionId, { sha256, size }, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );
    assert.equal((await management.getVersion(versionId, operator)).status, "READY");
  });

  it("API-002 and API-004 allow operators and reject auditors", async () => {
    await assert.rejects(
      uploads.requestUpload(serviceId, versionId, { sha256, size }, auditor),
      /admin or operator/,
    );
  });
});
