import type {
  BuildJobRecord,
  BuildJobSummary,
  McpServiceRecord,
  McpServiceVersionRecord,
  PublishedVersionResult,
} from "./types.js";

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export class RepositoryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryNotFoundError";
  }
}

export interface McpManagementRepository {
  createManagedService(
    service: McpServiceRecord,
    draftVersion: McpServiceVersionRecord,
  ): Promise<void>;
  createVersion(version: McpServiceVersionRecord): Promise<void>;
  listServices(): Promise<McpServiceRecord[]>;
  getService(id: string): Promise<McpServiceRecord | null>;
  saveService(service: McpServiceRecord, expectedRevision: number): Promise<McpServiceRecord>;
  getVersion(id: string): Promise<McpServiceVersionRecord | null>;
  listVersions(serviceId: string): Promise<McpServiceVersionRecord[]>;
  saveVersion(
    version: McpServiceVersionRecord,
    expectedRevision: number,
  ): Promise<McpServiceVersionRecord>;
  queueBuildJob(
    version: McpServiceVersionRecord,
    expectedRevision: number,
    job: BuildJobRecord,
  ): Promise<{ version: McpServiceVersionRecord; job: BuildJobRecord }>;
  getBuildJob(id: string): Promise<BuildJobRecord | null>;
  listBuildJobs(limit: number): Promise<BuildJobSummary[]>;
  publishVersion(
    versionId: string,
    expectedRevision: number,
    now: string,
  ): Promise<PublishedVersionResult>;
  rollbackVersion(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    now: string,
  ): Promise<PublishedVersionResult>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryMcpManagementRepository implements McpManagementRepository {
  readonly services = new Map<string, McpServiceRecord>();
  readonly versions = new Map<string, McpServiceVersionRecord>();
  readonly buildJobs = new Map<string, BuildJobRecord>();

  async createManagedService(
    service: McpServiceRecord,
    draftVersion: McpServiceVersionRecord,
  ): Promise<void> {
    const duplicateSlug = [...this.services.values()].some((item) => item.slug === service.slug);
    if (duplicateSlug) {
      throw new RepositoryConflictError(`Service slug already exists: ${service.slug}`);
    }
    this.services.set(service.id, clone(service));
    this.versions.set(draftVersion.id, clone(draftVersion));
  }

  async createVersion(version: McpServiceVersionRecord): Promise<void> {
    this.versions.set(version.id, clone(version));
  }

  async listServices(): Promise<McpServiceRecord[]> {
    return [...this.services.values()]
      .filter((service) => service.status !== "DELETED")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(clone);
  }

  async getService(id: string): Promise<McpServiceRecord | null> {
    const service = this.services.get(id);
    return service ? clone(service) : null;
  }

  async saveService(
    service: McpServiceRecord,
    expectedRevision: number,
  ): Promise<McpServiceRecord> {
    const current = this.services.get(service.id);
    if (!current) throw new RepositoryNotFoundError(`Service not found: ${service.id}`);
    if (current.revision !== expectedRevision) {
      throw new RepositoryConflictError(
        `Service revision conflict: expected ${expectedRevision}, current ${current.revision}`,
      );
    }
    if (
      [...this.services.values()].some(
        (item) => item.id !== service.id && item.slug === service.slug,
      )
    ) {
      throw new RepositoryConflictError(`Service slug already exists: ${service.slug}`);
    }
    this.services.set(service.id, clone(service));
    return clone(service);
  }

  async getVersion(id: string): Promise<McpServiceVersionRecord | null> {
    const version = this.versions.get(id);
    return version ? clone(version) : null;
  }

  async listVersions(serviceId: string): Promise<McpServiceVersionRecord[]> {
    return [...this.versions.values()]
      .filter((version) => version.serviceId === serviceId)
      .sort((left, right) => right.versionNumber - left.versionNumber)
      .map(clone);
  }

  async saveVersion(
    version: McpServiceVersionRecord,
    expectedRevision: number,
  ): Promise<McpServiceVersionRecord> {
    const current = this.versions.get(version.id);
    if (!current) throw new RepositoryNotFoundError(`Version not found: ${version.id}`);
    if (current.revision !== expectedRevision) {
      throw new RepositoryConflictError(
        `Version revision conflict: expected ${expectedRevision}, current ${current.revision}`,
      );
    }
    this.versions.set(version.id, clone(version));
    return clone(version);
  }

  async queueBuildJob(
    version: McpServiceVersionRecord,
    expectedRevision: number,
    job: BuildJobRecord,
  ): Promise<{ version: McpServiceVersionRecord; job: BuildJobRecord }> {
    const current = this.versions.get(version.id);
    if (!current) throw new RepositoryNotFoundError(`Version not found: ${version.id}`);
    if (current.revision !== expectedRevision) {
      throw new RepositoryConflictError(
        `Version revision conflict: expected ${expectedRevision}, current ${current.revision}`,
      );
    }
    if (this.buildJobs.has(job.id)) {
      throw new RepositoryConflictError(`Build job already exists: ${job.id}`);
    }
    this.versions.set(version.id, clone(version));
    this.buildJobs.set(job.id, clone(job));
    return { version: clone(version), job: clone(job) };
  }

  async getBuildJob(id: string): Promise<BuildJobRecord | null> {
    const job = this.buildJobs.get(id);
    return job ? clone(job) : null;
  }

  async listBuildJobs(limit: number): Promise<BuildJobSummary[]> {
    return [...this.buildJobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .flatMap((job) => {
        const version = this.versions.get(job.versionId);
        const service = version ? this.services.get(version.serviceId) : null;
        return version && service
          ? [
              {
                ...clone(job),
                serviceId: service.id,
                serviceName: service.name,
                versionNumber: version.versionNumber,
              },
            ]
          : [];
      });
  }

  async publishVersion(
    versionId: string,
    expectedRevision: number,
    now: string,
  ): Promise<PublishedVersionResult> {
    const version = this.versions.get(versionId);
    if (!version) throw new RepositoryNotFoundError(`Version not found: ${versionId}`);
    if (version.revision !== expectedRevision) {
      throw new RepositoryConflictError(
        `Version revision conflict: expected ${expectedRevision}, current ${version.revision}`,
      );
    }
    if (version.status !== "READY") {
      throw new RepositoryConflictError(`Version is not ready: ${version.status}`);
    }

    const service = this.services.get(version.serviceId);
    if (!service) throw new RepositoryNotFoundError(`Service not found: ${version.serviceId}`);

    if (service.currentVersionId) {
      const current = this.versions.get(service.currentVersionId);
      if (current && current.id !== version.id && current.status === "PUBLISHED") {
        this.versions.set(current.id, {
          ...current,
          status: "SUPERSEDED",
          revision: current.revision + 1,
          updatedAt: now,
        });
      }
    }

    const publishedVersion: McpServiceVersionRecord = {
      ...version,
      status: "PUBLISHED",
      revision: version.revision + 1,
      updatedAt: now,
    };
    const activeService: McpServiceRecord = {
      ...service,
      status: "ACTIVE",
      currentVersionId: version.id,
      revision: service.revision + 1,
      updatedAt: now,
    };
    this.versions.set(version.id, clone(publishedVersion));
    this.services.set(service.id, clone(activeService));

    return { service: clone(activeService), version: clone(publishedVersion) };
  }

  async rollbackVersion(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    now: string,
  ): Promise<PublishedVersionResult> {
    const service = this.services.get(serviceId);
    if (!service) throw new RepositoryNotFoundError(`Service not found: ${serviceId}`);
    const version = this.versions.get(versionId);
    if (!version || version.serviceId !== serviceId) {
      throw new RepositoryNotFoundError(`Version not found: ${versionId}`);
    }
    if (version.revision !== expectedRevision) {
      throw new RepositoryConflictError(
        `Version revision conflict: expected ${expectedRevision}, current ${version.revision}`,
      );
    }
    if (
      service.status !== "ACTIVE" ||
      service.currentVersionId === versionId ||
      (version.status !== "READY" && version.status !== "SUPERSEDED")
    ) {
      throw new RepositoryConflictError(`Version cannot be rolled back: ${versionId}`);
    }

    const current = service.currentVersionId ? this.versions.get(service.currentVersionId) : null;
    if (!current || current.status !== "PUBLISHED") {
      throw new RepositoryConflictError(`Current version is unavailable for service: ${serviceId}`);
    }

    const publishedVersion: McpServiceVersionRecord = {
      ...version,
      status: "PUBLISHED",
      revision: version.revision + 1,
      updatedAt: now,
    };
    const supersededCurrent: McpServiceVersionRecord = {
      ...current,
      status: "SUPERSEDED",
      revision: current.revision + 1,
      updatedAt: now,
    };
    const activeService: McpServiceRecord = {
      ...service,
      currentVersionId: versionId,
      revision: service.revision + 1,
      updatedAt: now,
    };
    this.versions.set(publishedVersion.id, clone(publishedVersion));
    this.versions.set(supersededCurrent.id, clone(supersededCurrent));
    this.services.set(activeService.id, clone(activeService));

    return { service: clone(activeService), version: clone(publishedVersion) };
  }
}
