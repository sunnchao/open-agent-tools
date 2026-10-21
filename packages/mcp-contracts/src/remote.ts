import { z } from "zod";

export const RemoteTransportSchema = z.enum(["streamable-http", "sse"]);

const RemoteUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        if (parsed.username.length > 0 || parsed.password.length > 0) return false;
        return true;
      } catch {
        return false;
      }
    },
    { message: "Remote URL must be an http(s) URL without embedded credentials" },
  );

export const RemoteServiceConfigSchema = z
  .object({
    transport: RemoteTransportSchema,
    url: RemoteUrlSchema,
    headers: z.record(z.string(), z.string()).optional(),
    token: z.string().min(1).max(2_048).optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  })
  .strict();

export type RemoteTransport = z.infer<typeof RemoteTransportSchema>;

export type RemoteServiceConfig = z.infer<typeof RemoteServiceConfigSchema>;

/**
 * 远端配置更新补丁：全字段可选。
 * `token` 语义与环境变量一致——`undefined`/`null` 表示保留原值，空字符串表示清除。
 */
export const RemoteServiceConfigPatchSchema = z
  .object({
    transport: RemoteTransportSchema.optional(),
    url: RemoteUrlSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    token: z.string().max(2_048).nullable().optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

export type RemoteServiceConfigPatch = z.infer<typeof RemoteServiceConfigPatchSchema>;

/** 对外返回的脱敏视图：token 原文永不外泄，仅告知是否存在。 */
export interface RemoteServiceConfigPublic {
  transport: RemoteTransport;
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  hasToken: boolean;
}

export function maskRemoteConfig(config: RemoteServiceConfig): RemoteServiceConfigPublic {
  return {
    transport: config.transport,
    url: config.url,
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    timeoutMs: config.timeoutMs,
    hasToken: config.token !== undefined && config.token.length > 0,
  };
}

/** 合并补丁：未提供的字段保留原值；`token` 只有传非空字符串时才覆盖，空字符串则清除。 */
export function mergeRemoteConfig(
  current: RemoteServiceConfig,
  patch: RemoteServiceConfigPatch,
): RemoteServiceConfig {
  let token = current.token;
  if (patch.token !== undefined && patch.token !== null) {
    token = patch.token.length === 0 ? undefined : patch.token;
  }
  return RemoteServiceConfigSchema.parse({
    transport: patch.transport ?? current.transport,
    url: patch.url ?? current.url,
    headers: patch.headers ?? current.headers,
    timeoutMs: patch.timeoutMs ?? current.timeoutMs,
    token,
  });
}
