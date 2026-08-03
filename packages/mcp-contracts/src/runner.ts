import { z } from "zod";

import { CapabilityNameSchema } from "./manifest.js";

const IdentifierSchema = z.string().min(1).max(200);

export const ToolInvocationContextSchema = z
  .object({
    serviceId: IdentifierSchema,
    versionId: IdentifierSchema,
    clientId: IdentifierSchema,
    deadlineAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ToolRunnerInputSchema = z
  .object({
    requestId: IdentifierSchema,
    toolName: CapabilityNameSchema,
    arguments: z.record(z.string(), z.unknown()),
    context: ToolInvocationContextSchema,
  })
  .strict();

export type ToolInvocationContext = z.infer<typeof ToolInvocationContextSchema>;
export type ToolRunnerInput = z.infer<typeof ToolRunnerInputSchema>;
