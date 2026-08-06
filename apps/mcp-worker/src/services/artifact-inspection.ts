import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  ArtifactInspectionJobSchema,
  type ArtifactInspectionJob,
  type ManagedMcpManifest,
} from "@open-agent-tools/mcp-contracts";

import {
  ArchiveValidationError,
  type ArchiveValidationCode,
  extractZipArchive,
  inspectZipArchive,
} from "../infrastructure/archive.js";
import {
  NodePackageValidationError,
  type NodePackageValidationCode,
  readNodeToolPackage,
} from "../infrastructure/node-package.js";

export type InspectionFailureCode =
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_DOWNLOAD_FAILED"
  | "ARTIFACT_SIZE_MISMATCH"
  | "INSPECTION_FAILED"
  | ArchiveValidationCode
  | NodePackageValidationCode;

export interface ArtifactDownloadStorage {
  download(objectKey: string): Promise<Readable>;
}

export interface ArtifactInspectionRepository {
  startInspection(
    job: ArtifactInspectionJob,
    now: string,
  ): Promise<"STARTED" | "ALREADY_COMPLETED">;
  completeInspection(
    job: ArtifactInspectionJob,
    manifest: ManagedMcpManifest,
    now: string,
  ): Promise<void>;
  failInspection(
    job: ArtifactInspectionJob,
    code: InspectionFailureCode,
    now: string,
  ): Promise<void>;
}

export type ArtifactInspectionResult =
  { status: "SUCCEEDED" } | { status: "FAILED"; errorCode: InspectionFailureCode };

export interface ArtifactInspectionServiceOptions {
  now?: () => string;
  tempDirectory?: string;
}

export class ArtifactVerificationError extends Error {
  constructor(public readonly code: "ARTIFACT_DIGEST_MISMATCH" | "ARTIFACT_SIZE_MISMATCH") {
    super(code);
    this.name = "ArtifactVerificationError";
  }
}

export async function downloadAndVerifyArtifact(
  source: Readable,
  destination: string,
  expectedSize: number,
  expectedDigest: string,
): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > expectedSize) {
        callback(new ArtifactVerificationError("ARTIFACT_SIZE_MISMATCH"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(source, verifier, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  if (size !== expectedSize) {
    throw new ArtifactVerificationError("ARTIFACT_SIZE_MISMATCH");
  }
  if (`sha256:${hash.digest("hex")}` !== expectedDigest) {
    throw new ArtifactVerificationError("ARTIFACT_DIGEST_MISMATCH");
  }
}

function failureCode(error: unknown, phase: "PREPARING" | "DOWNLOADING" | "INSPECTING") {
  if (error instanceof ArtifactVerificationError) return error.code;
  if (error instanceof ArchiveValidationError) return error.code;
  if (error instanceof NodePackageValidationError) return error.code;
  if (phase === "DOWNLOADING") return "ARTIFACT_DOWNLOAD_FAILED" as const;
  return "INSPECTION_FAILED" as const;
}

export class ArtifactInspectionService {
  readonly #storage: ArtifactDownloadStorage;
  readonly #repository: ArtifactInspectionRepository;
  readonly #now: () => string;
  readonly #tempDirectory: string;

  constructor(
    storage: ArtifactDownloadStorage,
    repository: ArtifactInspectionRepository,
    options: ArtifactInspectionServiceOptions = {},
  ) {
    this.#storage = storage;
    this.#repository = repository;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#tempDirectory = options.tempDirectory ?? tmpdir();
  }

  async inspect(input: ArtifactInspectionJob): Promise<ArtifactInspectionResult> {
    const job = ArtifactInspectionJobSchema.parse(input);
    const started = await this.#repository.startInspection(job, this.#now());
    if (started === "ALREADY_COMPLETED") return { status: "SUCCEEDED" };

    let workDirectory: string | null = null;
    let phase: "PREPARING" | "DOWNLOADING" | "INSPECTING" = "PREPARING";
    try {
      workDirectory = await mkdtemp(join(this.#tempDirectory, "mcp-artifact-inspection-"));
      const archivePath = join(workDirectory, "artifact.zip");
      const packageRoot = join(workDirectory, "package");

      phase = "DOWNLOADING";
      const source = await this.#storage.download(job.objectKey);
      await downloadAndVerifyArtifact(source, archivePath, job.artifactSize, job.artifactDigest);

      phase = "INSPECTING";
      const inspection = await inspectZipArchive(archivePath);
      await extractZipArchive(archivePath, packageRoot, inspection);
      const validatedPackage = await readNodeToolPackage(packageRoot);
      await this.#repository.completeInspection(job, validatedPackage.manifest, this.#now());
      return { status: "SUCCEEDED" };
    } catch (error) {
      const code = failureCode(error, phase);
      await this.#repository.failInspection(job, code, this.#now());
      return { status: "FAILED", errorCode: code };
    } finally {
      if (workDirectory !== null) {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }
  }
}
