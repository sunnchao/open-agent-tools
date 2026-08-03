import {
  ArtifactInspectionJobSchema,
  MCP_BUILD_QUEUE,
  type ArtifactInspectionJob,
} from "@open-agent-tools/mcp-contracts";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

import type { ArtifactInspectionResult, ArtifactInspectionService } from "./artifact-inspection.js";
import type { ToolBuildResult, ToolBuildService } from "./tool-build.js";

export interface ArtifactInspectionProcessorService {
  inspect(input: ArtifactInspectionJob): Promise<ArtifactInspectionResult>;
}

export interface ToolBuildProcessorService {
  build(input: ArtifactInspectionJob): Promise<ToolBuildResult>;
}

export interface BuildQueueProcessorServices {
  inspection: ArtifactInspectionProcessorService;
  build: ToolBuildProcessorService;
}

export function createArtifactInspectionProcessor(
  service: ArtifactInspectionProcessorService,
): (job: Pick<Job<ArtifactInspectionJob>, "data">) => Promise<ArtifactInspectionResult> {
  return async (job) => service.inspect(ArtifactInspectionJobSchema.parse(job.data));
}

export function createBuildQueueProcessor(
  services: BuildQueueProcessorServices,
): (
  job: Pick<Job<ArtifactInspectionJob>, "name" | "data">,
) => Promise<ArtifactInspectionResult | ToolBuildResult> {
  return async (job) => {
    const payload = ArtifactInspectionJobSchema.parse(job.data);
    if (job.name === "inspect-artifact") return services.inspection.inspect(payload);
    if (job.name === "build-tool") return services.build.build(payload);
    throw new Error(`Unknown build queue job: ${job.name}`);
  };
}

export function createArtifactInspectionWorker(
  redisUrl: string,
  service: ArtifactInspectionService,
  concurrency = 2,
): { close: () => Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<ArtifactInspectionJob, ArtifactInspectionResult>(
    MCP_BUILD_QUEUE,
    createArtifactInspectionProcessor(service),
    { connection, concurrency },
  );
  return {
    close: async () => {
      await worker.close();
      connection.disconnect();
    },
  };
}

export function createBuildQueueWorker(
  redisUrl: string,
  services: { inspection: ArtifactInspectionService; build: ToolBuildService },
  concurrency = 2,
): { close: () => Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<ArtifactInspectionJob, ArtifactInspectionResult | ToolBuildResult>(
    MCP_BUILD_QUEUE,
    createBuildQueueProcessor(services),
    { connection, concurrency },
  );
  return {
    close: async () => {
      await worker.close();
      connection.disconnect();
    },
  };
}
