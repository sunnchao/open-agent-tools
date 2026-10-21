import { randomUUID } from "node:crypto";
import {
  ExecutionLimitsSchema,
  ManagedMcpManifestSchema,
  ManagedToolSchema,
  PromptDefinitionSchema,
  RemoteServiceConfigPatchSchema,
  RemoteServiceConfigSchema,
  ToolEnvironmentSchema,
  ToolEnvironmentUpdateSchema,
  maskRemoteConfig,
  mergeRemoteConfig,
  renderPrompt,
  type ManagedMcpManifest,
  type ManagedTool,
  type PromptDefinition,
  type RemoteServiceConfig,
  type RemoteServiceConfigPublic,
  type RenderedPrompt,
} from "@open-agent-tools/mcp-contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type McpManagementRepository,
} from "./repository.js";
import type {
  Actor,
  BuildJobRecord,
  BuildJobSummary,
  MarketplaceService,
  McpServiceRecord,
  McpServiceEnvironment,
  McpServiceVersionRecord,
  PublishedVersionResult,
} from "./types.js";

export type { Actor } from "./types.js";

export type IdGenerator = () => string;

export type ManagementErrorCode =
  | "CONFLICT"
  | "FORBIDDEN"
  | "IMMUTABLE_VERSION"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "UPSTREAM_ERROR"
  | "VALIDATION_ERROR";

export class ManagementError extends Error {
  readonly code: ManagementErrorCode;
  readonly details?: unknown;

  constructor(code: ManagementErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ManagementError";
    this.code = code;
    this.details = details;
  }
}

const CreateServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/),
  })
  .strict();

const UpdateServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/)
      .optional(),
  })
  .strict();

const CreateRemoteServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/),
    remote: RemoteServiceConfigSchema,
  })
  .strict();

const UpdateToolSchema = ManagedToolSchema.partial().strict();
const UpdatePromptSchema = z
  .object({
    name: z.unknown().optional(),
    title: z.unknown().optional(),
    description: z.unknown().optional(),
    arguments: z.unknown().optional(),
    messages: z.unknown().optional(),
  })
  .strict();
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export interface McpManagementServiceOptions {
  createId?: IdGenerator;
  now?: () => string;
  /** 远端连通性探测的 fetch 实现；缺省用全局 fetch，便于测试注入。 */
  fetchRemote?: typeof fetch;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ManagementError("VALIDATION_ERROR", "Request validation failed", result.error.issues);
  }
  return result.data;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof RepositoryConflictError) {
    throw new ManagementError("CONFLICT", error.message);
  }
  if (error instanceof RepositoryNotFoundError) {
    throw new ManagementError("NOT_FOUND", error.message);
  }
  throw error;
}

function requireEditor(actor: Actor): void {
  if (actor.role === "auditor") {
    throw new ManagementError("FORBIDDEN", "This operation requires admin or operator access");
  }
}

function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new ManagementError("FORBIDDEN", "This operation requires admin access");
  }
}

function requireDraft(version: McpServiceVersionRecord): void {
  if (version.status !== "DRAFT") {
    throw new ManagementError(
      "IMMUTABLE_VERSION",
      `Version ${version.id} is immutable in status ${version.status}`,
    );
  }
}

function requireDraftOrFailed(version: McpServiceVersionRecord): void {
  if (version.status !== "DRAFT" && version.status !== "FAILED") {
    throw new ManagementError(
      "IMMUTABLE_VERSION",
      `Version ${version.id} cannot be retried in status ${version.status}`,
    );
  }
}

function requireReuploadable(version: McpServiceVersionRecord): void {
  if (
    version.status !== "DRAFT" &&
    version.status !== "FAILED" &&
    version.status !== "VALIDATING" &&
    version.status !== "BUILDING"
  ) {
    throw new ManagementError(
      "IMMUTABLE_VERSION",
      `Version ${version.id} cannot accept a replacement package in status ${version.status}`,
    );
  }
}

function withoutId<T extends { id: string }>(value: T): Omit<T, "id"> {
  const { id: _id, ...rest } = value;
  return rest;
}

