import { request as httpsRequest } from "node:https";
import {
  credentialHeader,
  interpolateTemplate,
  interpolateTemplateValue,
  type HttpNodeConfig,
} from "@open-agent-tools/workflow-contracts";

export const httpResponseLimit = 5 * 1024 * 1024;
const transportHeader = /^(?:host|content-length|connection|transfer-encoding)$/i;

export class HttpStatusError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP request failed (${status})`);
  }
}

function requestUrl(text: string): URL {
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("HTTP URL must use HTTP/HTTPS without embedded credentials");
  const allowlist = process.env.WORKFLOW_HTTP_ALLOWLIST?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist?.length && !allowlist.includes(url.hostname.toLowerCase()))
    throw new Error("HTTP target hostname is not in WORKFLOW_HTTP_ALLOWLIST");
  return url;
}

function headerLines(text: string, inputs: Record<string, unknown>): Headers {
  const headers = new Headers();
  for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("HTTP headers must use one Name:Value per line");
    const name = interpolateTemplate(line.slice(0, colon).trim(), inputs);
    if (transportHeader.test(name))
      throw new Error(`HTTP transport header ${name} cannot be configured`);
    headers.set(name, interpolateTemplate(line.slice(colon + 1).trim(), inputs));
  }
  return headers;
}

export function buildHttpRequest(
  config: HttpNodeConfig,
  inputs: Record<string, unknown>,
): {
  url: URL;
  method: string;
  headers: Headers;
  body: RequestInit["body"];
} {
  const method = (config.method ?? "get").toUpperCase();
  const url = requestUrl(interpolateTemplate(config.url, inputs));
  for (const pair of (config.params ?? "").split(/[\r\n&]+/).filter((part) => part.trim())) {
    const colon = pair.indexOf(":");
    if (colon < 1) throw new Error("HTTP query parameters must use key:value pairs");
    url.searchParams.append(
      interpolateTemplate(pair.slice(0, colon).trim(), inputs),
      interpolateTemplate(pair.slice(colon + 1).trim(), inputs),
    );
  }
  const headers = headerLines(config.headers ?? "", inputs);
  const auth = config.authorization;
  const value = (name: keyof NonNullable<NonNullable<typeof auth>["config"]>) => {
    const resolved = interpolateTemplate(auth?.config?.[name], inputs);
    if (!resolved.trim() || resolved.includes("[REDACTED]"))
      throw new Error("HTTP authentication is missing; re-enter credentials or run upstream nodes");
    return resolved;
  };
  if (auth?.type === "bearer") headers.set("authorization", `Bearer ${value("token")}`);
  if (auth?.type === "basic") {
    const username = value("username");
    if (username.includes(":")) throw new Error("HTTP Basic username cannot contain a colon");
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${username}:${value("password")}`).toString("base64")}`,
    );
  }
  if (auth?.type === "custom") {
    const name = value("header");
    if (transportHeader.test(name))
      throw new Error("HTTP authentication cannot override transport headers");
    headers.set(name, value("value"));
  }
  let body: RequestInit["body"];
  const data = config.body?.data;
  if (!["GET", "HEAD"].includes(method)) {
    if (config.body?.type === "json") {
      const parsed =
        typeof data === "string"
          ? JSON.parse(data || "{}")
          : Object.fromEntries((data ?? []).map((field) => [field.key, field.value]));
      body = JSON.stringify(interpolateTemplateValue(parsed, inputs));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (config.body?.type === "raw") {
      body = interpolateTemplate(
        typeof data === "string" ? data : (data?.[0]?.value ?? ""),
        inputs,
      );
      if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
    } else if (config.body?.type === "form-data") {
      const form = new FormData();
      for (const field of Array.isArray(data) ? data : []) {
        if (field.key)
          form.append(
            interpolateTemplate(field.key, inputs),
            interpolateTemplate(field.value, inputs),
          );
      }
      headers.delete("content-type");
      body = form;
    }
  }
  return { url, method, headers, body };
}

async function readResponse(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > httpResponseLimit) {
    await response.body?.cancel();
    throw new Error("HTTP response exceeds 5 MB");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > httpResponseLimit) throw new Error("HTTP response exceeds 5 MB");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/** Only this explicitly configured request bypasses certificate verification. */
async function selfSignedFetch(url: URL, init: RequestInit): Promise<Response> {
  const encoded = new Request(url, init);
  const body = encoded.body ? Buffer.from(await encoded.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: init.method,
        headers: Object.fromEntries(encoded.headers),
        rejectUnauthorized: false,
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > httpResponseLimit) {
            request.destroy(new Error("HTTP response exceeds 5 MB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, values] of Object.entries(response.headers))
            for (const value of Array.isArray(values) ? values : values ? [values] : [])
              headers.append(name, value);
          const status = response.statusCode ?? 500;
          resolve(
            new Response(
              init.method === "HEAD" || [204, 205, 304].includes(status)
                ? null
                : Buffer.concat(chunks),
              { status, headers },
            ),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

export async function runHttp(
  config: HttpNodeConfig,
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<{ body: unknown; status_code: number; headers: Record<string, string>; size: number }> {
  const built = buildHttpRequest(config, inputs);
  let { url } = built;
  const headers = new Headers(built.headers);
  const customHeader =
    config.authorization?.type === "custom"
      ? interpolateTemplate(config.authorization.config?.header, inputs).toLowerCase()
      : undefined;
  let method = built.method;
  let body = built.body;
  for (let redirects = 0; ; redirects++) {
    const init: RequestInit = { method, headers, body, signal, redirect: "manual" };
    const response =
      config.sslVerify === false && url.protocol === "https:"
        ? await selfSignedFetch(url, init)
        : await fetchFn(url, init);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has("location")) {
      await response.body?.cancel();
      if (redirects >= 5) throw new Error("HTTP request exceeded 5 redirects");
      const next = requestUrl(new URL(response.headers.get("location")!, url).toString());
      if (url.origin !== next.origin) {
        for (const name of [...headers.keys()])
          if (credentialHeader.test(name) || name === customHeader) headers.delete(name);
      }
      if (
        (response.status === 303 && method !== "HEAD") ||
        ([301, 302].includes(response.status) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      url = next;
      continue;
    }
    const bytes = await readResponse(response);
    if (!response.ok) throw new HttpStatusError(response.status);
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown = text;
    if (/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get("content-type") ?? "")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* Invalid JSON remains response text. */
      }
    }
    return {
      body: parsed,
      status_code: response.status,
      headers: Object.fromEntries(response.headers),
      size: bytes.byteLength,
    };
  }
}
