import { randomBytes, randomUUID } from "node:crypto";
import { hashSecret, parseBearerToken, verifySecret } from "@open-agent-tools/mcp-auth/primitives";
import type { Request } from "express";
import { getWorkflowApiKey, insertWorkflowApiKey, touchWorkflowApiKey } from "./store.js";
import type { WorkflowApiKeyRecord, WorkflowApiKeyView } from "./types.js";

const KEY_ID_PATTERN = /^[0-9a-f-]{36}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const rateBuckets = new Map<string, number[]>();

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
  const rawKey = parseBearerToken(req.header("authorization"));
  if (!rawKey) return { ok: false, status: 401, error: "workflow API key is required" };
  const parsed = parseRawKey(rawKey);
  if (!parsed) return { ok: false, status: 401, error: "invalid workflow API key" };
  const key = getWorkflowApiKey(parsed.keyId);
  // Preserve the workflow verifier's historical handling of trailing hash fields.
  if (!key || !(await verifySecret(parsed.secret, key.keyHash, { allowTrailingFields: true }))) {
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