export class McpManagementService {
  readonly #repository: McpManagementRepository;
  readonly #createId: IdGenerator;
  readonly #now: () => string;
  readonly #fetchRemote: typeof fetch;

  constructor(repository: McpManagementRepository, options: McpManagementServiceOptions = {}) {
    this.#repository = repository;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#fetchRemote = options.fetchRemote ?? fetch;
  }

  async createManagedService(
    input: { name: string; slug: string },
    actor: Actor,
  ): Promise<{ service: McpServiceRecord; draftVersion: McpServiceVersionRecord }> {
    requireEditor(actor);
    const parsed = parse(CreateServiceSchema, input);
    const now = this.#now();
    const service: McpServiceRecord = {
      id: this.#createId(),
      name: parsed.name,
      slug: parsed.slug,
      type: "MANAGED_MCP",
      status: "DRAFT",
      currentVersionId: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const draftVersion: McpServiceVersionRecord = {
      id: this.#createId(),
      serviceId: service.id,
      versionNumber: 1,
      status: "DRAFT",
      runtime: null,
      entry: null,
      buildCommand: null,
      limits: null,
      artifactDigest: null,
      artifactObjectKey: null,
      artifactSize: null,
      imageDigest: null,
      remoteConfig: null,
      tools: [],
      prompts: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.#repository.createManagedService(service, draftVersion);
    } catch (error) {
      mapRepositoryError(error);
    }
    return { service, draftVersion };
  }

  /**
   * 注册第三方远程 MCP 服务：仅保存接入配置，无需构建。
   * 版本直接置为 READY 并发布，从而使 Gateway 立即可以代理其 Tool。
   */
  async createRemoteService(
    input: unknown,
    actor: Actor,
  ): Promise<{ service: McpServiceRecord; draftVersion: McpServiceVersionRecord }> {
    requireAdmin(actor);
    const parsed = parse(CreateRemoteServiceSchema, input);
    const now = this.#now();
    const remote: RemoteServiceConfig = parsed.remote;
    const service: McpServiceRecord = {
      id: this.#createId(),
      name: parsed.name,
      slug: parsed.slug,
      type: "REMOTE_MCP",
      status: "DRAFT",
      currentVersionId: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const draftVersion: McpServiceVersionRecord = {
      id: this.#createId(),
      serviceId: service.id,
      versionNumber: 1,
      status: "READY",
      runtime: null,
      entry: null,
      buildCommand: null,
      limits: null,
      artifactDigest: null,
      artifactObjectKey: null,
      artifactSize: null,
      imageDigest: null,
      remoteConfig: remote,
      tools: [],
      prompts: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.#repository.createManagedService(service, draftVersion);
      const published = await this.#repository.publishVersion(
        draftVersion.id,
        draftVersion.revision,
        now,
      );
      return { service: published.service, draftVersion: published.version };
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async listServices(_actor: Actor): Promise<McpServiceRecord[]> {
    return this.#repository.listServices();
  }

  /** 市场只暴露 ACTIVE 服务且其 currentVersion 必须为 PUBLISHED。 */
  async listMarketplaceServices(_actor: Actor, limit = 200): Promise<MarketplaceService[]> {
    return this.#repository.listMarketplaceServices(limit);
  }

  async getService(id: string, _actor: Actor): Promise<McpServiceRecord> {
    const service = await this.#repository.getService(id);
    if (!service || service.status === "DELETED") {
      throw new ManagementError("NOT_FOUND", `Service not found: ${id}`);
    }
    return service;
  }

  async updateService(
    id: string,
    input: { name?: string; slug?: string },
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceRecord> {
    requireEditor(actor);
    const service = await this.getService(id, actor);
    const patch = parse(UpdateServiceSchema, input);
    const updated: McpServiceRecord = {
      ...service,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.slug === undefined ? {} : { slug: patch.slug }),
      revision: service.revision + 1,
      updatedAt: this.#now(),
    };
    try {
      return await this.#repository.saveService(updated, expectedRevision);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async getServiceEnvironment(id: string, actor: Actor): Promise<McpServiceEnvironment> {
    requireEditor(actor);
    const service = await this.getService(id, actor);
    const environment = await this.#repository.getServiceEnvironment(id);
    return {
      environment: Object.fromEntries(Object.keys(environment).map((name) => [name, null])),
      revision: service.revision,
    };
  }

  async updateServiceEnvironment(
    id: string,
    input: unknown,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceEnvironment> {
    requireEditor(actor);
    await this.getService(id, actor);
    const patch = parse(ToolEnvironmentUpdateSchema, input);
    const current = await this.#repository.getServiceEnvironment(id);
    const environment = Object.fromEntries(
      Object.entries(patch).map(([name, value]) => {
        if (value !== null) return [name, value];
        if (!Object.hasOwn(current, name)) {
          throw new ManagementError("VALIDATION_ERROR", `No saved value for variable: ${name}`);
        }
        return [name, current[name]!];
      }),
    );
    parse(ToolEnvironmentSchema, environment);
    try {
      const service = await this.#repository.saveServiceEnvironment(
        id,
        environment,
        expectedRevision,
        this.#now(),
      );
      return {
        environment: Object.fromEntries(Object.keys(environment).map((name) => [name, null])),
        revision: service.revision,
      };
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async deleteService(
    id: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceRecord> {
    requireAdmin(actor);
    const service = await this.getService(id, actor);
    const now = this.#now();
    try {
      return await this.#repository.saveService(
        {
          ...service,
          status: "DELETED",
          revision: service.revision + 1,
          updatedAt: now,
          deletedAt: now,
        },
        expectedRevision,
      );
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async disableService(
    id: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceRecord> {
    requireAdmin(actor);
    const service = await this.getService(id, actor);
    if (service.status !== "ACTIVE" || service.currentVersionId === null) {
      throw new ManagementError("INVALID_STATE", `Service cannot be disabled: ${service.status}`);
    }
    try {
      return await this.#repository.saveService(
        {
          ...service,
          status: "DISABLED",
          revision: service.revision + 1,
          updatedAt: this.#now(),
        },
        expectedRevision,
      );
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async enableService(
    id: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceRecord> {
    requireAdmin(actor);
    const service = await this.getService(id, actor);
    if (service.status !== "DISABLED") {
      throw new ManagementError("INVALID_STATE", `Service cannot be enabled: ${service.status}`);
    }
    try {
      return await this.#repository.saveService(
        {
          ...service,
          status: "ACTIVE",
          revision: service.revision + 1,
          updatedAt: this.#now(),
        },
        expectedRevision,
      );
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async getVersion(id: string, _actor: Actor): Promise<McpServiceVersionRecord> {
    const version = await this.#repository.getVersion(id);
    if (!version) throw new ManagementError("NOT_FOUND", `Version not found: ${id}`);
    return version;
  }

  async listVersions(serviceId: string, actor: Actor): Promise<McpServiceVersionRecord[]> {
    await this.getService(serviceId, actor);
    return this.#repository.listVersions(serviceId);
  }

  async updateVersionLimits(
    versionId: string,
    input: unknown,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    if (version.status === "PUBLISHED" || version.status === "SUPERSEDED") {
      throw new ManagementError(
        "IMMUTABLE_VERSION",
        `Version ${version.id} is immutable in status ${version.status}`,
      );
    }
    if (!["DRAFT", "FAILED", "READY"].includes(version.status)) {
      throw new ManagementError("INVALID_STATE", "Wait for package inspection or build to finish");
    }
    if (version.remoteConfig === null && version.tools.length === 0) {
      throw new ManagementError("INVALID_STATE", "Execution limits require a Tool version");
    }
    const limits = parse(ExecutionLimitsSchema, input);
    return this.#saveVersion({ ...version, limits }, expectedRevision);
  }

  /**
   * 更新 REMOTE_MCP 版本的上游接入配置（token 传 null/省略=保留，空字符串=清除）。
   * 仅 DRAFT/FAILED/READY 可改；PUBLISHED/SUPERSEDED 需 fork 新草稿。
   */
  async updateRemoteConfig(
    versionId: string,
    input: unknown,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    const service = await this.getService(version.serviceId, actor);
    if (service.type !== "REMOTE_MCP") {
      throw new ManagementError(
        "INVALID_STATE",
        "Only REMOTE_MCP versions have a remote configuration",
      );
    }
    if (version.status === "PUBLISHED" || version.status === "SUPERSEDED") {
      throw new ManagementError(
        "IMMUTABLE_VERSION",
        `Version ${version.id} is immutable in status ${version.status}`,
      );
    }
    if (!["DRAFT", "FAILED", "READY"].includes(version.status)) {
      throw new ManagementError("INVALID_STATE", "Wait for the version to become editable");
    }
    if (!version.remoteConfig) {
      throw new ManagementError("INVALID_STATE", "Remote version has no upstream configuration");
    }
    const patch = parse(RemoteServiceConfigPatchSchema, input);
    const remoteConfig = mergeRemoteConfig(version.remoteConfig, patch);
    return this.#saveVersion({ ...version, remoteConfig }, expectedRevision);
  }

  async addTool(
    versionId: string,
    input: ManagedTool,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraft(version);
    const tool = parse(ManagedToolSchema, input);
    if (version.tools.some((item) => item.name === tool.name)) {
      throw new ManagementError("CONFLICT", `Tool name already exists: ${tool.name}`);
    }
    return this.#saveVersion(
      {
        ...version,
        tools: [...version.tools, { id: this.#createId(), ...tool }],
      },
      expectedRevision,
    );
  }

  async updateTool(
    versionId: string,
    toolId: string,
    input: Partial<ManagedTool>,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraft(version);
    const index = version.tools.findIndex((item) => item.id === toolId);
    if (index < 0) throw new ManagementError("NOT_FOUND", `Tool not found: ${toolId}`);
    const patch = parse(UpdateToolSchema, input);
    const updatedTool = parse(ManagedToolSchema, {
      ...withoutId(version.tools[index]!),
      ...patch,
    });
    if (
      version.tools.some((item, itemIndex) => itemIndex !== index && item.name === updatedTool.name)
    ) {
      throw new ManagementError("CONFLICT", `Tool name already exists: ${updatedTool.name}`);
    }
    const tools = [...version.tools];
    tools[index] = { id: toolId, ...updatedTool };
    return this.#saveVersion({ ...version, tools }, expectedRevision);
  }

  async deleteTool(
    versionId: string,
    toolId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraft(version);
    if (!version.tools.some((item) => item.id === toolId)) {
      throw new ManagementError("NOT_FOUND", `Tool not found: ${toolId}`);
    }
    return this.#saveVersion(
      { ...version, tools: version.tools.filter((item) => item.id !== toolId) },
      expectedRevision,
    );
  }

  async addPrompt(
    versionId: string,
    input: PromptDefinition,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraft(version);
    const prompt = parse(PromptDefinitionSchema, input);
    if (version.prompts.some((item) => item.name === prompt.name)) {
      throw new ManagementError("CONFLICT", `Prompt name already exists: ${prompt.name}`);
    }
    return this.#saveVersion(
      {
        ...version,
        prompts: [...version.prompts, { id: this.#createId(), ...prompt }],
      },
      expectedRevision,
    );
  }

  async updatePrompt(
    versionId: string,
    promptId: string,
    input: Partial<PromptDefinition>,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraft(version);
    const index = version.prompts.findIndex((item) => item.id === promptId);
    if (index < 0) throw new ManagementError("NOT_FOUND", `Prompt not found: ${promptId}`);
    const patch = parse(UpdatePromptSchema, input);
    const updatedPrompt = parse(PromptDefinitionSchema, {
      ...withoutId(version.prompts[index]!),
      ...patch,
    });
    if (
      version.prompts.some(
        (item, itemIndex) => itemIndex !== index && item.name === updatedPrompt.name,
      )
    ) {
      throw new ManagementError("CONFLICT", `Prompt name already exists: ${updatedPrompt.name}`);
    }
    const prompts = [...version.prompts];
    prompts[index] = { id: promptId, ...updatedPrompt };
    return this.#saveVersion({ ...version, prompts }, expectedRevision);
  }

  async deletePrompt(
    versionId: string,
    promptId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraft(version);
    if (!version.prompts.some((item) => item.id === promptId)) {
      throw new ManagementError("NOT_FOUND", `Prompt not found: ${promptId}`);
    }
    return this.#saveVersion(
      { ...version, prompts: version.prompts.filter((item) => item.id !== promptId) },
      expectedRevision,
    );
  }

  async previewPrompt(
    versionId: string,
    promptId: string,
    argumentsByName: Record<string, string>,
    actor: Actor,
  ): Promise<RenderedPrompt> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    const prompt = version.prompts.find((item) => item.id === promptId);
    if (!prompt) throw new ManagementError("NOT_FOUND", `Prompt not found: ${promptId}`);
    return renderPrompt(withoutId(prompt) as PromptDefinition, argumentsByName);
  }

  async importPackageManifest(
    versionId: string,
    input: unknown,
    artifactDigest: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraft(version);
    const manifest = parse(ManagedMcpManifestSchema, input);
    if (manifest.tools.length === 0) {
      throw new ManagementError(
        "VALIDATION_ERROR",
        "A Node.js package manifest must configure at least one Tool",
      );
    }

    return this.#saveVersion(
      {
        ...version,
        runtime: manifest.runtime ?? null,
        entry: manifest.entry ?? null,
        buildCommand: manifest.build?.command ?? null,
        limits: manifest.limits ?? null,
        artifactDigest: parse(DigestSchema, artifactDigest),
        imageDigest: null,
        tools: manifest.tools.map((tool) => ({ id: this.#createId(), ...tool })),
        prompts: manifest.prompts.map((prompt) => ({ id: this.#createId(), ...prompt })),
      },
      expectedRevision,
    );
  }

  async confirmArtifactUpload(
    versionId: string,
    input: { objectKey: string; artifactDigest: string; artifactSize: number },
    expectedRevision: number,
    actor: Actor,
  ): Promise<{ version: McpServiceVersionRecord; job: BuildJobRecord }> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireReuploadable(version);
    const artifactDigest = parse(DigestSchema, input.artifactDigest);
    const objectKey = parse(z.string().min(1).max(1024), input.objectKey);
    const artifactSize = parse(
      z
        .number()
        .int()
        .positive()
        .max(50 * 1024 * 1024),
      input.artifactSize,
    );
    const now = this.#now();
    const updated: McpServiceVersionRecord = {
      ...version,
      status: "VALIDATING",
      artifactDigest,
      artifactObjectKey: objectKey,
      artifactSize,
      imageDigest: null,
      revision: version.revision + 1,
      updatedAt: now,
    };
    const job: BuildJobRecord = {
      id: this.#createId(),
      versionId,
      kind: "INSPECT",
      status: "QUEUED",
      stage: "UPLOAD_CONFIRMED",
      artifactObjectKey: objectKey,
      artifactDigest,
      artifactSize,
      imageDigest: null,
      sbomObjectKey: null,
      errorCode: null,
      attempt: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };

    try {
      return await this.#repository.queueBuildJob(updated, expectedRevision, job);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async beginBuild(
    versionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraftOrFailed(version);
    if (version.tools.length === 0 || version.artifactDigest === null) {
      throw new ManagementError(
        "INVALID_STATE",
        "Tool versions require an imported package artifact before build",
      );
    }
    parse(ManagedMcpManifestSchema, manifestFromVersion(version));
    return this.#saveVersion({ ...version, status: "BUILDING" }, expectedRevision);
  }

  async queueBuild(
    versionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<{ version: McpServiceVersionRecord; job: BuildJobRecord }> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraftOrFailed(version);
    if (
      version.tools.length === 0 ||
      version.artifactDigest === null ||
      version.artifactObjectKey === null ||
      version.artifactSize === null
    ) {
      throw new ManagementError(
        "INVALID_STATE",
        "Tool builds require an inspected package artifact",
      );
    }
    parse(ManagedMcpManifestSchema, manifestFromVersion(version));
    const now = this.#now();
    const updated: McpServiceVersionRecord = {
      ...version,
      status: "BUILDING",
      revision: version.revision + 1,
      updatedAt: now,
    };
    const job: BuildJobRecord = {
      id: this.#createId(),
      versionId,
      kind: "BUILD",
      status: "QUEUED",
      stage: "BUILD_QUEUED",
      artifactObjectKey: version.artifactObjectKey,
      artifactDigest: version.artifactDigest,
      artifactSize: version.artifactSize,
      imageDigest: null,
      sbomObjectKey: null,
      errorCode: null,
      attempt: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
    try {
      return await this.#repository.queueBuildJob(updated, expectedRevision, job);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async completeBuild(
    versionId: string,
    imageDigest: string,
    expectedRevision: number,
  ): Promise<McpServiceVersionRecord> {
    const version = await this.#repository.getVersion(versionId);
    if (!version) throw new ManagementError("NOT_FOUND", `Version not found: ${versionId}`);
    if (version.status !== "BUILDING") {
      throw new ManagementError("INVALID_STATE", `Version is not building: ${version.status}`);
    }
    return this.#saveVersion(
      {
        ...version,
        status: "READY",
        imageDigest: parse(DigestSchema, imageDigest),
      },
      expectedRevision,
    );
  }

  async listBuildJobs(limit: number, _actor: Actor): Promise<BuildJobSummary[]> {
    return this.#repository.listBuildJobs(parse(z.number().int().min(1).max(200), limit));
  }

  async resetVersionToDraft(
    versionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    if (version.status !== "READY") {
      throw new ManagementError(
        "INVALID_STATE",
        `Only an unpublished READY version can be reset to draft: ${version.status}`,
      );
    }
    try {
      return await this.#saveVersion(
        {
          ...version,
          status: "DRAFT",
          imageDigest: null,
        },
        expectedRevision,
      );
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async forkDraftVersion(
    serviceId: string,
    versionId: string,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const service = await this.getService(serviceId, actor);
    const version = await this.getVersion(versionId, actor);
    if (version.serviceId !== service.id) {
      throw new ManagementError("NOT_FOUND", `Version not found: ${versionId}`);
    }
    if (version.status !== "PUBLISHED" && version.status !== "SUPERSEDED") {
      throw new ManagementError(
        "INVALID_STATE",
        `Only a published version can be forked: ${version.status}`,
      );
    }
    const versions = await this.#repository.listVersions(service.id);
    const now = this.#now();
    const fork: McpServiceVersionRecord = {
      id: this.#createId(),
      serviceId: service.id,
      versionNumber: (versions[0]?.versionNumber ?? 0) + 1,
      status: "DRAFT",
      runtime: version.runtime,
      entry: version.entry,
      buildCommand: version.buildCommand,
      limits: version.limits,
      artifactDigest: version.artifactDigest,
      artifactObjectKey: version.artifactObjectKey,
      artifactSize: version.artifactSize,
      imageDigest: null,
      remoteConfig: version.remoteConfig,
      tools: version.tools.map((tool) => ({ ...tool, id: this.#createId() })),
      prompts: version.prompts.map((prompt) => ({ ...prompt, id: this.#createId() })),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#repository.createVersion(fork);
    } catch (error) {
      mapRepositoryError(error);
    }
    return fork;
  }

  async validateVersion(
    versionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<McpServiceVersionRecord> {
    requireEditor(actor);
    const version = await this.getVersion(versionId, actor);
    requireDraft(version);

    const service = await this.getService(version.serviceId, actor);
    if (service.type === "REMOTE_MCP") {
      // 远端版本无需构建：校验上游配置合法即就绪；上游 Tool 在网关运行时发现。
      if (!version.remoteConfig) {
        throw new ManagementError("INVALID_STATE", "Remote version has no upstream configuration");
      }
      parse(RemoteServiceConfigSchema, version.remoteConfig);
      return this.#saveVersion({ ...version, status: "READY" }, expectedRevision);
    }

    if (version.tools.length > 0 && version.imageDigest === null) {
      throw new ManagementError(
        "INVALID_STATE",
        "Tool versions must complete a package build before becoming ready",
      );
    }

    parse(ManagedMcpManifestSchema, manifestFromVersion(version));

    return this.#saveVersion({ ...version, status: "READY" }, expectedRevision);
  }

  /**
   * 探测远端 MCP 上游连通性：完成 initialize 握手后拉取 tools/list。
   * 入参为完整远端配置（新建时用表单值，已有版本用保存值），只读不落库。
   */
  async testRemoteConnection(input: unknown, actor: Actor): Promise<RemoteProbeResult> {
    requireEditor(actor);
    const config = parse(RemoteServiceConfigSchema, input);
    const startedAt = Date.now();
    try {
      const tools =
        config.transport === "sse"
          ? await probeRemoteToolsOverSse(config, this.#fetchRemote)
          : await probeRemoteToolsOverStreamableHttp(config, this.#fetchRemote);
      return {
        transport: config.transport,
        url: config.url,
        timeoutMs: config.timeoutMs,
        latencyMs: Date.now() - startedAt,
        toolCount: tools.length,
        tools: tools.slice(0, 200),
      };
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      throw new ManagementError(
        "UPSTREAM_ERROR",
        error instanceof Error
          ? `Remote MCP unreachable: ${error.message}`
          : "Remote MCP unreachable",
      );
    }
  }

  async publishVersion(
    versionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<PublishedVersionResult> {
    requireAdmin(actor);
    const version = await this.getVersion(versionId, actor);
    if (version.status !== "READY") {
      throw new ManagementError("INVALID_STATE", `Version is not ready: ${version.status}`);
    }
    try {
      return await this.#repository.publishVersion(versionId, expectedRevision, this.#now());
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async rollbackVersion(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<PublishedVersionResult> {
    requireAdmin(actor);
    const service = await this.getService(serviceId, actor);
    const version = await this.getVersion(versionId, actor);
    if (version.serviceId !== service.id) {
      throw new ManagementError("NOT_FOUND", `Version not found: ${versionId}`);
    }
    if (version.revision !== expectedRevision) {
      throw new ManagementError("CONFLICT", `Version revision conflict: ${versionId}`);
    }
    if (
      service.status !== "ACTIVE" ||
      service.currentVersionId === version.id ||
      (version.status !== "READY" && version.status !== "SUPERSEDED")
    ) {
      throw new ManagementError("INVALID_STATE", `Version cannot be rolled back: ${version.id}`);
    }
    try {
      return await this.#repository.rollbackVersion(
        service.id,
        version.id,
        expectedRevision,
        this.#now(),
      );
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async #saveVersion(
    version: McpServiceVersionRecord,
    expectedRevision: number,
  ): Promise<McpServiceVersionRecord> {
    const updated: McpServiceVersionRecord = {
      ...version,
      revision: version.revision + 1,
      updatedAt: this.#now(),
    };
    try {
      return await this.#repository.saveVersion(updated, expectedRevision);
    } catch (error) {
      mapRepositoryError(error);
    }
  }
}

function manifestFromVersion(version: McpServiceVersionRecord): ManagedMcpManifest {
  return {
    schemaVersion: 1,
    ...(version.runtime === null ? {} : { runtime: version.runtime }),
    ...(version.entry === null ? {} : { entry: version.entry }),
    ...(version.buildCommand === null ? {} : { build: { command: version.buildCommand } }),
    ...(version.limits === null ? {} : { limits: version.limits }),
    tools: version.tools.map(withoutId),
    prompts: version.prompts.map(withoutId),
  } as ManagedMcpManifest;
}

/** 版本对外视图：远端 token 脱敏，仅保留 hasToken（网关经独立 Repository 读原文，不受影响）。 */
export function maskVersionRemoteConfig(version: McpServiceVersionRecord): Omit<
  McpServiceVersionRecord,
  "remoteConfig"
> & {
  remoteConfig: RemoteServiceConfigPublic | null;
} {
  return {
    ...version,
    remoteConfig: version.remoteConfig === null ? null : maskRemoteConfig(version.remoteConfig),
  };
}

export interface RemoteProbeTool {
  name: string;
  description?: string;
}

export interface RemoteProbeResult {
  transport: RemoteServiceConfig["transport"];
  url: string;
  timeoutMs: number;
  latencyMs: number;
  toolCount: number;
  tools: RemoteProbeTool[];
}

function remoteHeaders(config: RemoteServiceConfig): Record<string, string> {
  return {
    ...(config.token === undefined ? {} : { authorization: `Bearer ${config.token}` }),
    ...(config.headers ?? {}),
  };
}

/** streamable-http 探测：与网关 RemoteMcpProxy 同协议（initialize → tools/list，兼容 SSE 包裝）。 */
async function probeRemoteToolsOverStreamableHttp(
  config: RemoteServiceConfig,
  fetchImpl: typeof fetch,
): Promise<RemoteProbeTool[]> {
  let nextId = 1;
  let sessionId: string | null = null;
  const post = async (payload: Record<string, unknown>): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...remoteHeaders(config),
          ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const sid = response.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      const text = await response.text();
      if (!response.ok) throw new Error(`upstream responded with status ${response.status}`);
      const body = parseJsonRpcBody(text, response.headers.get("content-type"));
      const envelope = body as { error?: { message?: string }; result?: unknown };
      if (envelope !== null && typeof envelope === "object" && envelope.error) {
        throw new Error(envelope.error.message ?? "upstream returned an error");
      }
      return envelope && typeof envelope === "object" ? (envelope.result ?? null) : null;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("request timed out");
      }
      throw error instanceof Error ? error : new Error("request failed");
    } finally {
      clearTimeout(timer);
    }
  };

  const initialized = (await post({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "open-agent-tools-control-plane", version: "1.0.0" },
    },
  })) as Record<string, unknown> | null;
  if (initialized === null || typeof initialized !== "object") {
    throw new Error("initialize returned no result");
  }
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(
    () => undefined,
  );
  const result = (await post({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/list",
    params: {},
  })) as {
    tools?: Array<{ name?: unknown; description?: unknown }>;
  };
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools
    .filter(
      (tool): tool is { name: string; description?: unknown } =>
        typeof tool?.name === "string" && tool.name.length > 0,
    )
    .map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    }));
}

function parseJsonRpcBody(text: string, contentType: string | null): unknown {
  if (text.length === 0) return null;
  if (
    contentType?.includes("text/event-stream") ||
    text.startsWith("event:") ||
    text.startsWith("data:")
  ) {
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line.length > 0);
    if (payloads.length === 0) return null;
    return JSON.parse(payloads[payloads.length - 1]!);
  }
  return JSON.parse(text);
}

/** SSE 探测：经 SDK Client 建连并拉取 tools/list，与网关 SSE 路径同一协议。 */
async function probeRemoteToolsOverSse(
  config: RemoteServiceConfig,
  fetchImpl: typeof fetch,
): Promise<RemoteProbeTool[]> {
  const headers = remoteHeaders(config);
  const client = new Client({ name: "open-agent-tools-control-plane", version: "1.0.0" });
  // SSE 首个 GET 由 EventSource 发起（不支持自定义 header），用包装 fetch 为所有请求注入鉴权头。
  const authedFetch = (async (url: unknown, init?: Record<string, unknown>) => {
    const merged = {
      ...(init ?? {}),
      headers: {
        ...headers,
        ...((init?.["headers"] as Record<string, string> | undefined) ?? {}),
      },
    };
    return fetchImpl(url as string, merged as RequestInit);
  }) as unknown as typeof globalThis.fetch;
  const transport = new SSEClientTransport(new URL(config.url), {
    fetch: authedFetch,
    requestInit: { headers },
  });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("request timed out")), config.timeoutMs);
      }),
    ]);
    const result = await client.listTools(undefined, { timeout: config.timeoutMs });
    return (result.tools ?? [])
      .filter((tool) => typeof tool?.name === "string" && tool.name.length > 0)
      .map((tool) => ({
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      }));
  } catch (error) {
    if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
      throw new Error("request timed out");
    }
    throw error instanceof Error ? error : new Error("request failed");
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    await client.close().catch(() => undefined);
  }
}
