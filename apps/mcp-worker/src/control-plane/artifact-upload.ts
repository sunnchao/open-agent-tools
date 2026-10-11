import type { ArtifactInspectionJob } from "@open-agent-tools/mcp-contracts";
import { z } from "zod";

import { ManagementError, type McpManagementService } from "./management.js";
import type { Actor, BuildJobRecord, McpServiceVersionRecord } from "./types.js";

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const UploadRequestSchema = z
  .object({
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    size: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  })
  .strict();

const CompleteUploadSchema = UploadRequestSchema.extend({
  objectKey: z.string().min(1).max(1024),
  expectedRevision: z.number().int().positive(),
}).strict();

export interface CreateArtifactUpload {
  objectKey: string;
  contentType: "application/zip";
  contentLength: number;
  checksumSha256Base64: string;
  expiresAt: string;
}

export interface PresignedArtifactUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ArtifactObjectMetadata {
  sha256: string;
  size: number;
}

export interface ArtifactStorage {
  createUpload(input: CreateArtifactUpload): Promise<PresignedArtifactUpload>;
  headObject(objectKey: string): Promise<ArtifactObjectMetadata | null>;
}

export interface ArtifactInspectionQueue {
  enqueueInspection(job: ArtifactInspectionJob): Promise<void>;
}

export type ArtifactUploadErrorCode = "OBJECT_MISMATCH" | "OBJECT_MISSING";

export class ArtifactUploadError extends Error {
  constructor(
    public readonly code: ArtifactUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactUploadError";
  }
}

export interface ArtifactUploadServiceOptions {
  now?: () => string;
  uploadTtlMs?: number;
}

function requireEditor(actor: Actor): void {
  if (actor.role === "auditor") {
    throw new ManagementError("FORBIDDEN", "This operation requires admin or operator access");
  }
}

export class ArtifactUploadService {
  readonly #management: McpManagementService;
  readonly #storage: ArtifactStorage;
  readonly #queue: ArtifactInspectionQueue;
  readonly #now: () => string;
  readonly #uploadTtlMs: number;

  constructor(
    management: McpManagementService,
    storage: ArtifactStorage,
    queue: ArtifactInspectionQueue,
    options: ArtifactUploadServiceOptions = {},
  ) {
    this.#management = management;
    this.#storage = storage;
    this.#queue = queue;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#uploadTtlMs = options.uploadTtlMs ?? 15 * 60 * 1000;
  }

  async requestUpload(
    serviceId: string,
    versionId: string,
    input: { sha256: string; size: number },
    actor: Actor,
  ): Promise<{ objectKey: string; upload: PresignedArtifactUpload }> {
    requireEditor(actor);
    const parsed = UploadRequestSchema.parse(input);
    const version = await this.#management.getVersion(versionId, actor);
    this.#requireUploadableForService(version, serviceId);
    const hexDigest = parsed.sha256.slice("sha256:".length);
    const objectKey = `${serviceId}/${versionId}/${hexDigest}.zip`;
    const expiresAt = new Date(Date.parse(this.#now()) + this.#uploadTtlMs).toISOString();
    const upload = await this.#storage.createUpload({
      objectKey,
      contentType: "application/zip",
      contentLength: parsed.size,
      checksumSha256Base64: Buffer.from(hexDigest, "hex").toString("base64"),
      expiresAt,
    });
    return { objectKey, upload };
  }

  async completeUpload(
    serviceId: string,
    versionId: string,
    input: {
      objectKey: string;
      sha256: string;
      size: number;
      expectedRevision: number;
    },
    actor: Actor,
  ): Promise<{
    version: McpServiceVersionRecord;
    job: BuildJobRecord;
    dispatched: boolean;
  }> {
    requireEditor(actor);
    const parsed = CompleteUploadSchema.parse(input);
    const version = await this.#management.getVersion(versionId, actor);
    this.#requireUploadableForService(version, serviceId);
    const expectedKey = `${serviceId}/${versionId}/${parsed.sha256.slice("sha256:".length)}.zip`;
    if (parsed.objectKey !== expectedKey) {
      throw new ArtifactUploadError("OBJECT_MISMATCH", "Artifact object key does not match upload");
    }

    const metadata = await this.#storage.headObject(parsed.objectKey);
    if (metadata === null) {
      throw new ArtifactUploadError("OBJECT_MISSING", "Uploaded artifact was not found");
    }
    if (metadata.sha256 !== parsed.sha256 || metadata.size !== parsed.size) {
      throw new ArtifactUploadError("OBJECT_MISMATCH", "Uploaded artifact metadata does not match");
    }

    const queued = await this.#management.confirmArtifactUpload(
      versionId,
      {
        objectKey: parsed.objectKey,
        artifactDigest: parsed.sha256,
        artifactSize: parsed.size,
      },
      parsed.expectedRevision,
      actor,
    );
    const inspectionJob: ArtifactInspectionJob = {
      buildJobId: queued.job.id,
      serviceId,
      versionId,
      versionRevision: queued.version.revision,
      objectKey: parsed.objectKey,
      artifactDigest: parsed.sha256,
      artifactSize: parsed.size,
    };
    let dispatched = true;
    try {
      await this.#queue.enqueueInspection(inspectionJob);
    } catch {
      dispatched = false;
    }
    return { ...queued, dispatched };
  }

  #requireUploadableForService(version: McpServiceVersionRecord, serviceId: string): void {
    if (version.serviceId !== serviceId) {
      throw new ManagementError("NOT_FOUND", `Version not found: ${version.id}`);
    }
    // VALIDATING/BUILDING 允许替换包：新上传推进 revision，旧 INSPECT/BUILD 任务因 revision 失配自动失效。
    if (
      version.status !== "DRAFT" &&
      version.status !== "FAILED" &&
      version.status !== "VALIDATING" &&
      version.status !== "BUILDING"
    ) {
      throw new ManagementError(
        "INVALID_STATE",
        `Version cannot accept an upload in status ${version.status}`,
      );
    }
  }
}
