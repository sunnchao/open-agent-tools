import type {
  BuildJobRecord,
  BuildJobSummary,
  ClientQuotaRecord,
  MarketplaceService,
  McpServiceRecord,
  McpServiceVersionRecord,
  PublishedVersionResult,
  UsageEventQuery,
  UsageEventRecord,
  UsageSummary,
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
  getServiceEnvironment(id: string): Promise<Record<string, string>>;
  saveServiceEnvironment(
    id: string,
    environment: Record<string, string>,
    expectedRevision: number,
    now: string,
  ): Promise<McpServiceRecord>;
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
  listMarketplaceServices(limit?: number): Promise<MarketplaceService[]>;
  listClientQuotas(clientId: string): Promise<ClientQuotaRecord[]>;
  upsertClientQuota(quota: ClientQuotaRecord): Promise<ClientQuotaRecord>;
  listUsageEvents(clientId: string, query: UsageEventQuery): Promise<UsageEventRecord[]>;
  summarizeUsage(clientId: string, query: UsageEventQuery): Promise<UsageSummary>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryMcpManagementRepository implements McpManagementRepository {
  readonly services = new Map<string, McpServiceRecord>();
  readonly environments = new Map<string, Record<string, string>>();
  readonly versions = new Map<string, McpServiceVersionRecord>();
  readonly buildJobs = new Map<string, BuildJobRecord>();
  readonly clientQuotas = new Map<string, ClientQuotaRecord>();
  readonly usageEvents = new Map<string, UsageEventRecord>();

  async createManagedService(
    service: McpServiceRecord,
    draftVersion: McpServiceVersionRecord,
  ): Promise<void> {
    const duplicateSlug = [...this.services.values()].some(
      (item) => item.status !== "DELETED" && item.slug === service.slug,
    );
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
      service.status !== "DELETED" &&
      [...this.services.values()].some(
        (item) => item.status !== "DELETED" && item.id !== service.id && item.slug === service.slug,
      )
    ) {
      throw new RepositoryConflictError(`Service slug already exists: ${service.slug}`);
    }
    this.services.set(service.id, clone(service));
    return clone(service);
  }

  async getServiceEnvironment(id: string): Promise<Record<string, string>> {
    return clone(this.environments.get(id) ?? {});
  }

  async saveServiceEnvironment(
    id: string,
    environment: Record<string, string>,
    expectedRevision: number,
    now: string,
  ): Promise<McpServiceRecord> {
    const current = this.services.get(id);
    if (!current || current.status === "DELETED") {
      throw new RepositoryNotFoundError(`Service not found: ${id}`);
    }
    if (current.revision !== expectedRevision) {
      throw new RepositoryConflictError(`Service revision conflict: ${id}`);
    }
    const updated = { ...current, revision: current.revision + 1, updatedAt: now };
    this.services.set(id, clone(updated));
    this.environments.set(id, clone(environment));
    return clone(updated);
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

  async listMarketplaceServices(limit = 200): Promise<MarketplaceService[]> {
    return [...this.services.values()]
      .filter((service) => {
        if (service.status !== "ACTIVE" || service.currentVersionId === null) return false;
        const version = this.versions.get(service.currentVersionId);
        return version?.status === "PUBLISHED";
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((service) => {
        const version = this.versions.get(service.currentVersionId!)!;
        const remote = service.type === "REMOTE_MCP";
        return {
          id: service.id,
          name: service.name,
          slug: service.slug,
          type: service.type,
          versionId: version.id,
          versionNumber: version.versionNumber,
          toolCount: remote ? null : version.tools.length,
          promptCount: version.prompts.length,
          toolsUnknown: remote,
          tools: remote
            ? []
            : version.tools.map((tool) => ({
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
              })),
          prompts: version.prompts.map((prompt) => ({
            name: prompt.name,
            ...(prompt.title === undefined ? {} : { title: prompt.title }),
          })),
        };
      });
  }

  async listClientQuotas(clientId: string): Promise<ClientQuotaRecord[]> {
    return [...this.clientQuotas.values()]
      .filter((quota) => quota.clientId === clientId)
      .sort((left, right) => {
        if (left.serviceId === right.serviceId) return 0;
        if (left.serviceId === null) return -1;
        if (right.serviceId === null) return 1;
        return left.serviceId.localeCompare(right.serviceId);
      })
      .map(clone);
  }

  async upsertClientQuota(quota: ClientQuotaRecord): Promise<ClientQuotaRecord> {
    this.clientQuotas.set(quota.id, clone(quota));
    return clone(quota);
  }

  async listUsageEvents(clientId: string, query: UsageEventQuery): Promise<UsageEventRecord[]> {
    const from = query.from === undefined ? null : Date.parse(query.from);
    const to = query.to === undefined ? null : Date.parse(query.to);
    return [...this.usageEvents.values()]
      .filter((event) => {
        if (event.clientId !== clientId) return false;
        if (query.serviceId !== undefined && event.serviceId !== query.serviceId) return false;
        const createdAt = Date.parse(event.createdAt);
        return (from === null || createdAt >= from) && (to === null || createdAt <= to);
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, query.limit)
      .map(clone);
  }

  async summarizeUsage(clientId: string, query: UsageEventQuery): Promise<UsageSummary> {
    const from = query.from === undefined ? null : Date.parse(query.from);
    const to = query.to === undefined ? null : Date.parse(query.to);
    const events = [...this.usageEvents.values()].filter((event) => {
      if (event.clientId !== clientId) return false;
      if (query.serviceId !== undefined && event.serviceId !== query.serviceId) return false;
      const createdAt = Date.parse(event.createdAt);
      return (from === null || createdAt >= from) && (to === null || createdAt <= to);
    });
    return {
      total: events.length,
      reserved: events.filter((event) => event.status === "RESERVED").length,
      succeeded: events.filter((event) => event.status === "SUCCEEDED").length,
      failed: events.filter((event) => event.status === "FAILED").length,
    };
  }
}
