import type { ServerResponse } from "node:http";

export type AuditPayload =
  null | boolean | number | string | AuditPayload[] | { [key: string]: AuditPayload };

export interface AuditEvent {
  id: string;
  actorId: string;
  actorRole: "admin" | "operator" | "auditor" | "client";
  source: "control-plane" | "gateway";
  action: string;
  target: string;
  requestId: string;
  outcome: "SUCCEEDED" | "FAILED";
  statusCode: number;
  durationMs: number;
  createdAt: string;
  input: AuditPayload;
  output: AuditPayload;
  context: AuditPayload;
}

const SENSITIVE_NAMES = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "rawkey",
  "keyhash",
  "clientsecret",
  "connectionstring",
  "databaseurl",
  "signature",
  "xamzsignature",
  "xamzcredential",
  "xamzsecuritytoken",
]);
const REDACTED = "[REDACTED]";

function sensitiveName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_NAMES.has(normalized) ||
    /(?:apikey|password|passwd|secret|privatekey|accesskeyid|secretaccesskey)$/.test(normalized)
  );
}

function redactText(value: string, secrets: string[]): string {
  let text = value
    .replace(/\bmcp\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]{20,}\b/g, REDACTED)
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/-]{8,}=*/gi, `Bearer ${REDACTED}`);
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join(REDACTED);
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  try {
    const url = new URL(text);
    let changed = false;
    if (url.username || url.password) {
      url.username = REDACTED;
      url.password = "";
      changed = true;
    }
    for (const name of [...url.searchParams.keys()]) {
      if (sensitiveName(name)) {
        url.searchParams.set(name, REDACTED);
        changed = true;
      }
    }
    return changed ? url.toString() : text;
  } catch {
    return text;
  }
}

export function redactAuditPayload(value: unknown, secrets: Iterable<string> = []): AuditPayload {
  if (value === undefined) return null;
  const secretValues = [...secrets].filter(
    (secret) => typeof secret === "string" && secret.length >= 4,
  );
  const json = JSON.stringify(value, (name, item: unknown) => {
    if (sensitiveName(name) && item !== null) return REDACTED;
    if (name === "environment" && item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).map(([key, value]) => [key, value === null ? null : REDACTED]),
      );
    }
    return typeof item === "string" ? redactText(item, secretValues) : item;
  });
  return json === undefined ? null : (JSON.parse(json) as AuditPayload);
}

/** Capture both Express JSON replies and the SDK's streamed HTTP JSON reply. */
export function captureAuditResponse(response: ServerResponse): () => unknown {
  const chunks: Buffer[] = [];
  const append = (chunk: unknown, encoding: unknown) => {
    if (typeof chunk === "string") {
      chunks.push(
        Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined),
      );
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    }
  };
  const write = response.write;
  const end = response.end;
  response.write = function (this: ServerResponse, ...args: unknown[]) {
    append(args[0], args[1]);
    return Reflect.apply(write, this, args);
  } as typeof response.write;
  response.end = function (this: ServerResponse, ...args: unknown[]) {
    append(args[0], args[1]);
    return Reflect.apply(end, this, args);
  } as typeof response.end;
  return () => {
    if (chunks.length === 0) return null;
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
}
