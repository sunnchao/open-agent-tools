import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createControlPlaneApp } from "./app.js";
import { McpManagementService, type Actor, type IdGenerator } from "./management.js";
import { InMemoryMcpManagementRepository } from "./repository.js";
import type { McpServiceRecord, McpServiceVersionRecord } from "./types.js";

const ids = [
  "018f5f8d-23f2-7ec7-a799-6f3988e86e01",
  "018f5f8d-23f2-7ec7-a799-6f3988e86e02",
  "018f5f8d-23f2-7ec7-a799-6f3988e86e03",
  "018f5f8d-23f2-7ec7-a799-6f3988e86e04",
];

function sequentialIds(): IdGenerator {
  let index = 0;
  return () => ids[index++]!;
}

describe("MCP marketplace catalog", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let repository: InMemoryMcpManagementRepository;

  beforeEach(async () => {
    repository = new InMemoryMcpManagementRepository();
    const app = createControlPlaneApp({
      management: new McpManagementService(repository, {
        createId: sequentialIds(),
        now: () => "2026-07-31T12:00:00.000Z",
      }),
      authenticate: () => ({ id: "admin-1", role: "admin" }) satisfies Actor,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await close();
  });

  it("returns only ACTIVE + PUBLISHED services and keeps Remote tool count unknown", async () => {
    const now = "2026-07-31T12:00:00.000Z";
    const active: McpServiceRecord = {
      id: "active-service",
      name: "Managed Search",
      slug: "managed-search",
      type: "MANAGED_MCP",
      status: "ACTIVE",
      currentVersionId: "active-version",
      revision: 2,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const version: McpServiceVersionRecord = {
      id: "active-version",
      serviceId: active.id,
      versionNumber: 3,
      status: "PUBLISHED",
      runtime: { name: "nodejs", version: "20" },
      entry: "src/index.js",
      buildCommand: "npm run build",
      limits: { timeoutMs: 30_000, memoryMb: 256, cpuMillis: 1_000, network: "none" },
      artifactDigest: `sha256:${"a".repeat(64)}`,
      artifactObjectKey: "artifact.zip",
      artifactSize: 10,
      imageDigest: `sha256:${"b".repeat(64)}`,
      remoteConfig: null,
      tools: [
        {
          id: "tool-1",
          name: "search",
          description: "Search docs",
          handler: "search",
          inputSchema: { type: "object" },
        },
      ],
      prompts: [
        {
          id: "prompt-1",
          name: "summarize",
          title: "Summarize",
          arguments: [],
          messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
        },
      ],
      revision: 2,
      createdAt: now,
      updatedAt: now,
    };
    const remote: McpServiceRecord = {
      ...active,
      id: "remote-service",
      name: "Remote Search",
      slug: "remote-search",
      type: "REMOTE_MCP",
      currentVersionId: "remote-version",
    };
    const remoteVersion: McpServiceVersionRecord = {
      ...version,
      id: "remote-version",
      serviceId: remote.id,
      remoteConfig: {
        transport: "streamable-http",
        url: "https://mcp.example/rpc",
        timeoutMs: 10_000,
      },
      tools: [],
      prompts: [],
    };
    const draft: McpServiceRecord = {
      ...active,
      id: "draft-service",
      name: "Draft Service",
      slug: "draft-service",
      status: "DRAFT",
      currentVersionId: "draft-version",
    };
    repository.services.set(active.id, active);
    repository.services.set(remote.id, remote);
    repository.services.set(draft.id, draft);
    repository.versions.set(version.id, version);
    repository.versions.set(remoteVersion.id, remoteVersion);
    repository.versions.set("draft-version", {
      ...version,
      id: "draft-version",
      serviceId: draft.id,
    });

    const response = await fetch(`${baseUrl}/api/admin/mcp/marketplace`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      services: Array<{
        slug: string;
        versionNumber: number;
        toolCount: number | null;
        promptCount: number;
        toolsUnknown: boolean;
      }>;
    };
    assert.deepEqual(body.services.map((service) => service.slug).sort(), [
      "managed-search",
      "remote-search",
    ]);
    const managed = body.services.find((service) => service.slug === "managed-search")!;
    assert.equal(managed.versionNumber, 3);
    assert.equal(managed.toolCount, 1);
    assert.equal(managed.promptCount, 1);
    assert.equal(managed.toolsUnknown, false);
    const remoteResult = body.services.find((service) => service.slug === "remote-search")!;
    assert.equal(remoteResult.toolCount, null);
    assert.equal(remoteResult.toolsUnknown, true);
  });
});
