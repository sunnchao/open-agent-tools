import type { Request } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Actor, AdminRole } from "./types.js";

export interface OidcAuthenticatorOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  roleClaim?: string;
}

function bearerToken(request: Request): string | null {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

export function actorFromClaims(payload: JWTPayload, roleClaim = "roles"): Actor | null {
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  const value = payload[roleClaim];
  const roles = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const role = (["admin", "operator", "auditor"] as const).find((item) => roles.includes(item));
  return role ? { id: payload.sub, role: role satisfies AdminRole } : null;
}

export function createOidcAuthenticator(options: OidcAuthenticatorOptions) {
  const keySet = createRemoteJWKSet(new URL(options.jwksUri));
  return async (request: Request): Promise<Actor | null> => {
    const token = bearerToken(request);
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: options.issuer,
        audience: options.audience,
      });
      return actorFromClaims(payload, options.roleClaim);
    } catch {
      return null;
    }
  };
}
