import { pathToFileURL } from "node:url";

export * from "./archive.js";
export * from "./artifact-inspection.js";
export * from "./docker-build-command.js";
export * from "./docker-tool-verifier.js";
export * from "./docker-runtime.js";
export * from "./execution.js";
export * from "./inspection-worker.js";
export * from "./node-package.js";
export * from "./platform-command.js";
export * from "./postgres-artifact-inspection-repository.js";
export * from "./s3-artifact-download.js";
export { S3SbomStorage, createS3SbomStorage } from "./s3-sbom-storage.js";
export * from "./tool-build.js";
export * from "./tool-image-builder.js";

import { createDockerClient, DockerToolContainerRuntime } from "./docker-runtime.js";
import { ArtifactInspectionService } from "./artifact-inspection.js";
import { createToolExecutionWorker } from "./execution.js";
import { createBuildQueueWorker } from "./inspection-worker.js";
import { createPostgresArtifactInspectionRepository } from "./postgres-artifact-inspection-repository.js";
import { createS3ArtifactDownload } from "./s3-artifact-download.js";
import { DockerBuildCommandRunner, type BuildDockerClient } from "./docker-build-command.js";
import { SpawnPlatformCommandRunner } from "./platform-command.js";
import { ToolBuildService } from "./tool-build.js";
import { DockerCliToolImageBuilder } from "./tool-image-builder.js";
import { createS3SbomStorage } from "./s3-sbom-storage.js";
import { DockerToolPackageVerifier, type VerificationDockerClient } from "./docker-tool-verifier.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const redisUrl = process.env.REDIS_URL;
  const imageRepository = process.env.TOOL_IMAGE_REPOSITORY;
  const runnerImage = process.env.MCP_RUNNER_IMAGE;
  if (!redisUrl) throw new Error("REDIS_URL is required");
  if (!imageRepository) throw new Error("TOOL_IMAGE_REPOSITORY is required");
  if (!runnerImage) throw new Error("MCP_RUNNER_IMAGE is required");
  const databaseUrl = process.env.DATABASE_URL;
  const artifactBucket = process.env.ARTIFACT_S3_BUCKET;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!artifactBucket) throw new Error("ARTIFACT_S3_BUCKET is required");

  const docker = await createDockerClient(
    process.env.DOCKER_SOCKET_PATH ? { socketPath: process.env.DOCKER_SOCKET_PATH } : {},
  );
  const runtime = new DockerToolContainerRuntime(docker, { imageRepository });
  const concurrency = Number(process.env.EXECUTION_CONCURRENCY) || 4;
  const worker = createToolExecutionWorker(redisUrl, runtime, concurrency);
  const repository = createPostgresArtifactInspectionRepository(databaseUrl);
  const artifactStorage = createS3ArtifactDownload(artifactBucket, {
    region: process.env.ARTIFACT_S3_REGION || "us-east-1",
    ...(process.env.ARTIFACT_S3_ENDPOINT
      ? { endpoint: process.env.ARTIFACT_S3_ENDPOINT, forcePathStyle: true }
      : {}),
  });
  const sbomStorage = createS3SbomStorage(artifactBucket, {
    region: process.env.ARTIFACT_S3_REGION || "us-east-1",
    ...(process.env.ARTIFACT_S3_ENDPOINT
      ? { endpoint: process.env.ARTIFACT_S3_ENDPOINT, forcePathStyle: true }
      : {}),
  });
  const inspectionService = new ArtifactInspectionService(
    artifactStorage.storage,
    repository.repository,
  );
  const buildCommands = new SpawnPlatformCommandRunner();
  const buildRunner = new DockerBuildCommandRunner(docker as unknown as BuildDockerClient, {
    installNetwork: process.env.NPM_NETWORK || "bridge",
  });
  const imageBuilder = new DockerCliToolImageBuilder(buildCommands, sbomStorage.storage, {
    imageRepository,
    runnerImage,
    attestations: process.env.BUILDX_ATTESTATIONS !== "false",
  });
  const buildService = new ToolBuildService(
    artifactStorage.storage,
    repository.repository,
    buildRunner,
    new DockerToolPackageVerifier(docker as unknown as VerificationDockerClient),
    imageBuilder,
  );
  const inspection = createBuildQueueWorker(
    redisUrl,
    { inspection: inspectionService, build: buildService },
    Number(process.env.BUILD_CONCURRENCY) || 2,
  );

  const shutdown = async (): Promise<void> => {
    await Promise.all([worker.close(), inspection.close(), repository.close()]);
    artifactStorage.close();
    sbomStorage.close();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}
