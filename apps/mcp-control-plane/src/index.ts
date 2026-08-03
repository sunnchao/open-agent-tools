import { config as loadEnv } from "dotenv";
import { createControlPlaneApp } from "./app.js";
import { ArtifactUploadService } from "./artifact-upload.js";
import { AuditService } from "./audit.js";
import { createArtifactInspectionQueue } from "./build-queue.js";
import { ClientAccessService } from "./client-access.js";
import { createPostgresClientAccessRepository } from "./db/postgres-client-access-repository.js";
import { createPostgresAuditRepository } from "./db/postgres-audit-repository.js";
import { createPostgresRepository } from "./db/postgres-repository.js";
import { McpManagementService } from "./management.js";
import { createS3ArtifactStorage } from "./s3-artifact-storage.js";

loadEnv();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = requiredEnvironment("DATABASE_URL");
const redisUrl = requiredEnvironment("REDIS_URL");
const artifactBucket = requiredEnvironment("ARTIFACT_S3_BUCKET");
const { repository, close } = createPostgresRepository(databaseUrl);
const { repository: clientAccessRepository, close: closeClientAccess } =
  createPostgresClientAccessRepository(databaseUrl);
const { repository: auditRepository, close: closeAudit } =
  createPostgresAuditRepository(databaseUrl);
const management = new McpManagementService(repository);
const clientAccess = new ClientAccessService(clientAccessRepository);
const audit = new AuditService(auditRepository);
const artifactStorage = createS3ArtifactStorage(artifactBucket, {
  region: process.env.ARTIFACT_S3_REGION || "us-east-1",
  ...(process.env.ARTIFACT_S3_ENDPOINT
    ? { endpoint: process.env.ARTIFACT_S3_ENDPOINT, forcePathStyle: true }
    : {}),
});
const inspectionQueue = createArtifactInspectionQueue(redisUrl);
const artifactUploads = new ArtifactUploadService(
  management,
  artifactStorage.storage,
  inspectionQueue.queue,
);
const app = createControlPlaneApp({
  management,
  clientAccess,
  artifactUploads,
  buildQueue: inspectionQueue.queue,
  audit,
});
const port = Number(process.env.PORT) || 4200;
const server = app.listen(port, () => {
  console.error(`MCP Control Plane listening on http://localhost:${port}`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await Promise.all([
    close(),
    closeClientAccess(),
    closeAudit(),
    inspectionQueue.close(),
    artifactStorage.close(),
  ]);
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
