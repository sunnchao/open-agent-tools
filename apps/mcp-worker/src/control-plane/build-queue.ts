import {
  ArtifactInspectionJobSchema,
  MCP_BUILD_QUEUE,
  type ArtifactInspectionJob,
} from "@open-agent-tools/mcp-contracts";
import { Queue } from "bullmq";
import { createRedisClient } from "@open-agent-tools/database/redis";

import type { ArtifactInspectionQueue } from "./artifact-upload.js";

export interface ArtifactBuildQueue {
  enqueueBuild(job: ArtifactInspectionJob): Promise<void>;
}

export interface BuildQueue {
  add(
    name: string,
    data: ArtifactInspectionJob,
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: "exponential"; delay: number };
      removeOnComplete: number;
      removeOnFail: number;
    },
  ): Promise<unknown>;
}

export class BullMqArtifactInspectionQueue implements ArtifactInspectionQueue, ArtifactBuildQueue {
  readonly #queue: BuildQueue;

  constructor(queue: BuildQueue) {
    this.#queue = queue;
  }

  async enqueueInspection(job: ArtifactInspectionJob): Promise<void> {
    await this.#enqueue("inspect-artifact", job);
  }

  async enqueueBuild(job: ArtifactInspectionJob): Promise<void> {
    await this.#enqueue("build-tool", job);
  }

  async #enqueue(name: string, job: ArtifactInspectionJob): Promise<void> {
    const parsed = ArtifactInspectionJobSchema.parse(job);
    await this.#queue.add(name, parsed, {
      jobId: parsed.buildJobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }
}

export function createArtifactInspectionQueue(redisUrl: string): {
  queue: BullMqArtifactInspectionQueue;
  close: () => Promise<void>;
} {
  const connection = createRedisClient(redisUrl, { maxRetriesPerRequest: null }).client;
  const queue = new Queue<ArtifactInspectionJob>(MCP_BUILD_QUEUE, { connection });
  return {
    queue: new BullMqArtifactInspectionQueue(queue),
    close: async () => {
      await queue.close();
      connection.disconnect();
    },
  };
}
