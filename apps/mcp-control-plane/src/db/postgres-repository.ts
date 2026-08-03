import { and, asc, desc, eq, getTableColumns, ne, or, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type McpManagementRepository,
} from "../repository.js";
import type {
  BuildJobRecord,
  BuildJobSummary,
  ConfiguredPrompt,
  ConfiguredTool,
  McpServiceRecord,
  McpServiceVersionRecord,
  PublishedVersionResult,
} from "../types.js";
import * as schema from "./schema.js";
import { mcpBuildJobs, mcpPrompts, mcpServices, mcpServiceVersions, mcpTools } from "./schema.js";

type Database = NodePgDatabase<typeof schema>;
type ServiceRow = typeof mcpServices.$inferSelect;
type VersionRow = typeof mcpServiceVersions.$inferSelect;
type BuildJobRow = typeof mcpBuildJobs.$inferSelect;

function isPostgresError(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && (current as { code?: unknown }).code === code) return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function mapService(row: ServiceRow): McpServiceRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    currentVersionId: row.currentVersionId,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function mapVersion(
  row: VersionRow,
  tools: ConfiguredTool[],
  prompts: ConfiguredPrompt[],
): McpServiceVersionRecord {
  const runtime =
    row.runtimeName === "nodejs" && row.runtimeVersion === "20"
      ? ({ name: "nodejs", version: "20" } as const)
      : null;
  return {
    id: row.id,
    serviceId: row.serviceId,
    versionNumber: row.versionNumber,
    status: row.status,
    runtime,
    entry: row.entry,
    buildCommand: row.buildCommand === "npm run build" ? row.buildCommand : null,
    limits: row.limits,
    artifactDigest: row.artifactDigest,
    artifactObjectKey: row.artifactObjectKey,
    artifactSize: row.artifactSize,
    imageDigest: row.imageDigest,
    tools,
    prompts,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function versionValues(version: McpServiceVersionRecord) {
  return {
    id: version.id,
    serviceId: version.serviceId,
    versionNumber: version.versionNumber,
    status: version.status,
    runtimeName: version.runtime?.name ?? null,
    runtimeVersion: version.runtime?.version ?? null,
    entry: version.entry,
    buildCommand: version.buildCommand,
    limits: version.limits,
    artifactDigest: version.artifactDigest,
    artifactObjectKey: version.artifactObjectKey,
    artifactSize: version.artifactSize,
    imageDigest: version.imageDigest,
    revision: version.revision,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

function mapBuildJob(row: BuildJobRow): BuildJobRecord {
  return {
    id: row.id,
    versionId: row.versionId,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    artifactObjectKey: row.artifactObjectKey,
    artifactDigest: row.artifactDigest,
    artifactSize: row.artifactSize,
    imageDigest: row.imageDigest,
    sbomObjectKey: row.sbomObjectKey,
    errorCode: row.errorCode,
    attempt: row.attempt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresMcpManagementRepository implements McpManagementRepository {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  async createManagedService(
    service: McpServiceRecord,
    draftVersion: McpServiceVersionRecord,
  ): Promise<void> {
    try {
      await this.#db.transaction(async (transaction) => {
        await transaction.insert(mcpServices).values(service);
        await transaction.insert(mcpServiceVersions).values(versionValues(draftVersion));
      });
    } catch (error) {
      if (isPostgresError(error, "23505")) {
        throw new RepositoryConflictError(`Service slug already exists: ${service.slug}`);
      }
      throw error;
    }
  }

  async createVersion(version: McpServiceVersionRecord): Promise<void> {
    await this.#db.transaction(async (transaction) => {
      await transaction.insert(mcpServiceVersions).values(versionValues(version));
      if (version.tools.length > 0) {
        await transaction.insert(mcpTools).values(
          version.tools.map((tool, position) => ({
            id: tool.id,
            versionId: version.id,
            name: tool.name,
            description: tool.description ?? null,
            handler: tool.handler,
            inputSchema: tool.inputSchema,
            position,
          })),
        );
      }
      if (version.prompts.length > 0) {
        await transaction.insert(mcpPrompts).values(
          version.prompts.map((prompt, position) => ({
            id: prompt.id,
            versionId: version.id,
            name: prompt.name,
            title: prompt.title ?? null,
            description: prompt.description ?? null,
            arguments: prompt.arguments,
            messages: prompt.messages,
            position,
          })),
        );
      }
    });
  }

  async listServices(): Promise<McpServiceRecord[]> {
    const rows = await this.#db
      .select()
      .from(mcpServices)
      .where(ne(mcpServices.status, "DELETED"))
      .orderBy(desc(mcpServices.updatedAt));
    return rows.map(mapService);
  }

  async getService(id: string): Promise<McpServiceRecord | null> {
    const [row] = await this.#db.select().from(mcpServices).where(eq(mcpServices.id, id)).limit(1);
    return row ? mapService(row) : null;
  }

  async saveService(
    service: McpServiceRecord,
    expectedRevision: number,
  ): Promise<McpServiceRecord> {
    try {
      const [row] = await this.#db
        .update(mcpServices)
        .set({
          name: service.name,
          slug: service.slug,
          status: service.status,
          currentVersionId: service.currentVersionId,
          revision: service.revision,
          updatedAt: service.updatedAt,
          deletedAt: service.deletedAt,
        })
        .where(and(eq(mcpServices.id, service.id), eq(mcpServices.revision, expectedRevision)))
        .returning();
      if (!row) throw new RepositoryConflictError(`Service revision conflict: ${service.id}`);
      return mapService(row);
    } catch (error) {
      if (isPostgresError(error, "23505")) {
        throw new RepositoryConflictError(`Service slug already exists: ${service.slug}`);
      }
      throw error;
    }
  }

  async getVersion(id: string): Promise<McpServiceVersionRecord | null> {
    const [row] = await this.#db
      .select()
      .from(mcpServiceVersions)
      .where(eq(mcpServiceVersions.id, id))
      .limit(1);
    if (!row) return null;
    const [tools, prompts] = await Promise.all([this.#loadTools(id), this.#loadPrompts(id)]);
    return mapVersion(row, tools, prompts);
  }

  async listVersions(serviceId: string): Promise<McpServiceVersionRecord[]> {
    const rows = await this.#db
      .select()
      .from(mcpServiceVersions)
      .where(eq(mcpServiceVersions.serviceId, serviceId))
      .orderBy(desc(mcpServiceVersions.versionNumber));
    return Promise.all(
      rows.map(async (row) => {
        const [tools, prompts] = await Promise.all([
          this.#loadTools(row.id),
          this.#loadPrompts(row.id),
        ]);
        return mapVersion(row, tools, prompts);
      }),
    );
  }

  async saveVersion(
    version: McpServiceVersionRecord,
    expectedRevision: number,
  ): Promise<McpServiceVersionRecord> {
    const saved = await this.#db.transaction(async (transaction) => {
      const [row] = await transaction
        .update(mcpServiceVersions)
        .set(versionValues(version))
        .where(
          and(
            eq(mcpServiceVersions.id, version.id),
            eq(mcpServiceVersions.revision, expectedRevision),
          ),
        )
        .returning();
      if (!row) throw new RepositoryConflictError(`Version revision conflict: ${version.id}`);

      await transaction.delete(mcpTools).where(eq(mcpTools.versionId, version.id));
      await transaction.delete(mcpPrompts).where(eq(mcpPrompts.versionId, version.id));
      if (version.tools.length > 0) {
        await transaction.insert(mcpTools).values(
          version.tools.map((tool, position) => ({
            id: tool.id,
            versionId: version.id,
            name: tool.name,
            description: tool.description ?? null,
            handler: tool.handler,
            inputSchema: tool.inputSchema,
            position,
          })),
        );
      }
      if (version.prompts.length > 0) {
        await transaction.insert(mcpPrompts).values(
          version.prompts.map((prompt, position) => ({
            id: prompt.id,
            versionId: version.id,
            name: prompt.name,
            title: prompt.title ?? null,
            description: prompt.description ?? null,
            arguments: prompt.arguments,
            messages: prompt.messages,
            position,
          })),
        );
      }
      return row;
    });
    return mapVersion(saved, structuredClone(version.tools), structuredClone(version.prompts));
  }

  async queueBuildJob(
    version: McpServiceVersionRecord,
    expectedRevision: number,
    job: BuildJobRecord,
  ): Promise<{ version: McpServiceVersionRecord; job: BuildJobRecord }> {
    const saved = await this.#db.transaction(async (transaction) => {
      const [versionRow] = await transaction
        .update(mcpServiceVersions)
        .set(versionValues(version))
        .where(
          and(
            eq(mcpServiceVersions.id, version.id),
            eq(mcpServiceVersions.revision, expectedRevision),
          ),
        )
        .returning();
      if (!versionRow) {
        throw new RepositoryConflictError(`Version revision conflict: ${version.id}`);
      }
      const [jobRow] = await transaction.insert(mcpBuildJobs).values(job).returning();
      if (!jobRow) throw new RepositoryConflictError(`Build job was not created: ${job.id}`);
      return { versionRow, jobRow };
    });

    return {
      version: mapVersion(
        saved.versionRow,
        structuredClone(version.tools),
        structuredClone(version.prompts),
      ),
      job: mapBuildJob(saved.jobRow),
    };
  }

  async getBuildJob(id: string): Promise<BuildJobRecord | null> {
    const [row] = await this.#db
      .select()
      .from(mcpBuildJobs)
      .where(eq(mcpBuildJobs.id, id))
      .limit(1);
    return row ? mapBuildJob(row) : null;
  }

  async listBuildJobs(limit: number): Promise<BuildJobSummary[]> {
    const rows = await this.#db
      .select({
        ...getTableColumns(mcpBuildJobs),
        serviceId: mcpServiceVersions.serviceId,
        serviceName: mcpServices.name,
        versionNumber: mcpServiceVersions.versionNumber,
      })
      .from(mcpBuildJobs)
      .innerJoin(mcpServiceVersions, eq(mcpServiceVersions.id, mcpBuildJobs.versionId))
      .innerJoin(mcpServices, eq(mcpServices.id, mcpServiceVersions.serviceId))
      .orderBy(desc(mcpBuildJobs.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      ...mapBuildJob(row),
      serviceId: row.serviceId,
      serviceName: row.serviceName,
      versionNumber: row.versionNumber,
    }));
  }

  async publishVersion(
    versionId: string,
    expectedRevision: number,
    now: string,
  ): Promise<PublishedVersionResult> {
    const version = await this.getVersion(versionId);
    if (!version) throw new RepositoryNotFoundError(`Version not found: ${versionId}`);

    const result = await this.#db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${mcpServices} where ${mcpServices.id} = ${version.serviceId} for update`,
      );
      const [service] = await transaction
        .select()
        .from(mcpServices)
        .where(eq(mcpServices.id, version.serviceId))
        .limit(1);
      if (!service) {
        throw new RepositoryNotFoundError(`Service not found: ${version.serviceId}`);
      }

      const [published] = await transaction
        .update(mcpServiceVersions)
        .set({ status: "PUBLISHED", revision: expectedRevision + 1, updatedAt: now })
        .where(
          and(
            eq(mcpServiceVersions.id, versionId),
            eq(mcpServiceVersions.revision, expectedRevision),
            eq(mcpServiceVersions.status, "READY"),
          ),
        )
        .returning();
      if (!published) {
        throw new RepositoryConflictError(
          `Version is not ready or revision is stale: ${versionId}`,
        );
      }

      if (service.currentVersionId && service.currentVersionId !== versionId) {
        await transaction
          .update(mcpServiceVersions)
          .set({
            status: "SUPERSEDED",
            revision: sql`${mcpServiceVersions.revision} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(mcpServiceVersions.id, service.currentVersionId),
              eq(mcpServiceVersions.status, "PUBLISHED"),
            ),
          );
      }

      const [activeService] = await transaction
        .update(mcpServices)
        .set({
          status: "ACTIVE",
          currentVersionId: versionId,
          revision: service.revision + 1,
          updatedAt: now,
        })
        .where(eq(mcpServices.id, service.id))
        .returning();
      if (!activeService) throw new RepositoryNotFoundError(`Service not found: ${service.id}`);
      return { service: activeService, version: published };
    });

    return {
      service: mapService(result.service),
      version: mapVersion(result.version, version.tools, version.prompts),
    };
  }

  async rollbackVersion(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    now: string,
  ): Promise<PublishedVersionResult> {
    const version = await this.getVersion(versionId);
    if (!version || version.serviceId !== serviceId) {
      throw new RepositoryNotFoundError(`Version not found: ${versionId}`);
    }

    const result = await this.#db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${mcpServices} where ${mcpServices.id} = ${serviceId} for update`,
      );
      const [service] = await transaction
        .select()
        .from(mcpServices)
        .where(eq(mcpServices.id, serviceId))
        .limit(1);
      if (!service) throw new RepositoryNotFoundError(`Service not found: ${serviceId}`);
      if (!service.currentVersionId || service.status !== "ACTIVE") {
        throw new RepositoryConflictError(`Service cannot be rolled back: ${serviceId}`);
      }
      if (service.currentVersionId === versionId) {
        throw new RepositoryConflictError(`Version is already current: ${versionId}`);
      }

      const [published] = await transaction
        .update(mcpServiceVersions)
        .set({ status: "PUBLISHED", revision: expectedRevision + 1, updatedAt: now })
        .where(
          and(
            eq(mcpServiceVersions.id, versionId),
            eq(mcpServiceVersions.serviceId, serviceId),
            eq(mcpServiceVersions.revision, expectedRevision),
            or(eq(mcpServiceVersions.status, "READY"), eq(mcpServiceVersions.status, "SUPERSEDED")),
          ),
        )
        .returning();
      if (!published) {
        throw new RepositoryConflictError(`Version cannot be rolled back: ${versionId}`);
      }

      await transaction
        .update(mcpServiceVersions)
        .set({
          status: "SUPERSEDED",
          revision: sql`${mcpServiceVersions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(mcpServiceVersions.id, service.currentVersionId),
            eq(mcpServiceVersions.status, "PUBLISHED"),
          ),
        );

      const [activeService] = await transaction
        .update(mcpServices)
        .set({
          status: "ACTIVE",
          currentVersionId: versionId,
          revision: sql`${mcpServices.revision} + 1`,
          updatedAt: now,
        })
        .where(and(eq(mcpServices.id, serviceId), eq(mcpServices.status, "ACTIVE")))
        .returning();
      if (!activeService) throw new RepositoryNotFoundError(`Service not found: ${serviceId}`);
      return { service: activeService, version: published };
    });

    return {
      service: mapService(result.service),
      version: mapVersion(result.version, version.tools, version.prompts),
    };
  }

  async #loadTools(versionId: string): Promise<ConfiguredTool[]> {
    const rows = await this.#db
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.versionId, versionId))
      .orderBy(asc(mcpTools.position));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      handler: row.handler,
      inputSchema: row.inputSchema,
    }));
  }

  async #loadPrompts(versionId: string): Promise<ConfiguredPrompt[]> {
    const rows = await this.#db
      .select()
      .from(mcpPrompts)
      .where(eq(mcpPrompts.versionId, versionId))
      .orderBy(asc(mcpPrompts.position));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.description === null ? {} : { description: row.description }),
      arguments: row.arguments,
      messages: row.messages,
    }));
  }
}

export function createPostgresRepository(connectionString: string): {
  repository: PostgresMcpManagementRepository;
  close: () => Promise<void>;
} {
  const pool = new Pool({ connectionString });
  const database = drizzle(pool, { schema });
  return {
    repository: new PostgresMcpManagementRepository(database),
    close: () => pool.end(),
  };
}
