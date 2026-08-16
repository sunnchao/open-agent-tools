import { randomUUID } from "node:crypto";

import {
  ManagedMcpManifestSchema,
  type ArtifactInspectionJob,
  type ManagedMcpManifest,
} from "@open-agent-tools/mcp-contracts";
import type { Pool, PoolClient } from "pg";
import { createPostgresPool } from "@open-agent-tools/database/postgres";

import type {
  ArtifactInspectionRepository,
  InspectionFailureCode,
} from "../../services/artifact-inspection.js";
import type { BuildFailureCode, BuildJobRepository } from "../../services/tool-build.js";

export class ArtifactInspectionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactInspectionStateError";
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

function assertJobMatches(
  row: {
    version_id: string;
    service_id: string;
    artifact_object_key: string;
    artifact_digest: string;
    artifact_size: number;
  },
  job: ArtifactInspectionJob,
): void {
  if (
    row.version_id !== job.versionId ||
    row.service_id !== job.serviceId ||
    row.artifact_object_key !== job.objectKey ||
    row.artifact_digest !== job.artifactDigest ||
    row.artifact_size !== job.artifactSize
  ) {
    throw new ArtifactInspectionStateError("Inspection job payload no longer matches its version");
  }
}

export class PostgresArtifactInspectionRepository
  implements ArtifactInspectionRepository, BuildJobRepository
{
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async startInspection(
    job: ArtifactInspectionJob,
    now: string,
  ): Promise<"STARTED" | "ALREADY_COMPLETED"> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        status: string;
        version_id: string;
        service_id: string;
        version_status: string;
        version_revision: number;
        artifact_object_key: string;
        artifact_digest: string;
        artifact_size: number;
      }>(
        `SELECT j.status, j.version_id, v.service_id, v.status AS version_status,
                v.revision AS version_revision, v.artifact_object_key,
                v.artifact_digest, v.artifact_size
           FROM mcp_build_jobs j
           JOIN mcp_service_versions v ON v.id = j.version_id
          WHERE j.id = $1 AND j.kind = 'INSPECT'
          FOR UPDATE OF j, v`,
        [job.buildJobId],
      );
      const row = result.rows[0];
      if (!row) throw new ArtifactInspectionStateError("Inspection job was not found");
      if (row.status === "SUCCEEDED") {
        await client.query("COMMIT");
        return "ALREADY_COMPLETED";
      }
      assertJobMatches(row, job);
      if (row.status !== "QUEUED") {
        throw new ArtifactInspectionStateError(`Inspection job is not queued: ${row.status}`);
      }
      if (row.version_status !== "VALIDATING" || row.version_revision !== job.versionRevision) {
        throw new ArtifactInspectionStateError("Version is no longer awaiting inspection");
      }
      await client.query(
        `UPDATE mcp_build_jobs
            SET status = 'RUNNING', stage = 'DOWNLOADING', attempt = attempt + 1,
                started_at = COALESCE(started_at, $2), updated_at = $2
          WHERE id = $1`,
        [job.buildJobId, now],
      );
      await client.query("COMMIT");
      return "STARTED";
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeInspection(
    job: ArtifactInspectionJob,
    manifestInput: ManagedMcpManifest,
    now: string,
  ): Promise<void> {
    const manifest = ManagedMcpManifestSchema.parse(manifestInput);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const state = await this.#lockedState(client, job);
      if (state.jobStatus === "SUCCEEDED") {
        await client.query("COMMIT");
        return;
      }
      if (
        state.jobStatus !== "RUNNING" ||
        state.versionStatus !== "VALIDATING" ||
        state.versionRevision !== job.versionRevision
      ) {
        throw new ArtifactInspectionStateError("Inspection is not running");
      }

      await client.query("DELETE FROM mcp_tools WHERE version_id = $1", [job.versionId]);
      await client.query("DELETE FROM mcp_prompts WHERE version_id = $1", [job.versionId]);
      for (const [position, tool] of manifest.tools.entries()) {
        await client.query(
          `INSERT INTO mcp_tools
             (id, version_id, name, description, handler, input_schema, position)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            randomUUID(),
            job.versionId,
            tool.name,
            tool.description ?? null,
            tool.handler,
            JSON.stringify(tool.inputSchema),
            position,
          ],
        );
      }
      for (const [position, prompt] of manifest.prompts.entries()) {
        await client.query(
          `INSERT INTO mcp_prompts
             (id, version_id, name, title, description, arguments, messages, position)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
          [
            randomUUID(),
            job.versionId,
            prompt.name,
            prompt.title ?? null,
            prompt.description ?? null,
            JSON.stringify(prompt.arguments),
            JSON.stringify(prompt.messages),
            position,
          ],
        );
      }
      await client.query(
        `UPDATE mcp_service_versions
            SET status = 'DRAFT', runtime_name = $2, runtime_version = $3,
                entry = $4, build_command = $5, limits = $6::jsonb,
                image_digest = NULL, revision = revision + 1, updated_at = $7
          WHERE id = $1 AND status = 'VALIDATING' AND revision = $8`,
        [
          job.versionId,
          manifest.runtime?.name ?? null,
          manifest.runtime?.version ?? null,
          manifest.entry ?? null,
          manifest.build?.command ?? null,
          manifest.limits ? JSON.stringify(manifest.limits) : null,
          now,
          job.versionRevision,
        ],
      );
      await client.query(
        `UPDATE mcp_build_jobs
            SET status = 'SUCCEEDED', stage = 'MANIFEST_IMPORTED',
                error_code = NULL, finished_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'RUNNING'`,
        [job.buildJobId, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failInspection(
    job: ArtifactInspectionJob,
    code: InspectionFailureCode,
    now: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const state = await this.#lockedState(client, job);
      if (state.jobStatus === "SUCCEEDED" || state.jobStatus === "FAILED") {
        await client.query("COMMIT");
        return;
      }
      if (state.versionRevision !== job.versionRevision) {
        throw new ArtifactInspectionStateError("Version revision changed during inspection");
      }
      await client.query(
        `UPDATE mcp_service_versions
            SET status = 'FAILED', revision = revision + 1, updated_at = $2
          WHERE id = $1 AND status = 'VALIDATING' AND revision = $3`,
        [job.versionId, now, job.versionRevision],
      );
      await client.query(
        `UPDATE mcp_build_jobs
            SET status = 'FAILED', stage = 'FAILED', error_code = $2,
                finished_at = $3, updated_at = $3
          WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')`,
        [job.buildJobId, code, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async startBuild(
    job: ArtifactInspectionJob,
    now: string,
  ): Promise<"STARTED" | "ALREADY_COMPLETED"> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const state = await this.#lockedState(client, job, "BUILD");
      if (state.jobStatus === "SUCCEEDED") {
        await client.query("COMMIT");
        return "ALREADY_COMPLETED";
      }
      if (state.jobStatus !== "QUEUED") {
        throw new ArtifactInspectionStateError(`Build job is not queued: ${state.jobStatus}`);
      }
      if (state.versionStatus !== "BUILDING" || state.versionRevision !== job.versionRevision) {
        throw new ArtifactInspectionStateError("Version is no longer awaiting build");
      }
      await client.query(
        `UPDATE mcp_build_jobs
            SET status = 'RUNNING', stage = 'NPM_INSTALL', attempt = attempt + 1,
                started_at = COALESCE(started_at, $2), updated_at = $2
          WHERE id = $1`,
        [job.buildJobId, now],
      );
      await client.query("COMMIT");
      return "STARTED";
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeBuild(
    job: ArtifactInspectionJob,
    imageDigest: string,
    sbomObjectKey: string | null,
    now: string,
  ): Promise<void> {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
      throw new ArtifactInspectionStateError("Build image digest is invalid");
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const state = await this.#lockedState(client, job, "BUILD");
      if (state.jobStatus === "SUCCEEDED") {
        await client.query("COMMIT");
        return;
      }
      if (
        state.jobStatus !== "RUNNING" ||
        state.versionStatus !== "BUILDING" ||
        state.versionRevision !== job.versionRevision
      ) {
        throw new ArtifactInspectionStateError("Build is not running");
      }
      await client.query(
        `UPDATE mcp_service_versions
            SET status = 'READY', image_digest = $2, revision = revision + 1, updated_at = $3
          WHERE id = $1 AND status = 'BUILDING' AND revision = $4`,
        [job.versionId, imageDigest, now, job.versionRevision],
      );
      await client.query(
        `UPDATE mcp_build_jobs
            SET status = 'SUCCEEDED', stage = 'IMAGE_PUBLISHED', image_digest = $2,
                sbom_object_key = $3, error_code = NULL, finished_at = $4, updated_at = $4
          WHERE id = $1 AND status = 'RUNNING'`,
        [job.buildJobId, imageDigest, sbomObjectKey, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failBuild(job: ArtifactInspectionJob, code: BuildFailureCode, now: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const state = await this.#lockedState(client, job, "BUILD");
      if (state.jobStatus === "SUCCEEDED" || state.jobStatus === "FAILED") {
        await client.query("COMMIT");
        return;
      }
      if (state.versionRevision !== job.versionRevision) {
        throw new ArtifactInspectionStateError("Version revision changed during build");
      }
      await client.query(
        `UPDATE mcp_service_versions
            SET status = 'FAILED', image_digest = NULL, revision = revision + 1, updated_at = $2
          WHERE id = $1 AND status = 'BUILDING' AND revision = $3`,
        [job.versionId, now, job.versionRevision],
      );
      await client.query(
        `UPDATE mcp_build_jobs
            SET status = 'FAILED', stage = 'FAILED', image_digest = NULL,
                error_code = $2, finished_at = $3, updated_at = $3
          WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')`,
        [job.buildJobId, code, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #lockedState(
    client: PoolClient,
    job: ArtifactInspectionJob,
    kind: "INSPECT" | "BUILD" = "INSPECT",
  ): Promise<{
    jobStatus: string;
    versionStatus: string;
    versionRevision: number;
  }> {
    const result = await client.query<{
      job_status: string;
      version_status: string;
      version_revision: number;
      version_id: string;
      service_id: string;
      artifact_object_key: string;
      artifact_digest: string;
      artifact_size: number;
    }>(
      `SELECT j.status AS job_status, v.status AS version_status,
              v.revision AS version_revision, j.version_id,
              v.service_id, j.artifact_object_key, j.artifact_digest, j.artifact_size
         FROM mcp_build_jobs j
         JOIN mcp_service_versions v ON v.id = j.version_id
        WHERE j.id = $1 AND j.kind = $2
        FOR UPDATE OF j, v`,
      [job.buildJobId, kind],
    );
    const row = result.rows[0];
    if (!row) throw new ArtifactInspectionStateError("Inspection job was not found");
    assertJobMatches(row, job);
    return {
      jobStatus: row.job_status,
      versionStatus: row.version_status,
      versionRevision: row.version_revision,
    };
  }
}

export function createPostgresArtifactInspectionRepository(databaseUrl: string): {
  repository: PostgresArtifactInspectionRepository;
  close: () => Promise<void>;
} {
  const { pool, close } = createPostgresPool(databaseUrl);
  return {
    repository: new PostgresArtifactInspectionRepository(pool),
    close,
  };
}
