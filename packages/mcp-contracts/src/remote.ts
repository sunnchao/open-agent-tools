import { z } from "zod";

export const RemoteTransportSchema = z.enum(["streamable-http", "sse"]);

export const RemoteServiceConfigSchema = z
  .object({
    transport: RemoteTransportSchema,
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    token: z
      .string()
      .min(1)
      .max(2_048)
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .default(30_000),
  })
  .strict();

export type RemoteTransport = z.infer<typeof RemoteTransportSchema>;

export type RemoteServiceConfig = z.infer<typeof RemoteServiceConfigSchema>;
