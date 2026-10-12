import { openDb } from "../db.js";
import { decryptConfigSecret, encryptConfigSecret, maskConfigSecret } from "../providers/crypto.js";

const CONFIG_ID = "default";

export interface McpGatewayConfig {
  gatewayUrl: string;
  apiKeyMasked: string | null;
  source: "database" | "environment" | "none";
  configured: boolean;
  updatedAt: string | null;
}

export interface McpGatewayCredentials {
  gatewayUrl: string;
  gatewayApiKey: string;
}

interface McpGatewayRow {
  id: string;
  gateway_url: string;
  api_key_enc: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function envGateway(): { gatewayUrl: string; gatewayApiKey: string } {
  return {
    gatewayUrl: (process.env.MCP_GATEWAY_URL ?? "http://localhost:4100").replace(/\/$/, ""),
    gatewayApiKey: process.env.MCP_GATEWAY_API_KEY?.trim() ?? "",
  };
}

export function normalizeGatewayUrl(value: string): string {
  const gatewayUrl = value.trim().replace(/\/$/, "");
  if (!gatewayUrl) throw new Error("gatewayUrl is required");
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    throw new Error("gatewayUrl must be a valid URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("gatewayUrl must use http or https");
  if (!parsed.hostname) throw new Error("gatewayUrl host is required");
  return gatewayUrl;
}

function row(): McpGatewayRow | undefined {
  return openDb()
    .prepare(
      `SELECT id, gateway_url, api_key_enc, updated_at
       FROM mcp_gateway_config WHERE id = ?`,
    )
    .get(CONFIG_ID) as McpGatewayRow | undefined;
}

export function getMcpGatewayConfig(): McpGatewayConfig {
  const stored = row();
  if (stored) {
    return {
      gatewayUrl: stored.gateway_url,
      apiKeyMasked: maskConfigSecret(decryptConfigSecret(stored.api_key_enc)),
      source: "database",
      configured: true,
      updatedAt: stored.updated_at,
    };
  }
  const env = envGateway();
  return {
    gatewayUrl: env.gatewayUrl,
    apiKeyMasked: maskConfigSecret(env.gatewayApiKey),
    source: env.gatewayApiKey ? "environment" : "none",
    configured: Boolean(env.gatewayApiKey),
    updatedAt: null,
  };
}

export function getMcpGatewayCredentials(): McpGatewayCredentials {
  const stored = row();
  if (stored) {
    return {
      gatewayUrl: stored.gateway_url,
      gatewayApiKey: decryptConfigSecret(stored.api_key_enc),
    };
  }
  const env = envGateway();
  return { gatewayUrl: env.gatewayUrl, gatewayApiKey: env.gatewayApiKey };
}

export function saveMcpGatewayConfig(input: {
  gatewayUrl: string;
  apiKey?: string;
}): McpGatewayConfig {
  const gatewayUrl = normalizeGatewayUrl(input.gatewayUrl);
  const stored = row();
  const apiKey = input.apiKey?.trim() || (stored ? decryptConfigSecret(stored.api_key_enc) : "");
  if (!apiKey) throw new Error("apiKey is required");

  const timestamp = now();
  openDb()
    .prepare(
      `INSERT INTO mcp_gateway_config (id, gateway_url, api_key_enc, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         gateway_url = excluded.gateway_url,
         api_key_enc = excluded.api_key_enc,
         updated_at = excluded.updated_at`,
    )
    .run(CONFIG_ID, gatewayUrl, encryptConfigSecret(apiKey), timestamp);
  return getMcpGatewayConfig();
}

export function clearMcpGatewayConfig(): McpGatewayConfig {
  openDb().prepare(`DELETE FROM mcp_gateway_config WHERE id = ?`).run(CONFIG_ID);
  return getMcpGatewayConfig();
}
