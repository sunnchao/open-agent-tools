import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { getWorkflowApiKey, insertWorkflowApiKey, touchWorkflowApiKey } from "./store.js";
import type { WorkflowApiKeyRecord, WorkflowApiKeyView } from "./types.js";

const KEY_ID_PATTERN = /^[0-9a-f-]{36}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;
const rateBuckets = new Map<string, number[]>();

function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: 64 * 1024 * 1024,
      },
      (error, value) => (error ? reject(error) : resolve(value)),
    );
  });
}

function rawKeyFromRequest(req: Request): string | null {
  const authorization = req.header("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function parseRawKey(rawKey: string): { keyId: string; secret: string } | null {
  const [prefix, keyId, secret, ...rest] = rawKey.split(".");
  if (
    prefix !== "wf" ||
    rest.length > 0 ||
    !keyId ||
    !secret ||
    !KEY_ID_PATTERN.test(keyId) ||
    !SECRET_PATTERN.test(secret)
  ) {
    return null;
  }
  return { keyId, secret };
}

async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveKey(secret, salt);
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

async function verifySecret(secret: string, keyHash: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelization, encodedSalt, encodedHash] =
    keyHash.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(cost) !== SCRYPT_COST ||
    Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelization) !== SCRYPT_PARALLELIZATION ||
    !encodedSalt ||
    !encodedHash
  ) {
    return false;
  }
  try {
    const expected = Buffer.from(encodedHash, "base64url");
    const actual = await deriveKey(secret, Buffer.from(encodedSalt, "base64url"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function createWorkflowApiKey(input: {
  workflowId: string;
  name: string;
  expiresAt?: string | null;
  rateLimitPerMinute?: number;
}): Promise<{ key: WorkflowApiKeyView; rawKey: string }> {
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
    throw new TypeError("expiresAt must be a valid ISO timestamp");
  }
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const rawKey = `wf.${id}.${secret}`;
  const record: WorkflowApiKeyRecord = {
    id,
    workflowId: input.workflowId,
    name: (input.name.trim() || "Default").slice(0, 120),
    keyHash: await hashSecret(secret),
    prefix: `${rawKey.slice(0, 15)}...`,
    status: "ACTIVE",
    rateLimitPerMinute: Math.max(1, Math.min(10_000, input.rateLimitPerMinute ?? 60)),
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
  };
  return { key: insertWorkflowApiKey(record), rawKey };
}

export type WorkflowAuthorization =
  { ok: true; key: WorkflowApiKeyRecord } | { ok: false; status: 401 | 403 | 429; error: string };

export async function authorizeWorkflowRequest(
  req: Request,
  workflowId: string,
): Promise<WorkflowAuthorization> {
  const rawKey = rawKeyFromRequest(req);
  if (!rawKey) return { ok: false, status: 401, error: "workflow API key is required" };
  const parsed = parseRawKey(rawKey);
  if (!parsed) return { ok: false, status: 401, error: "invalid workflow API key" };
  const key = getWorkflowApiKey(parsed.keyId);
  if (!key || !(await verifySecret(parsed.secret, key.keyHash))) {
    return { ok: false, status: 401, error: "invalid workflow API key" };
  }
  if (key.status !== "ACTIVE" || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())) {
    return { ok: false, status: 401, error: "workflow API key is inactive" };
  }
  if (key.workflowId !== workflowId) {
    return {
      ok: false,
      status: 403,
      error: "workflow API key is not authorized for this workflow",
    };
  }
  if (!consumeRateLimit(key)) {
    return { ok: false, status: 429, error: "workflow API rate limit exceeded" };
  }
  touchWorkflowApiKey(key.id);
  return { ok: true, key };
}

function consumeRateLimit(key: WorkflowApiKeyRecord): boolean {
  const current = Date.now();
  const windowStart = current - 60_000;
  const hits = (rateBuckets.get(key.id) ?? []).filter((timestamp) => timestamp > windowStart);
  if (hits.length >= key.rateLimitPerMinute) {
    rateBuckets.set(key.id, hits);
    return false;
  }
  hits.push(current);
  rateBuckets.set(key.id, hits);
  if (rateBuckets.size > 2_000) {
    for (const [id, values] of rateBuckets) {
      const alive = values.filter((timestamp) => timestamp > windowStart);
      if (alive.length === 0) rateBuckets.delete(id);
      else rateBuckets.set(id, alive);
    }
  }
  return true;
}

export function resetWorkflowRateLimitsForTest(): void {
  rateBuckets.clear();
}
