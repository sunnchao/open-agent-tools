import type { HttpNodeConfig } from "./graph.js";
import { interpolateTemplate, referenceRoot, resolveReference } from "./paths.js";

export const credentialHeader =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|.*(?:api[-_]?key|token|secret))$/i;

function credentialHeaderName(
  config: HttpNodeConfig,
  name: string,
  inputs: Record<string, unknown>,
): boolean {
  try {
    const resolved = interpolateTemplate(name, inputs).toLowerCase();
    if (credentialHeader.test(resolved)) return true;
    return (
      config.authorization?.type === "custom" &&
      resolved === interpolateTemplate(config.authorization.config?.header, inputs).toLowerCase()
    );
  } catch {
    return (
      credentialHeader.test(name) ||
      (config.authorization?.type === "custom" && name === config.authorization.config?.header)
    );
  }
}

export function httpConfigIssues(config: HttpNodeConfig): Array<{ code: string; message: string }> {
  const issues: Array<{ code: string; message: string }> = [];
  const url = config.url?.trim() ?? "";
  if (!url) issues.push({ code: "http-url", message: "请填写 HTTP 请求 URL" });
  else if (!url.includes("{{")) {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error();
    } catch {
      issues.push({ code: "http-url", message: "URL 必须是 HTTP/HTTPS 地址，认证请使用认证配置" });
    }
  }
  const auth = config.authorization;
  const required =
    auth?.type === "basic"
      ? ["username", "password"]
      : auth?.type === "bearer"
        ? ["token"]
        : auth?.type === "custom"
          ? ["header", "value"]
          : [];
  const missingCredential = (key: string) => {
    const text =
      auth?.config?.[key as keyof NonNullable<NonNullable<typeof auth>["config"]>]?.trim();
    if (!text) return true;
    const exact = text.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (!exact) return false;
    const input = config.inputs?.find((input) => input.name === referenceRoot(exact[1]!));
    if (input?.source.type !== "literal") return false;
    try {
      return !String(
        resolveReference(exact[1]!, { [input.name]: input.source.value }) ?? "",
      ).trim();
    } catch {
      return true;
    }
  };
  if (required.some(missingCredential))
    issues.push({ code: "http-auth", message: "请补全 HTTP 认证信息；导入后需重新填写凭据" });
  if (
    !["get", "head"].includes(config.method ?? "get") &&
    config.body?.type === "json" &&
    typeof config.body.data === "string"
  ) {
    try {
      JSON.parse(config.body.data || "{}");
    } catch {
      issues.push({ code: "http-body", message: "HTTP JSON 请求体不是合法 JSON" });
    }
  }
  return issues;
}

/** Portable definitions retain variable references while removing literal credentials. */
export function portableHttpConfig(config: HttpNodeConfig): HttpNodeConfig {
  const auth = config.authorization;
  const literalInputs = Object.fromEntries(
    (config.inputs ?? [])
      .filter((input) => input.source.type === "literal")
      .map((input) => [
        input.name,
        input.source.type === "literal" ? input.source.value : undefined,
      ]),
  );
  const keepTemplate = (value?: string) =>
    value && /^\{\{\s*[^{}]+\s*\}\}$/.test(value) ? value : "";
  const credentialNames = new Set(
    [
      auth?.config?.password,
      auth?.config?.token,
      auth?.config?.value,
      ...(config.headers ?? "")
        .split(/\r?\n/)
        .filter((line) => credentialHeaderName(config, line.split(":")[0]!.trim(), literalInputs))
        .map((line) => line.slice(line.indexOf(":") + 1)),
    ].flatMap((text) =>
      [...(text ?? "").matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) =>
        referenceRoot(match[1]!.trim()),
      ),
    ),
  );
  return {
    ...config,
    ...(config.inputs
      ? {
          inputs: config.inputs.map((input) =>
            credentialNames.has(input.name) && input.source.type === "literal"
              ? { ...input, source: { type: "literal" as const, value: "" } }
              : input,
          ),
        }
      : {}),
    ...(auth
      ? {
          authorization: {
            type: auth.type,
            config: {
              ...(auth.config?.username !== undefined ? { username: auth.config.username } : {}),
              ...(auth.config?.header !== undefined ? { header: auth.config.header } : {}),
              ...(auth.config?.password !== undefined
                ? { password: keepTemplate(auth.config.password) }
                : {}),
              ...(auth.config?.token !== undefined
                ? { token: keepTemplate(auth.config.token) }
                : {}),
              ...(auth.config?.value !== undefined
                ? { value: keepTemplate(auth.config.value) }
                : {}),
            },
          },
        }
      : {}),
    headers: (config.headers ?? "")
      .split(/\r?\n/)
      .filter((line) => {
        const colon = line.indexOf(":");
        return (
          colon < 0 ||
          !credentialHeaderName(config, line.slice(0, colon).trim(), literalInputs) ||
          Boolean(
            keepTemplate(
              line
                .slice(colon + 1)
                .trim()
                .replace(/^(?:Bearer|Basic)\s+/i, ""),
            ),
          )
        );
      })
      .join("\n"),
  };
}

export function httpCredentialValues(
  config: HttpNodeConfig,
  inputs: Record<string, unknown> = {},
): string[] {
  const values: string[] = [];
  for (const value of [
    config.authorization?.config?.password,
    config.authorization?.config?.token,
    config.authorization?.config?.value,
  ]) {
    if (!value) continue;
    try {
      values.push(interpolateTemplate(value, inputs));
    } catch {
      /* Upstream values resolve at execution time. */
    }
  }
  for (const line of (config.headers ?? "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0 || !credentialHeaderName(config, line.slice(0, colon).trim(), inputs)) continue;
    try {
      const value = interpolateTemplate(line.slice(colon + 1).trim(), inputs);
      values.push(value, value.replace(/^(?:Bearer|Basic)\s+/i, ""));
    } catch {
      /* Missing draft inputs are reported by variable validation. */
    }
  }
  return values.filter(Boolean);
}
