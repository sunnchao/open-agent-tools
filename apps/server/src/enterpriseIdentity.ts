import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { logTrace } from "./trace.js";

export type StudioRole = "admin" | "member";

export interface StudioActor {
  source: "oidc" | "deployment-token";
  subject: string;
  email: string | null;
  groups: string[];
  roles: string[];
  role: StudioRole;
}

export interface EnterpriseIdentityConfig {
  oidc: {
    issuer: string;
    audience: string;
    jwksUri: string;
    groupsClaim: string;
    rolesClaim: string;
    adminRoles: string[];
    algorithms: Array<"RS256" | "ES256">;
    maxTokenAgeSeconds: number | null;
    clockToleranceSeconds: number;
  } | null;
  ldap: {
    trustedGatewayUrl: string;
    mode: "trusted-gateway";
  } | null;
  ldapConfigError?: string | null;
}

export interface IdentityStatus {
  configError?: string | null;
  enabled: boolean;
  provider: "oidc" | "deployment-token" | "none";
  mode: "oidc" | "deployment-token" | "open";
  issuer: string | null;
  audience: string | null;
  groupsClaim: string;
  rolesClaim: string;
  adminRoles: string[];
  ldap: {
    enabled: boolean;
    mode: "ldap_trusted_gateway";
    gatewayConfigured: boolean;
    passwordBinding: false;
    assertionConfigured: boolean;
    assertionKeyId: string | null;
    assertionIssuer: string | null;
    assertionAudience: string | null;
    identityMode: "optional" | "required" | "required_for_groups";
    readiness: "not_configured" | "assertion_missing" | "invalid_config" | "ready";
    configError: string | null;
    summary: string;
  };
  deploymentTokenFallback: boolean;
}

export interface OidcVerifier {
  verify(token: string): Promise<StudioActor>;
}

const SUPPORTED_ALGORITHMS = ["RS256", "ES256"] as const;
const DEFAULT_ROLES_CLAIM = "roles";
const DEFAULT_ADMIN_ROLES = ["admin"];
const DEFAULT_GROUPS_CLAIM = "groups";

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function integer(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
}

function csv(value: string | undefined, fallback: string[]): string[] {
  const values = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : fallback;
}

function httpsUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new TypeError(`${name} must use HTTPS outside localhost`);
  }
  return url;
}

/**
 * 只读取环境变量，不在这里发起网络请求。JWKS 在第一次验证 token 时按需拉取。
 */
export function readEnterpriseIdentityConfig(
  env: NodeJS.ProcessEnv = process.env,
): EnterpriseIdentityConfig {
  const issuer = text(env.OIDC_ISSUER);
  const audience = text(env.OIDC_AUDIENCE);
  const jwksUri = text(env.OIDC_JWKS_URI);
  const configured = [issuer, audience, jwksUri].filter(Boolean).length;
  if (configured > 0 && configured < 3) {
    throw new TypeError(
      "OIDC_ISSUER, OIDC_AUDIENCE, and OIDC_JWKS_URI must be configured together",
    );
  }

  const oidc =
    issuer && audience && jwksUri
      ? {
          issuer,
          audience,
          jwksUri: httpsUrl(jwksUri, "OIDC_JWKS_URI").toString(),
          groupsClaim: text(env.OIDC_GROUPS_CLAIM) ?? DEFAULT_GROUPS_CLAIM,
          rolesClaim: text(env.OIDC_ROLES_CLAIM) ?? DEFAULT_ROLES_CLAIM,
          adminRoles: csv(env.OIDC_ADMIN_ROLES, DEFAULT_ADMIN_ROLES),
          algorithms: [...SUPPORTED_ALGORITHMS],
          maxTokenAgeSeconds: env.OIDC_MAX_TOKEN_AGE_SECONDS
            ? integer(env.OIDC_MAX_TOKEN_AGE_SECONDS, 3600, 1)
            : null,
          clockToleranceSeconds: integer(env.OIDC_CLOCK_TOLERANCE_SECONDS, 30, 0),
        }
      : null;

  const ldapGateway = text(env.LDAP_TRUSTED_GATEWAY_URL);
  let ldap: EnterpriseIdentityConfig["ldap"] = null;
  let ldapConfigError: string | null = null;
  if (ldapGateway) {
    try {
      ldap = {
        trustedGatewayUrl: httpsUrl(ldapGateway, "LDAP_TRUSTED_GATEWAY_URL").toString(),
        mode: "trusted-gateway",
      };
    } catch (error) {
      ldapConfigError = error instanceof Error ? error.message : String(error);
    }
  }

  return { oidc, ldap, ldapConfigError };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
}

