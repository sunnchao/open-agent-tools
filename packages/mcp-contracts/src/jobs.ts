import { z } from "zod";

import { CapabilityNameSchema, ExecutionLimitsSchema } from "./manifest.js";

export const MCP_BUILD_QUEUE = "mcp-tool-build";
export const MCP_TOOL_EXECUTION_QUEUE = "mcp-tool-execution";

export const ArtifactInspectionJobSchema = z
  .object({
    buildJobId: z.string().min(1).max(200),
    serviceId: z.string().min(1).max(200),
    versionId: z.string().min(1).max(200),
    versionRevision: z.number().int().positive(),
    objectKey: z.string().min(1).max(1024),
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    artifactSize: z.number().int().positive().max(50 * 1024 * 1024),
  })
  .strict();

export const ToolExecutionJobSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    serviceId: z.string().min(1).max(200),
    versionId: z.string().min(1).max(200),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    toolName: CapabilityNameSchema,
    arguments: z.record(z.string(), z.unknown()),
    context: z
      .object({
        clientId: z.string().min(1).max(200),
        deadlineAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    limits: ExecutionLimitsSchema,
  })
  .strict();

export type ToolExecutionJob = z.infer<typeof ToolExecutionJobSchema>;
export type ArtifactInspectionJob = z.infer<typeof ArtifactInspectionJobSchema>;
