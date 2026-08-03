import { randomUUID } from "node:crypto";
import {
  ManagedMcpManifestSchema,
  ManagedToolSchema,
  PromptDefinitionSchema,
  renderPrompt,
  type ManagedMcpManifest,
  type ManagedTool,
  type PromptDefinition,
  type RenderedPrompt,
} from "@open-agent-tools/mcp-contracts";
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
  McpServiceRecord,
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

  constructor(repository: McpManagementRepository, options: McpManagementServiceOptions = {}) {
    this.#repository = repository;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
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

  async listServices(_actor: Actor): Promise<McpServiceRecord[]> {
    return this.#repository.listServices();
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

    if (version.tools.length > 0 && version.imageDigest === null) {
      throw new ManagementError(
        "INVALID_STATE",
        "Tool versions must complete a package build before becoming ready",
      );
    }

    parse(ManagedMcpManifestSchema, manifestFromVersion(version));

    return this.#saveVersion({ ...version, status: "READY" }, expectedRevision);
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
