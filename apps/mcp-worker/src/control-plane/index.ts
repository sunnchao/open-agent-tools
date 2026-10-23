import { config as loadEnv } from "dotenv";
import { createPostgresConnection } from "@open-agent-tools/database/postgres";
import { createControlPlaneApp } from "./app.js";
import { ArtifactUploadService } from "./artifact-upload.js";
import { AuditService } from "./audit.js";
import { createArtifactInspectionQueue } from "./build-queue.js";
import { ClientAccessService } from "./client-access.js";
import { PostgresClientAccessRepository } from "./db/postgres-client-access-repository.js";
import { PostgresAuditRepository } from "./db/postgres-audit-repository.js";
import { PostgresMcpManagementRepository } from "./db/postgres-repository.js";
import * as schema from "./db/schema.js";
import { McpManagementService } from "./management.js";
import { createAlertLoop } from "./observability/alerts.js";
import { ObservabilityService } from "./observability/overview.js";
import {
  DEFAULT_QUEUE_THRESHOLDS,
  EMPTY_QUEUE_SNAPSHOT,
  QueueMonitor,
} from "./observability/queue-monitor.js";
import { createS3ArtifactStorage } from "./s3-artifact-storage.js";

loadEnv();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const databaseUrl = requiredEnvironment("DATABASE_URL");
const redisUrl = requiredEnvironment("REDIS_URL");
const artifactBucket = requiredEnvironment("ARTIFACT_S3_BUCKET");
const { database, close } = createPostgresConnection(databaseUrl, { schema });
const repository = new PostgresMcpManagementRepository(database);
const clientAccessRepository = new PostgresClientAccessRepository(database);
const auditRepository = new PostgresAuditRepository(database);
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
const queueMonitor = new QueueMonitor(inspectionQueue.queue, {
  backlogWarning: numberEnvironment(
    "OBSERVABILITY_QUEUE_BACKLOG_WARNING",
    DEFAULT_QUEUE_THRESHOLDS.backlogWarning,
  ),
  backlogCritical: numberEnvironment(
    "OBSERVABILITY_QUEUE_BACKLOG_CRITICAL",
    DEFAULT_QUEUE_THRESHOLDS.backlogCritical,
  ),
});
const observability = new ObservabilityService({ management, audit, queueMonitor });
const alertLoop = createAlertLoop({
  collect: async () => {
    const overview = await observability.overview({ id: "system", role: "admin" });
    return { queue: overview.queue ?? EMPTY_QUEUE_SNAPSHOT, audit: overview.audit };
  },
  intervalMs: numberEnvironment("OBSERVABILITY_ALERT_INTERVAL_MS", 30_000),
  sinks: [
    {
      publish(alerts) {
        for (const alert of alerts) {
          console.error(`[observability][${alert.severity}] ${alert.message}`);
        }
      },
    },
  ],
});
alertLoop.start();
const app = createControlPlaneApp({
  management,
  clientAccess,
  artifactUploads,
  buildQueue: inspectionQueue.queue,
  audit,
  observability,
  corsOrigin: process.env.MCP_CORS_ORIGIN?.trim() || false,
});
const port = Number(process.env.PORT) || 4200;
const server = app.listen(port, () => {
  console.error(`MCP Control Plane listening on http://localhost:${port}`);
});

async function shutdown(): Promise<void> {
  alertLoop.stop();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await audit.flush();
  await Promise.all([close(), inspectionQueue.close(), artifactStorage.close()]);
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
