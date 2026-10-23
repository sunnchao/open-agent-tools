import { randomBytes } from "node:crypto";
import { hashSecret, verifySecret } from "./primitives.js";

const KEY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

export interface CreatedApiKey {
  keyId: string;
  rawKey: string;
  keyHash: string;
}

export function parseApiKey(rawKey: string): ParsedApiKey | null {
  const parts = rawKey.split(".");
  if (parts.length !== 3 || parts[0] !== "mcp") return null;
  const [, keyId, secret] = parts;
  if (!keyId || !secret || !KEY_ID_PATTERN.test(keyId) || !SECRET_PATTERN.test(secret)) return null;
  return { keyId, secret };
}

export async function createApiKey(
  keyId: string,
  secretSource: () => Buffer = () => randomBytes(32),
): Promise<CreatedApiKey> {
  if (!KEY_ID_PATTERN.test(keyId)) throw new TypeError("keyId must be a lowercase UUID");
  const secretBytes = secretSource();
  if (secretBytes.length !== 32) throw new TypeError("API Key secret must contain 32 bytes");
  const secret = secretBytes.toString("base64url");
  const keyHash = await hashSecret(secret);
  return { keyId, rawKey: `mcp.${keyId}.${secret}`, keyHash };
}

export async function verifyApiKey(rawKey: string, keyHash: string): Promise<boolean> {
  const parsed = parseApiKey(rawKey);
  if (!parsed) return false;
  return verifySecret(parsed.secret, keyHash);
}
