import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool } from "pg";
import {
  createPostgresRepository,
  type PostgresMcpManagementRepository,
} from "./postgres-repository.js";
import { McpManagementService, ManagementError, type Actor } from "../management.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin: Actor = { id: "admin-1", role: "admin" };
const operator: Actor = { id: "operator-1", role: "operator" };

function hasPostgresCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

describe("PostgreSQL MCP management repository", { skip: !databaseUrl }, () => {
  let management: McpManagementService;
  let repository: PostgresMcpManagementRepository;
  let closeRepository: () => Promise<void>;
  let maintenancePool: Pool;

  before(async () => {
    maintenancePool = new Pool({ connectionString: databaseUrl });
    await maintenancePool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const migrationName of [
      "0000_mcp_management.sql",
      "0001_mcp_client_access.sql",
      "0002_mcp_build_jobs.sql",
    ]) {
      const migration = await readFile(
        resolve(import.meta.dirname, `../../drizzle/${migrationName}`),
        "utf8",
      );
      await maintenancePool.query(migration);
    }
    const created = createPostgresRepository(databaseUrl!);
    repository = created.repository;
    closeRepository = created.close;
    management = new McpManagementService(repository, {
      now: () => "2026-07-31T12:00:00.000Z",
    });
  });

  beforeEach(async () => {
    await maintenancePool.query("TRUNCATE TABLE mcp_services CASCADE");
  });

  after(async () => {
    await closeRepository();
    await maintenancePool.end();
  });

  it("persists Tool and Prompt configuration and enforces revision conflicts", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      operator,
    );
    const withTool = await management.addTool(
      draftVersion.id,
      {
        name: "get_report",
        handler: "getReport",
        inputSchema: { type: "object", properties: {} },
      },
      1,
      operator,
    );
    const withPrompt = await management.addPrompt(
      draftVersion.id,
      {
        name: "summarize_report",
        arguments: [{ name: "reportId", required: true }],
        messages: [
          {
            role: "user",
            content: { type: "text", text: "Summarize {{reportId}}." },
          },
        ],
      },
      withTool.revision,
      operator,
    );

    const reloaded = await management.getVersion(draftVersion.id, operator);
    assert.equal(reloaded.serviceId, service.id);
    assert.equal(reloaded.tools[0]?.name, "get_report");
    assert.equal(reloaded.prompts[0]?.name, "summarize_report");

    await assert.rejects(
      management.deleteTool(draftVersion.id, reloaded.tools[0]!.id, 1, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "CONFLICT",
    );
    assert.equal(withPrompt.revision, 3);
  });

  it("publishes a Prompt-only version atomically and rejects duplicate slugs", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Prompt service", slug: "prompt-service" },
      operator,
    );
    const configured = await management.addPrompt(
      draftVersion.id,
      {
        name: "summarize",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
      },
      1,
      operator,
    );
    const ready = await management.validateVersion(draftVersion.id, configured.revision, operator);
    const published = await management.publishVersion(ready.id, ready.revision, admin);

    assert.equal(published.service.status, "ACTIVE");
    assert.equal(published.service.currentVersionId, ready.id);
    assert.equal(published.version.status, "PUBLISHED");
    assert.equal((await management.getService(service.id, operator)).currentVersionId, ready.id);

    await assert.rejects(
      management.createManagedService({ name: "Duplicate", slug: "prompt-service" }, operator),
      (error: unknown) => error instanceof ManagementError && error.code === "CONFLICT",
    );
  });

  it("LIFE-009 and LIFE-012 atomically roll back once under concurrent requests", async () => {
    const { service, draftVersion } = await management.createManagedService(
      { name: "Rollback service", slug: "rollback-service" },
      operator,
    );
    const configured = await management.addPrompt(
      draftVersion.id,
      {
        name: "summarize",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
      },
      draftVersion.revision,
      operator,
    );
    const readyV1 = await management.validateVersion(configured.id, configured.revision, operator);
    const publishedV1 = await management.publishVersion(readyV1.id, readyV1.revision, admin);

    const version2Id = randomUUID();
    await maintenancePool.query(
      `INSERT INTO mcp_service_versions
        (id, service_id, version_number, status, runtime_name, runtime_version, entry,
         build_command, limits, artifact_digest, image_digest, revision, created_at, updated_at)
       SELECT $1, service_id, 2, 'READY', runtime_name, runtime_version, entry,
              build_command, limits, artifact_digest, image_digest, 1, created_at, updated_at
       FROM mcp_service_versions
       WHERE id = $2`,
      [version2Id, publishedV1.version.id],
    );
    const readyV2 = await management.getVersion(version2Id, admin);
    await management.publishVersion(readyV2.id, readyV2.revision, admin);
    const supersededV1 = await management.getVersion(publishedV1.version.id, admin);

    const attempts = await Promise.allSettled([
      management.rollbackVersion(service.id, supersededV1.id, supersededV1.revision, admin),
      management.rollbackVersion(service.id, supersededV1.id, supersededV1.revision, admin),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);

    const publishedVersions = await maintenancePool.query<{ count: string }>(
      `SELECT count(*) FROM mcp_service_versions WHERE service_id = $1 AND status = 'PUBLISHED'`,
      [service.id],
    );
    assert.equal(publishedVersions.rows[0]?.count, "1");
    assert.equal(
      (await management.getService(service.id, admin)).currentVersionId,
      supersededV1.id,
    );
  });

  it("atomically persists the validating version and its durable inspection job", async () => {
    const { draftVersion } = await management.createManagedService(
      { name: "Tool service", slug: "tool-service" },
      operator,
    );
    const queued = await management.confirmArtifactUpload(
      draftVersion.id,
      {
        objectKey: `service/${draftVersion.id}/artifact.zip`,
        artifactDigest: `sha256:${"a".repeat(64)}`,
        artifactSize: 1024,
      },
      draftVersion.revision,
      operator,
    );

    assert.equal((await repository.getVersion(draftVersion.id))?.status, "VALIDATING");
    assert.deepEqual(await repository.getBuildJob(queued.job.id), queued.job);

    const { draftVersion: rollbackDraft } = await management.createManagedService(
      { name: "Rollback service", slug: "rollback-service" },
      operator,
    );
    const invalidUpdatedVersion = {
      ...rollbackDraft,
      status: "VALIDATING" as const,
      artifactDigest: `sha256:${"b".repeat(64)}`,
      artifactObjectKey: `service/${rollbackDraft.id}/artifact.zip`,
      artifactSize: 2048,
      revision: rollbackDraft.revision + 1,
    };

    await assert.rejects(
      repository.queueBuildJob(invalidUpdatedVersion, rollbackDraft.revision, {
        ...queued.job,
        versionId: rollbackDraft.id,
        artifactObjectKey: invalidUpdatedVersion.artifactObjectKey,
        artifactDigest: invalidUpdatedVersion.artifactDigest,
        artifactSize: invalidUpdatedVersion.artifactSize,
      }),
      (error: unknown) => hasPostgresCode(error, "23505"),
    );
    const rolledBack = await repository.getVersion(rollbackDraft.id);
    assert.equal(rolledBack?.status, "DRAFT");
    assert.equal(rolledBack?.revision, rollbackDraft.revision);
    assert.equal(rolledBack?.artifactDigest, null);
  });
});
