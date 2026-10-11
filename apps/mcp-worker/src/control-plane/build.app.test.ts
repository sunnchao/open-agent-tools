import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createControlPlaneApp } from "./app.js";
import type { ArtifactBuildQueue } from "./build-queue.js";
import { McpManagementService, type Actor, type IdGenerator } from "./management.js";
import { InMemoryMcpManagementRepository } from "./repository.js";

const tool = {
  name: "get_report",
  handler: "getReport",
  inputSchema: { type: "object", additionalProperties: false },
};

function sequentialIds(): IdGenerator {
  let value = 0;
  return () => `id-${++value}`;
}

describe("Control Plane build HTTP API", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let repository: InMemoryMcpManagementRepository;
  let management: McpManagementService;
  let buildQueue: ArtifactBuildQueue;
  let queuedPayloads: unknown[];
  let serviceId: string;
  let versionId: string;
  let expectedRevision: number;

  beforeEach(async () => {
    repository = new InMemoryMcpManagementRepository();
    management = new McpManagementService(repository, {
      createId: sequentialIds(),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const created = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      { id: "operator-1", role: "operator" },
    );
    const imported = await management.importPackageManifest(
      created.draftVersion.id,
      {
        schemaVersion: 1,
        runtime: { name: "nodejs", version: "20" },
        entry: "src/index.js",
        tools: [tool],
        prompts: [],
        limits: { timeoutMs: 30_000, memoryMb: 256, cpuMillis: 1_000, network: "none" },
      },
      `sha256:${"a".repeat(64)}`,
      created.draftVersion.revision,
      { id: "operator-1", role: "operator" },
    );
    const prepared = await repository.saveVersion(
      { ...imported, artifactObjectKey: "reports/artifact.zip", artifactSize: 1024 },
      imported.revision,
    );
    serviceId = created.service.id;
    versionId = prepared.id;
    expectedRevision = prepared.revision;
    queuedPayloads = [];
    buildQueue = {
      enqueueBuild: async (job) => {
        queuedPayloads.push(job);
      },
    };
    const app = createControlPlaneApp({
      management,
      buildQueue,
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

  async function request(body: unknown, role = "operator") {
    return fetch(`${baseUrl}/api/admin/mcp/services/${serviceId}/versions/${versionId}/build`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": role },
      body: JSON.stringify(body),
    });
  }

  it("BLD-001 queues a BUILD job and returns 202", async () => {
    const response = await request({ expectedRevision });
    assert.equal(response.status, 202);
    const result = (await response.json()) as {
      dispatched: boolean;
      version: { status: string; revision: number };
      job: { kind: string; status: string };
    };
    assert.equal(result.dispatched, true);
    assert.equal(result.version.status, "BUILDING");
    assert.equal(result.version.revision, expectedRevision + 1);
    assert.equal(result.job.kind, "BUILD");
    assert.equal(result.job.status, "QUEUED");
    assert.equal(queuedPayloads.length, 1);

    const listResponse = await fetch(`${baseUrl}/api/admin/mcp/builds?limit=10`, {
      headers: { "x-test-role": "auditor" },
    });
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()) as {
      builds: Array<{ serviceName: string; versionNumber: number; kind: string }>;
    };
    assert.equal(listed.builds.length, 1);
    assert.equal(listed.builds[0]?.serviceName, "Reports");
    assert.equal(listed.builds[0]?.versionNumber, 1);
    assert.equal(listed.builds[0]?.kind, "BUILD");
  });

  it("BLD-001 keeps the queued job when BullMQ dispatch fails", async () => {
    buildQueue.enqueueBuild = async () => {
      throw new Error("redis unavailable");
    };
    const response = await request({ expectedRevision });
    assert.equal(response.status, 202);
    const result = (await response.json()) as { dispatched: boolean; job: { id: string } };
    assert.equal(result.dispatched, false);
    assert.equal(repository.buildJobs.get(result.job.id)?.status, "QUEUED");
  });

  it("API-002 and API-004 reject auditor and malformed build requests", async () => {
    assert.equal((await request({ expectedRevision }, "auditor")).status, 403);
    const invalid = await request({ expectedRevision: 0 });
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      "VALIDATION_ERROR",
    );
  });
});
