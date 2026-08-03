import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactInspectionJobSchema,
  type ArtifactInspectionJob,
  type ManagedMcpManifest,
} from "@open-agent-tools/mcp-contracts";
import {
  ArtifactVerificationError,
  type ArtifactDownloadStorage,
  downloadAndVerifyArtifact,
} from "./artifact-inspection.js";
import {
  ArchiveValidationError,
  type ArchiveValidationCode,
  extractZipArchive,
  inspectZipArchive,
} from "./archive.js";
import {
  NodePackageValidationError,
  type NodePackageValidationCode,
  readNodeToolPackage,
} from "./node-package.js";

export type BuildFailureCode =
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_DOWNLOAD_FAILED"
  | "ARTIFACT_SIZE_MISMATCH"
  | "BUILD_COMMAND_FAILED"
  | "HANDLER_NOT_FOUND"
  | "IMAGE_BUILD_FAILED"
  | "NPM_INSTALL_FAILED"
  | "SMOKE_TEST_FAILED"
  | ArchiveValidationCode
  | NodePackageValidationCode;

export interface BuildCommandRunner {
  run(
    command: string,
    args: string[],
    options: { cwd: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface ToolImageBuilder {
  build(
    context: string,
    imageTag: string,
  ): Promise<{ imageDigest: string; sbomObjectKey: string | null }>;
}

export class ToolPackageVerificationError extends Error {
  constructor(public readonly code: "HANDLER_NOT_FOUND" | "SMOKE_TEST_FAILED") {
    super(code);
    this.name = "ToolPackageVerificationError";
  }
}

export interface ToolPackageVerifier {
  verify(
    packageRoot: string,
    manifest: ManagedMcpManifest,
    job: ArtifactInspectionJob,
  ): Promise<void>;
}

export interface BuildJobRepository {
  startBuild(job: ArtifactInspectionJob, now: string): Promise<"STARTED" | "ALREADY_COMPLETED">;
  completeBuild(
    job: ArtifactInspectionJob,
    imageDigest: string,
    sbomObjectKey: string | null,
    now: string,
  ): Promise<void>;
  failBuild(job: ArtifactInspectionJob, code: BuildFailureCode, now: string): Promise<void>;
}

export type ToolBuildResult =
  { status: "SUCCEEDED"; imageDigest?: string } | { status: "FAILED"; errorCode: BuildFailureCode };

export interface ToolBuildServiceOptions {
  now?: () => string;
  tempDirectory?: string;
}

class BuildFailure extends Error {
  constructor(public readonly code: BuildFailureCode) {
    super(code);
    this.name = "BuildFailure";
  }
}

async function prepareContainerWorkspace(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new BuildFailure("UNSUPPORTED_ENTRY_TYPE");
  if (metadata.isDirectory()) {
    await chmod(path, 0o777);
    for (const entry of await readdir(path)) {
      await prepareContainerWorkspace(join(path, entry));
    }
    return;
  }
  if (!metadata.isFile()) throw new BuildFailure("UNSUPPORTED_ENTRY_TYPE");
  await chmod(path, 0o666);
}

function stableFailureCode(
  error: unknown,
  phase: "PREPARING" | "DOWNLOADING" | "INSTALLING" | "BUILDING" | "VERIFYING" | "IMAGING",
): BuildFailureCode {
  if (error instanceof BuildFailure) return error.code;
  if (error instanceof ArtifactVerificationError) return error.code;
  if (error instanceof ArchiveValidationError) return error.code;
  if (error instanceof NodePackageValidationError) return error.code;
  if (error instanceof ToolPackageVerificationError) return error.code;
  if (phase === "DOWNLOADING") return "ARTIFACT_DOWNLOAD_FAILED";
  if (phase === "INSTALLING") return "NPM_INSTALL_FAILED";
  if (phase === "BUILDING") return "BUILD_COMMAND_FAILED";
  if (phase === "IMAGING") return "IMAGE_BUILD_FAILED";
  return "SMOKE_TEST_FAILED";
}

function assertDigest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new BuildFailure("IMAGE_BUILD_FAILED");
  return value;
}

export class ToolBuildService {
  readonly #storage: ArtifactDownloadStorage;
  readonly #repository: BuildJobRepository;
  readonly #commands: BuildCommandRunner;
  readonly #verifier: ToolPackageVerifier;
  readonly #images: ToolImageBuilder;
  readonly #now: () => string;
  readonly #tempDirectory: string;

  constructor(
    storage: ArtifactDownloadStorage,
    repository: BuildJobRepository,
    commands: BuildCommandRunner,
    verifier: ToolPackageVerifier,
    images: ToolImageBuilder,
    options: ToolBuildServiceOptions = {},
  ) {
    this.#storage = storage;
    this.#repository = repository;
    this.#commands = commands;
    this.#verifier = verifier;
    this.#images = images;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#tempDirectory = options.tempDirectory ?? tmpdir();
  }

  async build(input: ArtifactInspectionJob): Promise<ToolBuildResult> {
    const job = ArtifactInspectionJobSchema.parse(input);
    const started = await this.#repository.startBuild(job, this.#now());
    if (started === "ALREADY_COMPLETED") return { status: "SUCCEEDED" };

    let workDirectory: string | null = null;
    let phase: "PREPARING" | "DOWNLOADING" | "INSTALLING" | "BUILDING" | "VERIFYING" | "IMAGING" =
      "PREPARING";
    try {
      workDirectory = await mkdtemp(join(this.#tempDirectory, "mcp-tool-build-"));
      const archivePath = join(workDirectory, "artifact.zip");
      const packageRoot = join(workDirectory, "package");

      phase = "DOWNLOADING";
      await downloadAndVerifyArtifact(
        await this.#storage.download(job.objectKey),
        archivePath,
        job.artifactSize,
        job.artifactDigest,
      );
      const inspection = await inspectZipArchive(archivePath);
      await extractZipArchive(archivePath, packageRoot, inspection);
      const validated = await readNodeToolPackage(packageRoot);
      await prepareContainerWorkspace(packageRoot);

      phase = "INSTALLING";
      const install = await this.#commands.run(
        "npm",
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: packageRoot },
      );
      if (install.exitCode !== 0) throw new BuildFailure("NPM_INSTALL_FAILED");

      if (validated.manifest.build !== undefined) {
        phase = "BUILDING";
        const build = await this.#commands.run("npm", ["run", "build"], { cwd: packageRoot });
        if (build.exitCode !== 0) throw new BuildFailure("BUILD_COMMAND_FAILED");
      }

      phase = "VERIFYING";
      await this.#verifier.verify(packageRoot, validated.manifest, job);
      phase = "IMAGING";
      const toolTag = validated.manifest.tools[0]?.name ?? "unnamed";
      const image = await this.#images.build(packageRoot, `mcp-tool:${toolTag}-${job.buildJobId}`);
      const imageDigest = assertDigest(image.imageDigest);
      await this.#repository.completeBuild(job, imageDigest, image.sbomObjectKey, this.#now());
      return { status: "SUCCEEDED", imageDigest };
    } catch (error) {
      const code = stableFailureCode(error, phase);
      await this.#repository.failBuild(job, code, this.#now());
      return { status: "FAILED", errorCode: code };
    } finally {
      if (workDirectory !== null) {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }
  }
}
