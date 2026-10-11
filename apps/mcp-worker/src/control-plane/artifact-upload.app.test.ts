import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createControlPlaneApp } from "./app.js";
import {
  ArtifactUploadService,
  type ArtifactInspectionQueue,
  type ArtifactObjectMetadata,
  type ArtifactStorage,
  type CreateArtifactUpload,
} from "./artifact-upload.js";
import { McpManagementService, type Actor, type IdGenerator } from "./management.js";
import { InMemoryMcpManagementRepository } from "./repository.js";

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
      headers: { "content-type": "application/zip" },
      expiresAt: input.expiresAt,
    };
  }

  async headObject(objectKey: string): Promise<ArtifactObjectMetadata | null> {
    return this.objects.get(objectKey) ?? null;
  }
}

describe("Control Plane artifact upload HTTP API", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let repository: InMemoryMcpManagementRepository;
  let management: McpManagementService;
  let storage: FakeStorage;
  let queue: ArtifactInspectionQueue;
  let serviceId: string;
  let versionId: string;

  beforeEach(async () => {
    repository = new InMemoryMcpManagementRepository();
    management = new McpManagementService(repository, {
      createId: sequentialIds(),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    storage = new FakeStorage();
    queue = { enqueueInspection: async () => undefined };
    const artifactUploads = new ArtifactUploadService(management, storage, queue, {
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const created = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      { id: "operator-1", role: "operator" },
    );
    serviceId = created.service.id;
    versionId = created.draftVersion.id;

    const app = createControlPlaneApp({
      management,
      artifactUploads,
      authenticate(request): Actor | null {
        const role = request.header("x-test-role");
        if (role !== "admin" && role !== "operator" && role !== "auditor") return null;
        return { id: `${role}-1`, role };
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await closeServer();
  });

  async function request(path: string, body: unknown, role = "operator") {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": role },
      body: JSON.stringify(body),
    });
  }

  it("ZIP-001 issues an upload URL and accepts the completed object for inspection", async () => {
    const uploadResponse = await request(
      `/api/admin/mcp/services/${serviceId}/versions/${versionId}/upload-url`,
      { sha256, size },
    );
    assert.equal(uploadResponse.status, 200);
    const requested = (await uploadResponse.json()) as {
      objectKey: string;
      upload: { method: string; url: string };
    };
    assert.equal(requested.upload.method, "PUT");
    assert.equal(requested.upload.url, "https://objects.example/upload");

    storage.objects.set(requested.objectKey, { sha256, size });
    const completeResponse = await request(
      `/api/admin/mcp/services/${serviceId}/versions/${versionId}/complete-upload`,
      { objectKey: requested.objectKey, sha256, size, expectedRevision: 1 },
    );
    assert.equal(completeResponse.status, 202);
    const completed = (await completeResponse.json()) as {
      dispatched: boolean;
      job: { kind: string; status: string };
      version: { status: string };
    };
    assert.equal(completed.dispatched, true);
    assert.equal(completed.job.kind, "INSPECT");
    assert.equal(completed.job.status, "QUEUED");
    assert.equal(completed.version.status, "VALIDATING");
  });

  it("ZIP-002 maps missing and mismatched objects to stable HTTP errors", async () => {
    const objectKey = `${serviceId}/${versionId}/${"a".repeat(64)}.zip`;
    const input = { objectKey, sha256, size, expectedRevision: 1 };

    const missingResponse = await request(
      `/api/admin/mcp/services/${serviceId}/versions/${versionId}/complete-upload`,
      input,
    );
    assert.equal(missingResponse.status, 404);
    assert.equal(
      ((await missingResponse.json()) as { error: { code: string } }).error.code,
      "OBJECT_MISSING",
    );

    storage.objects.set(objectKey, { sha256: `sha256:${"b".repeat(64)}`, size });
    const mismatchResponse = await request(
      `/api/admin/mcp/services/${serviceId}/versions/${versionId}/complete-upload`,
      input,
    );
    assert.equal(mismatchResponse.status, 409);
    assert.equal(
      ((await mismatchResponse.json()) as { error: { code: string } }).error.code,
      "OBJECT_MISMATCH",
    );
    assert.equal(repository.buildJobs.size, 0);
  });

  it("ZIP-001 returns accepted while preserving a durable job if dispatch fails", async () => {
    const objectKey = `${serviceId}/${versionId}/${"a".repeat(64)}.zip`;
    storage.objects.set(objectKey, { sha256, size });
    queue.enqueueInspection = async () => {
      throw new Error("redis unavailable");
    };

    const response = await request(
      `/api/admin/mcp/services/${serviceId}/versions/${versionId}/complete-upload`,
      { objectKey, sha256, size, expectedRevision: 1 },
    );
    assert.equal(response.status, 202);
    const completed = (await response.json()) as { dispatched: boolean; job: { id: string } };
    assert.equal(completed.dispatched, false);
    assert.equal(repository.buildJobs.get(completed.job.id)?.status, "QUEUED");
  });

  it("API-002 and API-004 reject auditors and malformed upload requests", async () => {
    const forbidden = await request(
      `/api/admin/mcp/services/${serviceId}/versions/${versionId}/upload-url`,
      { sha256, size },
      "auditor",
    );
    assert.equal(forbidden.status, 403);

    const invalid = await request(
      `/api/admin/mcp/services/${serviceId}/versions/${versionId}/upload-url`,
      { sha256: "not-a-digest", size },
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      "VALIDATION_ERROR",
    );
  });
});
