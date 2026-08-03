import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { ArtifactInspectionJob, ManagedMcpManifest } from "@open-agent-tools/mcp-contracts";
import { Pool } from "pg";

import {
  ArtifactInspectionStateError,
  createPostgresArtifactInspectionRepository,
} from "./postgres-artifact-inspection-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const now = "2026-07-31T12:05:00.000Z";
const job: ArtifactInspectionJob = {
  buildJobId: "018f5f8d-23f2-7ec7-a799-6f3988e86da3",
  serviceId: "018f5f8d-23f2-7ec7-a799-6f3988e86da1",
  versionId: "018f5f8d-23f2-7ec7-a799-6f3988e86da2",
  versionRevision: 2,
  objectKey: "service/version/artifact.zip",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  artifactSize: 1024,
};

const manifest: ManagedMcpManifest = {
  schemaVersion: 1,
  runtime: { name: "nodejs", version: "20" },
  entry: "src/index.js",
  tools: [
    {
      name: "get_report",
      handler: "getReport",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ],
  prompts: [
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
  ],
  limits: {
    timeoutMs: 30_000,
    memoryMb: 256,
    cpuMillis: 1_000,
    network: "none",
  },
};

describe("PostgreSQL artifact inspection repository", { skip: !databaseUrl }, () => {
  let pool: Pool;
  let repository: ReturnType<typeof createPostgresArtifactInspectionRepository>["repository"];
  let closeRepository: () => Promise<void>;

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const migrationName of [
      "0000_mcp_management.sql",
      "0001_mcp_client_access.sql",
      "0002_mcp_build_jobs.sql",
    ]) {
      const migration = await readFile(
        resolve(import.meta.dirname, `../../mcp-control-plane/drizzle/${migrationName}`),
        "utf8",
      );
      await pool.query(migration);
    }
    const created = createPostgresArtifactInspectionRepository(databaseUrl!);
    repository = created.repository;
    closeRepository = created.close;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE mcp_services CASCADE");
    await pool.query(
      `INSERT INTO mcp_services
         (id, name, slug, type, status, revision, created_at, updated_at)
       VALUES ($1, 'Reports', 'reports', 'MANAGED_MCP', 'DRAFT', 1, $2, $2)`,
      [job.serviceId, "2026-07-31T12:00:00.000Z"],
    );
    await pool.query(
      `INSERT INTO mcp_service_versions
         (id, service_id, version_number, status, artifact_digest, artifact_object_key,
          artifact_size, revision, created_at, updated_at)
       VALUES ($1, $2, 1, 'VALIDATING', $3, $4, $5, 2, $6, $6)`,
      [
        job.versionId,
        job.serviceId,
        job.artifactDigest,
        job.objectKey,
        job.artifactSize,
        "2026-07-31T12:00:00.000Z",
      ],
    );
    await pool.query(
      `INSERT INTO mcp_build_jobs
         (id, version_id, kind, status, stage, artifact_object_key, artifact_digest,
          artifact_size, attempt, created_at, updated_at)
       VALUES ($1, $2, 'INSPECT', 'QUEUED', 'UPLOAD_CONFIRMED', $3, $4, $5, 0, $6, $6)`,
      [
        job.buildJobId,
        job.versionId,
        job.objectKey,
        job.artifactDigest,
        job.artifactSize,
        "2026-07-31T12:00:00.000Z",
      ],
    );
  });

  after(async () => {
    await closeRepository();
    await pool.end();
  });

  it("ZIP-001 atomically imports Tools and Prompts and completes the inspection job", async () => {
    assert.equal(await repository.startInspection(job, now), "STARTED");
    const running = await pool.query<{
      status: string;
      stage: string;
      attempt: number;
      started_at: Date;
    }>("SELECT status, stage, attempt, started_at FROM mcp_build_jobs WHERE id = $1", [
      job.buildJobId,
    ]);
    assert.equal(running.rows[0]?.status, "RUNNING");
    assert.equal(running.rows[0]?.stage, "DOWNLOADING");
    assert.equal(running.rows[0]?.attempt, 1);
    assert.ok(running.rows[0]?.started_at);

    await repository.completeInspection(job, manifest, now);

    const version = await pool.query<{
      status: string;
      runtime_name: string;
      runtime_version: string;
      entry: string;
      revision: number;
    }>(
      "SELECT status, runtime_name, runtime_version, entry, revision FROM mcp_service_versions WHERE id = $1",
      [job.versionId],
    );
    assert.deepEqual(version.rows[0], {
      status: "DRAFT",
      runtime_name: "nodejs",
      runtime_version: "20",
      entry: "src/index.js",
      revision: 3,
    });
    assert.deepEqual(
      (
        await pool.query("SELECT name, handler FROM mcp_tools WHERE version_id = $1", [
          job.versionId,
        ])
      ).rows,
      [{ name: "get_report", handler: "getReport" }],
    );
    assert.deepEqual(
      (await pool.query("SELECT name FROM mcp_prompts WHERE version_id = $1", [job.versionId]))
        .rows,
      [{ name: "summarize_report" }],
    );
    const completed = await pool.query<{
      status: string;
      stage: string;
      error_code: string | null;
    }>("SELECT status, stage, error_code FROM mcp_build_jobs WHERE id = $1", [job.buildJobId]);
    assert.deepEqual(completed.rows[0], {
      status: "SUCCEEDED",
      stage: "MANIFEST_IMPORTED",
      error_code: null,
    });
    assert.equal(await repository.startInspection(job, now), "ALREADY_COMPLETED");
  });

  it("ZIP-003 atomically records a stable failure on both job and version", async () => {
    await repository.startInspection(job, now);
    await repository.failInspection(job, "UNSAFE_PATH", now);

    const state = await pool.query<{
      version_status: string;
      revision: number;
      job_status: string;
      stage: string;
      error_code: string;
    }>(
      `SELECT v.status AS version_status, v.revision, j.status AS job_status,
              j.stage, j.error_code
         FROM mcp_service_versions v
         JOIN mcp_build_jobs j ON j.version_id = v.id
        WHERE j.id = $1`,
      [job.buildJobId],
    );
    assert.deepEqual(state.rows[0], {
      version_status: "FAILED",
      revision: 3,
      job_status: "FAILED",
      stage: "FAILED",
      error_code: "UNSAFE_PATH",
    });
  });

  it("TOOL-012 rejects a stale version revision without partially completing the job", async () => {
    await repository.startInspection(job, now);
    await pool.query("UPDATE mcp_service_versions SET revision = 3 WHERE id = $1", [job.versionId]);

    await assert.rejects(
      repository.completeInspection(job, manifest, now),
      (error: unknown) => error instanceof ArtifactInspectionStateError,
    );
    assert.equal(
      (await pool.query("SELECT status FROM mcp_build_jobs WHERE id = $1", [job.buildJobId]))
        .rows[0]?.status,
      "RUNNING",
    );
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS count FROM mcp_tools WHERE version_id = $1", [
          job.versionId,
        ])
      ).rows[0]?.count,
      0,
    );
  });

  it("BLD-001 atomically completes a BUILD job with an immutable image and SBOM digest", async () => {
    const buildJob = { ...job, versionRevision: 3 };
    await pool.query(
      "UPDATE mcp_service_versions SET status = 'BUILDING', revision = 3 WHERE id = $1",
      [job.versionId],
    );
    await pool.query(
      "UPDATE mcp_build_jobs SET kind = 'BUILD', stage = 'BUILD_QUEUED' WHERE id = $1",
      [job.buildJobId],
    );

    assert.equal(await repository.startBuild(buildJob, now), "STARTED");
    await repository.completeBuild(buildJob, `sha256:${"b".repeat(64)}`, "sbom/build-1.json", now);

    assert.deepEqual(
      (
        await pool.query(
          "SELECT status, revision, image_digest FROM mcp_service_versions WHERE id = $1",
          [job.versionId],
        )
      ).rows[0],
      { status: "READY", revision: 4, image_digest: `sha256:${"b".repeat(64)}` },
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT status, stage, image_digest, sbom_object_key FROM mcp_build_jobs WHERE id = $1",
          [job.buildJobId],
        )
      ).rows[0],
      {
        status: "SUCCEEDED",
        stage: "IMAGE_PUBLISHED",
        image_digest: `sha256:${"b".repeat(64)}`,
        sbom_object_key: "sbom/build-1.json",
      },
    );
  });

  it("BLD-002 records BUILD failures without an image digest", async () => {
    const buildJob = { ...job, versionRevision: 3 };
    await pool.query(
      "UPDATE mcp_service_versions SET status = 'BUILDING', revision = 3 WHERE id = $1",
      [job.versionId],
    );
    await pool.query(
      "UPDATE mcp_build_jobs SET kind = 'BUILD', stage = 'BUILD_QUEUED' WHERE id = $1",
      [job.buildJobId],
    );
    await repository.startBuild(buildJob, now);
    await repository.failBuild(buildJob, "NPM_INSTALL_FAILED", now);

    assert.deepEqual(
      (
        await pool.query(
          "SELECT status, revision, image_digest FROM mcp_service_versions WHERE id = $1",
          [job.versionId],
        )
      ).rows[0],
      { status: "FAILED", revision: 4, image_digest: null },
    );
    assert.equal(
      (await pool.query("SELECT error_code FROM mcp_build_jobs WHERE id = $1", [job.buildJobId]))
        .rows[0]?.error_code,
      "NPM_INSTALL_FAILED",
    );
  });
});
