import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  McpManagementService,
  ManagementError,
  type Actor,
  type IdGenerator,
} from "./management.js";
import { InMemoryMcpManagementRepository } from "./repository.js";
import type { McpServiceVersionRecord } from "./types.js";

const admin: Actor = { id: "admin-1", role: "admin" };
const operator: Actor = { id: "operator-1", role: "operator" };
const auditor: Actor = { id: "auditor-1", role: "auditor" };

const validTool = {
  name: "get_report",
  description: "Get a report by id",
  handler: "getReport",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

const validPrompt = {
  name: "summarize_report",
  title: "Summarize report",
  description: "Create a summary request",
  arguments: [{ name: "reportId", required: true }],
  messages: [
    {
      role: "user" as const,
      content: { type: "text" as const, text: "Summarize {{reportId}}." },
    },
  ],
};

function sequentialIds(): IdGenerator {
  let value = 0;
  return () => `id-${++value}`;
}

describe("MCP management service", () => {
  let repository: InMemoryMcpManagementRepository;
  let management: McpManagementService;

  beforeEach(() => {
    repository = new InMemoryMcpManagementRepository();
    management = new McpManagementService(repository, {
      createId: sequentialIds(),
      now: () => "2026-07-31T12:00:00.000Z",
    });
  });

  it("LIFE-001 creates a managed service and editable empty draft version", async () => {
    const created = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );

    assert.deepEqual(created.service, {
      id: "id-1",
      name: "Reports",
      slug: "reports",
      type: "MANAGED_MCP",
      status: "DRAFT",
      currentVersionId: null,
      revision: 1,
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
      deletedAt: null,
    });
    assert.equal(created.draftVersion.id, "id-2");
    assert.equal(created.draftVersion.status, "DRAFT");
    assert.deepEqual(created.draftVersion.tools, []);
    assert.deepEqual(created.draftVersion.prompts, []);
  });

  it("API-007 rejects duplicate service slugs", async () => {
    await management.createManagedService({ name: "Reports", slug: "reports" }, operator);

    await assert.rejects(
      management.createManagedService({ name: "Other", slug: "reports" }, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "CONFLICT",
    );
  });

  it("keeps service fields when an optimistic update omits them", async () => {
    const { service } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );

    const updated = await management.updateService(service.id, {}, service.revision, operator);

    assert.equal(updated.name, "Reports");
    assert.equal(updated.slug, "reports");
    assert.equal(updated.revision, 2);
  });

  it("TOOL-010 adds, updates, and deletes a Tool on a draft", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );

    const added = await management.addTool(draftVersion.id, validTool, 1, operator);
    assert.equal(added.revision, 2);
    assert.equal(added.tools[0]?.name, "get_report");

    const toolId = added.tools[0]!.id;
    const updated = await management.updateTool(
      draftVersion.id,
      toolId,
      { description: "Updated description" },
      2,
      operator,
    );
    assert.equal(updated.revision, 3);
    assert.equal(updated.tools[0]?.description, "Updated description");

    const deleted = await management.deleteTool(draftVersion.id, toolId, 3, operator);
    assert.equal(deleted.revision, 4);
    assert.deepEqual(deleted.tools, []);
  });

  it("PRM-017 adds, updates, deletes, and previews a Prompt on a draft", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );

    const added = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const promptId = added.prompts[0]!.id;
    const preview = await management.previewPrompt(
      draftVersion.id,
      promptId,
      { reportId: "report-1" },
      operator,
    );
    assert.equal(preview.messages[0]?.content.text, "Summarize report-1.");

    const updated = await management.updatePrompt(
      draftVersion.id,
      promptId,
      { title: "Updated title" },
      2,
      operator,
    );
    assert.equal(updated.prompts[0]?.title, "Updated title");

    const deleted = await management.deletePrompt(draftVersion.id, promptId, 3, operator);
    assert.deepEqual(deleted.prompts, []);
  });

  it("TOOL-012 rejects a stale draft revision", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    await management.addTool(draftVersion.id, validTool, 1, operator);

    await assert.rejects(
      management.addPrompt(draftVersion.id, validPrompt, 1, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "CONFLICT",
    );
  });

  it("MAN-017 and MAN-018 reject duplicate names within each capability type", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const withTool = await management.addTool(draftVersion.id, validTool, 1, operator);

    await assert.rejects(
      management.addTool(draftVersion.id, validTool, withTool.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "CONFLICT",
    );

    const withPrompt = await management.addPrompt(
      draftVersion.id,
      validPrompt,
      withTool.revision,
      operator,
    );
    await assert.rejects(
      management.addPrompt(draftVersion.id, validPrompt, withPrompt.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "CONFLICT",
    );
  });

  it("PRM-020 validates and publishes a Prompt-only version without an image", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const ready = await management.validateVersion(draftVersion.id, configured.revision, operator);

    assert.equal(ready.status, "READY");
    assert.equal(ready.imageDigest, null);

    const published = await management.publishVersion(ready.id, ready.revision, admin);
    assert.equal(published.version.status, "PUBLISHED");
    assert.equal(published.service.status, "ACTIVE");
    assert.equal(published.service.currentVersionId, ready.id);
    assert.equal((await management.getService(service.id, auditor)).status, "ACTIVE");
  });

  it("LIFE-003 rejects validating a Tool version without a built image", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addTool(draftVersion.id, validTool, 1, operator);

    await assert.rejects(
      management.validateVersion(draftVersion.id, configured.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );
  });

  it("WEB-003 imports a package manifest into an editable Tool and Prompt draft", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );

    const imported = await management.importPackageManifest(
      draftVersion.id,
      {
        schemaVersion: 1,
        runtime: { name: "nodejs", version: "20" },
        entry: "src/index.js",
        tools: [validTool],
        prompts: [validPrompt],
        limits: {
          timeoutMs: 30_000,
          memoryMb: 256,
          cpuMillis: 1_000,
          network: "none",
        },
      },
      `sha256:${"a".repeat(64)}`,
      draftVersion.revision,
      operator,
    );

    assert.equal(imported.status, "DRAFT");
    assert.deepEqual(imported.runtime, { name: "nodejs", version: "20" });
    assert.equal(imported.entry, "src/index.js");
    assert.equal(imported.artifactDigest, `sha256:${"a".repeat(64)}`);
    assert.deepEqual(
      imported.tools.map((tool) => tool.name),
      ["get_report"],
    );
    assert.deepEqual(
      imported.prompts.map((prompt) => prompt.name),
      ["summarize_report"],
    );

    const edited = await management.updatePrompt(
      imported.id,
      imported.prompts[0]!.id,
      { title: "Edited after import" },
      imported.revision,
      operator,
    );
    assert.equal(edited.prompts[0]?.title, "Edited after import");
  });

  it("LIFE-004 and BLD-005 require BUILDING before recording an immutable image digest", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const imported = await management.importPackageManifest(
      draftVersion.id,
      {
        schemaVersion: 1,
        runtime: { name: "nodejs", version: "20" },
        entry: "src/index.js",
        tools: [validTool],
        prompts: [],
        limits: {
          timeoutMs: 30_000,
          memoryMb: 256,
          cpuMillis: 1_000,
          network: "none",
        },
      },
      `sha256:${"a".repeat(64)}`,
      1,
      operator,
    );

    await assert.rejects(
      management.completeBuild(imported.id, `sha256:${"b".repeat(64)}`, imported.revision),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );

    const building = await management.beginBuild(imported.id, imported.revision, operator);
    assert.equal(building.status, "BUILDING");

    const ready = await management.completeBuild(
      building.id,
      `sha256:${"b".repeat(64)}`,
      building.revision,
    );
    assert.equal(ready.status, "READY");
    assert.equal(ready.imageDigest, `sha256:${"b".repeat(64)}`);
  });

  it("BLD-001 queues a durable BUILD job and enters BUILDING atomically", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const imported = await management.importPackageManifest(
      draftVersion.id,
      {
        schemaVersion: 1,
        runtime: { name: "nodejs", version: "20" },
        entry: "src/index.js",
        tools: [validTool],
        prompts: [],
        limits: { timeoutMs: 30_000, memoryMb: 256, cpuMillis: 1_000, network: "none" },
      },
      `sha256:${"a".repeat(64)}`,
      draftVersion.revision,
      operator,
    );
    const prepared = await repository.saveVersion(
      { ...imported, artifactObjectKey: "reports/artifact.zip", artifactSize: 1024 },
      imported.revision,
    );

    const queued = await management.queueBuild(prepared.id, prepared.revision, operator);
    assert.equal(queued.version.status, "BUILDING");
    assert.equal(queued.version.revision, prepared.revision + 1);
    assert.equal(queued.job.kind, "BUILD");
    assert.equal(queued.job.status, "QUEUED");
    assert.equal(queued.job.artifactObjectKey, "reports/artifact.zip");
    assert.equal(repository.buildJobs.get(queued.job.id)?.status, "QUEUED");
  });

  it("BLD-001 retries a failed version with a new durable BUILD job", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const imported = await management.importPackageManifest(
      draftVersion.id,
      {
        schemaVersion: 1,
        runtime: { name: "nodejs", version: "20" },
        entry: "src/index.js",
        tools: [validTool],
        prompts: [],
        limits: { timeoutMs: 30_000, memoryMb: 256, cpuMillis: 1_000, network: "none" },
      },
      `sha256:${"a".repeat(64)}`,
      draftVersion.revision,
      operator,
    );
    const prepared = await repository.saveVersion(
      { ...imported, artifactObjectKey: "reports/artifact.zip", artifactSize: 1024 },
      imported.revision,
    );
    const first = await management.queueBuild(prepared.id, prepared.revision, operator);
    const failed = {
      ...first.version,
      status: "FAILED" as const,
      revision: first.version.revision + 1,
    };
    repository.versions.set(failed.id, structuredClone(failed));
    repository.buildJobs.set(first.job.id, {
      ...first.job,
      status: "FAILED",
      stage: "FAILED",
      errorCode: "NPM_INSTALL_FAILED",
    });

    const retried = await management.queueBuild(failed.id, failed.revision, operator);

    assert.equal(retried.version.status, "BUILDING");
    assert.equal(retried.version.revision, failed.revision + 1);
    assert.notEqual(retried.job.id, first.job.id);
    assert.equal(retried.job.status, "QUEUED");
    assert.equal(repository.buildJobs.size, 2);
    assert.equal(repository.buildJobs.get(first.job.id)?.status, "FAILED");
  });

  it("BLD-001 rejects a Prompt-only version from creating a BUILD job", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Prompt reports", slug: "prompt-reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);

    await assert.rejects(
      management.queueBuild(configured.id, configured.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );
    assert.equal(repository.buildJobs.size, 0);
  });

  it("LIFE-009-A rolls back to a superseded version without rebuilding it", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const readyV1 = await management.validateVersion(configured.id, configured.revision, operator);
    const publishedV1 = await management.publishVersion(readyV1.id, readyV1.revision, admin);

    const readyV2: McpServiceVersionRecord = {
      ...publishedV1.version,
      id: "version-2",
      versionNumber: 2,
      status: "READY",
      revision: 1,
      prompts: [
        {
          ...publishedV1.version.prompts[0]!,
          id: "prompt-2",
          messages: [{ role: "user", content: { type: "text", text: "Updated {{reportId}}." } }],
        },
      ],
    };
    repository.versions.set(readyV2.id, structuredClone(readyV2));
    const publishedV2 = await management.publishVersion(readyV2.id, readyV2.revision, admin);
    const supersededV1 = await management.getVersion(publishedV1.version.id, admin);

    const rolledBack = await management.rollbackVersion(
      service.id,
      supersededV1.id,
      supersededV1.revision,
      admin,
    );

    assert.equal(rolledBack.service.currentVersionId, publishedV1.version.id);
    assert.equal(rolledBack.service.status, "ACTIVE");
    assert.equal(rolledBack.version.id, publishedV1.version.id);
    assert.equal(rolledBack.version.status, "PUBLISHED");
    assert.equal((await management.getVersion(publishedV2.version.id, admin)).status, "SUPERSEDED");
    assert.equal(repository.buildJobs.size, 0);
  });

  it("LIFE-009-B/C rejects invalid, stale, and non-admin rollback requests", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const ready = await management.validateVersion(configured.id, configured.revision, operator);
    const published = await management.publishVersion(ready.id, ready.revision, admin);

    await assert.rejects(
      management.rollbackVersion(
        service.id,
        published.version.id,
        published.version.revision,
        admin,
      ),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );
    await assert.rejects(
      management.rollbackVersion(
        service.id,
        published.version.id,
        published.version.revision - 1,
        admin,
      ),
      (error: unknown) => error instanceof ManagementError && error.code === "CONFLICT",
    );
    await assert.rejects(
      management.rollbackVersion(
        service.id,
        published.version.id,
        published.version.revision,
        operator,
      ),
      (error: unknown) => error instanceof ManagementError && error.code === "FORBIDDEN",
    );
  });

  it("LIFE-013-A/B disables only an active service and preserves its published snapshot", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const ready = await management.validateVersion(configured.id, configured.revision, operator);
    const published = await management.publishVersion(ready.id, ready.revision, admin);

    const disabled = await management.disableService(service.id, published.service.revision, admin);
    assert.equal(disabled.status, "DISABLED");
    assert.equal(disabled.currentVersionId, published.version.id);
    assert.equal((await management.getVersion(published.version.id, admin)).status, "PUBLISHED");

    await assert.rejects(
      management.disableService(service.id, disabled.revision, admin),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );
    await assert.rejects(
      management.disableService(service.id, disabled.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "FORBIDDEN",
    );
  });

  it("LIFE-014 re-enables a disabled service back to ACTIVE", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const ready = await management.validateVersion(configured.id, configured.revision, operator);
    const published = await management.publishVersion(ready.id, ready.revision, admin);
    const disabled = await management.disableService(service.id, published.service.revision, admin);

    const enabled = await management.enableService(service.id, disabled.revision, admin);
    assert.equal(enabled.status, "ACTIVE");
    assert.equal(enabled.currentVersionId, published.version.id);
    assert.equal(enabled.revision, disabled.revision + 1);

    await assert.rejects(
      management.enableService(service.id, enabled.revision, admin),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );
    await assert.rejects(
      management.enableService(service.id, disabled.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "FORBIDDEN",
    );
  });

  it("LIFE-015 resets an unpublished READY version back to DRAFT", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const ready = await management.validateVersion(configured.id, configured.revision, operator);

    const reset = await management.resetVersionToDraft(ready.id, ready.revision, operator);
    assert.equal(reset.status, "DRAFT");
    assert.equal(reset.imageDigest, null);
    assert.equal(reset.prompts.length, 1);
    assert.equal(reset.revision, ready.revision + 1);

    const revalidated = await management.validateVersion(reset.id, reset.revision, operator);
    assert.equal(revalidated.status, "READY");

    const published = await management.publishVersion(revalidated.id, revalidated.revision, admin);
    await assert.rejects(
      management.resetVersionToDraft(published.version.id, published.version.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );
    await assert.rejects(
      management.resetVersionToDraft(ready.id, ready.revision, auditor),
      (error: unknown) => error instanceof ManagementError && error.code === "FORBIDDEN",
    );
  });

  it("LIFE-016-A forks a new draft from a published version without mutating it", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const ready = await management.validateVersion(configured.id, configured.revision, operator);
    const published = await management.publishVersion(ready.id, ready.revision, admin);

    const fork = await management.forkDraftVersion(service.id, published.version.id, operator);
    assert.equal(fork.status, "DRAFT");
    assert.equal(fork.versionNumber, 2);
    assert.equal(fork.revision, 1);
    assert.equal(fork.imageDigest, null);
    assert.equal(fork.prompts.length, 1);
    assert.equal(fork.prompts[0]!.name, validPrompt.name);
    assert.notEqual(fork.prompts[0]!.id, published.version.prompts[0]!.id);

    const original = await management.getVersion(published.version.id, admin);
    assert.equal(original.status, "PUBLISHED");
    assert.equal(original.revision, published.version.revision);

    const withArtifact: McpServiceVersionRecord = {
      ...published.version,
      id: "seed-artifact",
      versionNumber: 3,
      status: "PUBLISHED",
      revision: 7,
      artifactDigest: "sha256:artifact",
      artifactObjectKey: "services/reports/seed-artifact.zip",
      artifactSize: 123,
      imageDigest: "sha256:image",
      tools: [{ id: "tool-seed", ...validTool }],
    };
    repository.versions.set(withArtifact.id, structuredClone(withArtifact));
    const fork2 = await management.forkDraftVersion(service.id, withArtifact.id, operator);
    assert.equal(fork2.versionNumber, 4);
    assert.equal(fork2.artifactDigest, "sha256:artifact");
    assert.equal(fork2.imageDigest, null);
    assert.equal(fork2.tools.length, 1);
    assert.notEqual(fork2.tools[0]!.id, "tool-seed");
  });

  it("LIFE-016-B forks from a superseded version and rejects invalid sources", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const readyV1 = await management.validateVersion(configured.id, configured.revision, operator);
    const publishedV1 = await management.publishVersion(readyV1.id, readyV1.revision, admin);
    const readyV2: McpServiceVersionRecord = {
      ...publishedV1.version,
      id: "version-2",
      versionNumber: 2,
      status: "READY",
      revision: 1,
    };
    repository.versions.set(readyV2.id, structuredClone(readyV2));
    const publishedV2 = await management.publishVersion(readyV2.id, readyV2.revision, admin);
    const supersededV1 = await management.getVersion(publishedV1.version.id, admin);

    const fork = await management.forkDraftVersion(service.id, supersededV1.id, operator);
    assert.equal(fork.status, "DRAFT");
    assert.equal(fork.versionNumber, 3);

    await assert.rejects(
      management.forkDraftVersion(service.id, fork.id, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "INVALID_STATE",
    );
    await assert.rejects(
      management.forkDraftVersion(service.id, "missing-version", operator),
      (error: unknown) => error instanceof ManagementError && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      management.forkDraftVersion(service.id, publishedV2.version.id, auditor),
      (error: unknown) => error instanceof ManagementError && error.code === "FORBIDDEN",
    );
  });

  it("TOOL-011 and PRM-018 keep published versions immutable", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const ready = await management.validateVersion(draftVersion.id, configured.revision, operator);
    const { version } = await management.publishVersion(ready.id, ready.revision, admin);

    await assert.rejects(
      management.addTool(version.id, validTool, version.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "IMMUTABLE_VERSION",
    );
    await assert.rejects(
      management.deletePrompt(version.id, version.prompts[0]!.id, version.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "IMMUTABLE_VERSION",
    );
  });

  it("API-003 and API-004 enforce role permissions", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const configured = await management.addPrompt(draftVersion.id, validPrompt, 1, operator);
    const ready = await management.validateVersion(draftVersion.id, configured.revision, operator);

    await assert.rejects(
      management.publishVersion(ready.id, ready.revision, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      management.createManagedService({ name: "Audit write", slug: "audit-write" }, auditor),
      (error: unknown) => error instanceof ManagementError && error.code === "FORBIDDEN",
    );
  });
});
