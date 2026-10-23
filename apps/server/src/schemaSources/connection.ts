import { safeDecodeUriComponent } from "@open-agent-tools/api-contracts/values";
import type { SchemaSourceConnector } from "./store.js";

export interface SchemaSourceConnectionInput {
  connectionString?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  databaseName?: string | null;
}

function defaultPort(connector: SchemaSourceConnector): number {
  return connector === "postgresql" ? 5432 : 3306;
}

export function schemaSourceConnectionMetadata(
  connectionString: string,
  databaseName?: string | null,
) {
  const parsed = new URL(connectionString);
  const connector = parsed.protocol === "mysql:" ? "mysql" : "postgresql";
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ""),
    port: parsed.port ? Number(parsed.port) : defaultPort(connector),
    username: safeDecodeUriComponent(parsed.username),
    databaseName:
      databaseName?.trim() || safeDecodeUriComponent(parsed.pathname.replace(/^\//, "")) || null,
  };
}

export function buildSchemaSourceConnectionString(
  input: SchemaSourceConnectionInput,
  connector: SchemaSourceConnector,
  current?: string,
): string {
  if (input.connectionString?.trim()) return input.connectionString.trim();
  const hasFields = [input.host, input.port, input.username, input.password].some(
    (value) => value !== undefined,
  );
  if (!hasFields) return current ?? "";

  const parsed = new URL(current ?? `${connector}://localhost`);
  const previous = schemaSourceConnectionMetadata(parsed.toString());
  const host = (input.host ?? previous.host).trim();
  const port = input.port === undefined ? previous.port : input.port;
  const username = (input.username ?? previous.username).trim();
  const databaseName =
    input.databaseName === undefined ? previous.databaseName : input.databaseName?.trim();
  if (!host || /[\s/?#@%\\]/.test(host)) {
    throw new Error("IP / 主机名不能为空，且不能包含协议、路径或账户信息");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口必须为 1 到 65535 之间的整数");
  }
  if (!username) throw new Error("账户不能为空");
  if (!databaseName) throw new Error("数据库名称不能为空");

  const authorityHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let endpoint: URL;
  try {
    endpoint = new URL(`${connector}://${authorityHost}:${port}/`);
  } catch {
    throw new Error("IP / 主机名格式无效，请将端口填入端口字段");
  }
  if (!endpoint.hostname) throw new Error("IP / 主机名格式无效");
  parsed.protocol = `${connector}:`;
  parsed.host = endpoint.host;
  parsed.username = encodeURIComponent(username);
  // A blank password on edit keeps the stored credential and URL options.
  if (input.password !== undefined && input.password !== "") {
    parsed.password = encodeURIComponent(input.password);
  }
  parsed.pathname = `/${encodeURIComponent(databaseName)}`;
  return parsed.toString();
}