export function studioActorFromClaims(
  payload: JWTPayload,
  options: {
    adminRoles?: string[];
    groupsClaim?: string;
    rolesClaim?: string;
  } = {},
): StudioActor {
  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new Error("OIDC token subject is required");
  }
  const adminRoles = options.adminRoles ?? DEFAULT_ADMIN_ROLES;
  const rolesClaim = options.rolesClaim ?? DEFAULT_ROLES_CLAIM;
  const groupsClaim = options.groupsClaim ?? DEFAULT_GROUPS_CLAIM;
  const roles = stringList(payload[rolesClaim]);
  return {
    source: "oidc",
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    groups: stringList(payload[groupsClaim]),
    roles,
    role: roles.some((role) => adminRoles.includes(role)) ? "admin" : "member",
  };
}

export interface CreateOidcVerifierOptions {
  config: NonNullable<EnterpriseIdentityConfig["oidc"]>;
  /** 测试可注入本地 resolver；生产默认按 OIDC_JWKS_URI 拉取并缓存。 */
  keySet?: JWTVerifyGetKey;
}

/**
 * OIDC bearer JWT 验证器。
 *
 * - 仅接受 RS256 / ES256；jose 本身也永远不会接受 alg=none；
 * - issuer、audience、exp/nbf 与可选最大签发时长由 jwtVerify 校验；
 * - 不在请求路径上访问 LDAP，也不接收用户名/密码。
 */
export function createOidcVerifier(options: CreateOidcVerifierOptions): OidcVerifier {
  const keySet =
    options.keySet ??
    createRemoteJWKSet(new URL(options.config.jwksUri), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    });

  return {
    async verify(token: string): Promise<StudioActor> {
      const verified = await jwtVerify(token, keySet, {
        issuer: options.config.issuer,
        audience: options.config.audience,
        algorithms: [...options.config.algorithms],
        clockTolerance: options.config.clockToleranceSeconds,
        requiredClaims: ["sub", "exp"],
        ...(options.config.maxTokenAgeSeconds
          ? { maxTokenAge: options.config.maxTokenAgeSeconds }
          : {}),
      });
      return studioActorFromClaims(verified.payload, {
        adminRoles: options.config.adminRoles,
        groupsClaim: options.config.groupsClaim,
        rolesClaim: options.config.rolesClaim,
      });
    },
  };
}

function ldapIdentityMode(value: string | undefined): IdentityStatus["ldap"]["identityMode"] {
  return value === "required" || value === "required_for_groups" ? value : "optional";
}

export function enterpriseIdentityStatus(
  config: EnterpriseIdentityConfig,
  deploymentTokenEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): IdentityStatus {
  const provider = config.oidc ? "oidc" : deploymentTokenEnabled ? "deployment-token" : "none";
  const mode = config.oidc ? "oidc" : deploymentTokenEnabled ? "deployment-token" : "open";
  const assertionKeyId = text(env.PUBLISHED_APP_ASSERTION_KEY_ID);
  const assertionIssuer = text(env.PUBLISHED_APP_ASSERTION_ISSUER);
  const assertionAudience = text(env.PUBLISHED_APP_ASSERTION_AUDIENCE);
  const assertionConfigured = [
    text(env.PUBLISHED_APP_ASSERTION_HMAC_SECRET),
    assertionKeyId,
    assertionIssuer,
    assertionAudience,
  ].every(Boolean);
  return {
    enabled: Boolean(config.oidc) || deploymentTokenEnabled,
    provider,
    mode,
    issuer: config.oidc?.issuer ?? null,
    audience: config.oidc?.audience ?? null,
    groupsClaim: config.oidc?.groupsClaim ?? DEFAULT_GROUPS_CLAIM,
    rolesClaim: config.oidc?.rolesClaim ?? DEFAULT_ROLES_CLAIM,
    adminRoles: config.oidc?.adminRoles ?? DEFAULT_ADMIN_ROLES,
    ldap: {
      enabled: Boolean(config.ldap),
      mode: "ldap_trusted_gateway",
      gatewayConfigured: Boolean(config.ldap?.trustedGatewayUrl),
      passwordBinding: false,
      assertionConfigured,
      assertionKeyId,
      assertionIssuer,
      assertionAudience,
      identityMode: ldapIdentityMode(env.PUBLISHED_APP_IDENTITY_MODE),
      readiness: !config.ldap
        ? config.ldapConfigError
          ? "invalid_config"
          : "not_configured"
        : assertionConfigured
          ? "ready"
          : "assertion_missing",
      configError: config.ldapConfigError ?? null,
      summary:
        "LDAP 身份必须由可信网关完成 bind/校验，再签发发布应用 HMAC viewer assertion；" +
        "Agent Server 不接收也不保存 LDAP 密码。",
    },
    deploymentTokenFallback: deploymentTokenEnabled,
  };
}

export function logIdentityVerificationFailure(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  logTrace("studio.oidc_rejected", { reason: message }, "warn");
}
